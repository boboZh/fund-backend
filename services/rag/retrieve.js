const { embedQuery } = require("./embed");
const { rerankPassages } = require("./rerank");
const { COLLECTION, getClient } = require("./qdrant");
const store = require("./store");

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
// 10 道有答案、3 道无答案上，重排分在这里分开。比较是 score < minScore。
// 下沿能让无答案题一条都不留；上沿是最弱正确段的分数，再高就会把它丢掉。
// 分数高于上沿的是更强的命中，要留下。默认取下沿，避免把还没见过的正确段滤掉。
const MIN_SCORE_MIN = 0.06;
const MIN_SCORE_MAX = 0.7419;
const DEFAULT_MIN_SCORE = MIN_SCORE_MIN;
// 混合检索先放宽召回，再按名次合并后截断。最终送出的条数仍然是 topK。
const RECALL_LIMIT = 20;
// RRF 的平滑常数。相邻名次的分数靠近，合并结果由两路名次一起决定。
const RRF_K = 60;
const MODES = new Set(["vector", "keyword", "hybrid"]);

// 六位数字前后不能再挨着数字，避免把 16002567 这种更长的数切成股票代码。
const STOCK_CODE_RE = /(?<!\d)(\d{6})(?!\d)/g;

/**
 * 入参是用户问题。出参是唯一的六位代码；没有或不止一个时返回 null。
 * 不止一个时无法确定是哪家公司，不加 stock_code，免得把另一家的段落滤掉。
 */
const stockCodeOf = (query) => {
  const found = new Set(String(query || "").match(STOCK_CODE_RE) || []);
  if (found.size !== 1) return null;
  return [...found][0];
};

/**
 * 入参是问题和已经用来过滤的股票代码。出参是送给全文索引的文本。
 * 正文里很少重复写代码。ngram_token_size=2 会把 600256 切成 60、00、02，这些片段在每份研报里都有，只会把无关段落顶上来。
 * 代码已经拿去过滤 doc_id 了，全文查询里不必再留着它。这里连同只包着代码的空括号一起拿掉。
 */
const keywordTextOf = (query, stockCode) => {
  const original = String(query || "");
  if (!stockCode) return original.trim();
  let text = original.replace(
    new RegExp(`(?<!\\d)${stockCode}(?!\\d)`, "g"),
    " "
  );
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/[（(【\[]\s*[）)】\]]/g, " ");
  }
  return text.replace(/\s+/g, " ").trim();
};

// 少于两个字组不出 ngram，全文检索没有结果。
const hasKeywordText = (text) =>
  (String(text || "").match(/[\p{L}\p{N}]/gu) || []).length >= 2;

const topKOf = (value) => {
  if (value == null || value === "") return DEFAULT_TOP_K;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TOP_K;
  return Math.min(MAX_TOP_K, Math.max(1, Math.round(parsed)));
};

const filterStockCode = (query, stockCode) => {
  if (stockCode == null || String(stockCode).trim() === "")
    return stockCodeOf(query);
  const code = String(stockCode).trim();
  if (!/^\d{6}$/.test(code)) throw new Error("股票代码需要是 6 位数字");
  return code;
};

const scoreOf = (value) => {
  const score = Number(value);
  return Number.isFinite(score) ? score : 0;
};

// 空字符串表示不限日期。非法日期直接拒绝，避免静默放宽成「全部研报」。
const dateFromOf = (value) => {
  if (value == null || String(value).trim() === "") return null;
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error("起始日期需要是 YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("起始日期需要是 YYYY-MM-DD");
  }
  return text;
};

// 空字符串表示这次不设阈值。0 是合法阈值，重排分低于 0 的段落会被丢掉。
const minScoreOf = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("阈值需要是数字");
  return parsed;
};

const throwIfAborted = (signal) => {
  if (!signal || !signal.aborted) return;
  const error = new Error("检索已取消");
  error.name = "AbortError";
  throw error;
};

const chunkHit = (row, fields) => ({
  rank: fields.rank,
  score: fields.score,
  vectorRank: fields.vectorRank ?? null,
  vectorScore: fields.vectorScore ?? null,
  keywordRank: fields.keywordRank ?? null,
  keywordScore: fields.keywordScore ?? null,
  rrfRank: fields.rrfRank ?? null,
  rrfScore: fields.rrfScore ?? null,
  rerankRank: fields.rerankRank ?? null,
  rerankScore: fields.rerankScore ?? null,
  dropped: Boolean(fields.dropped),
  id: row.id,
  docId: row.docId,
  chunkType: row.chunkType,
  pageStart: row.pageStart,
  pageEnd: row.pageEnd,
  heading: row.heading,
  content: row.content,
  stockCode: row.stockCode,
  stockName: row.stockName,
  title: row.title,
  org: row.org,
  reportDate: row.reportDate,
});

/**
 * 向量检索（Qdrant）
 * 入参是问题、用户、股票代码、条数和 AbortSignal。出参按余弦相似度排列，原文来自 MySQL。
 * Qdrant 里有、MySQL 里已经没有的点丢掉，名次在剩下的结果里重新排。
 */
const vectorRecall = async ({
  query,
  ownerId,
  stockCode,
  dateFrom,
  limit,
  signal,
}) => {
  const vector = await embedQuery(query, { signal });
  throwIfAborted(signal);

  const must = [{ key: "user_id", match: { value: ownerId } }];
  if (stockCode) must.push({ key: "stock_code", match: { value: stockCode } });
  // 和股票代码一样，日期要在搜索时过滤。先取全局 top-k 再丢掉旧研报，正确公司的新段落可能根本没进候选。
  if (dateFrom) {
    must.push({
      key: "report_date",
      range: { gte: Number(dateFrom.replace(/-/g, "")) },
    });
  }

  const result = await getClient().query(COLLECTION, {
    query: vector,
    limit,
    filter: { must },
    with_payload: false, //with_payload: false 表示返回的每条结果只留 point id 和余弦分，不附带filter里 stock_name、title、heading 这些字段
  });

  const points = Array.isArray(result && result.points) ? result.points : [];
  const rows = await store.listChunksByIds(
    ownerId,
    points.map((point) => point.id)
  );
  const byId = new Map(rows.map((row) => [Number(row.id), row]));

  const hits = [];
  points.forEach((point) => {
    const row = byId.get(Number(point.id));
    if (!row) return;
    const rank = hits.length + 1;
    const score = scoreOf(point.score);
    hits.push(
      chunkHit(row, {
        rank,
        score,
        vectorRank: rank,
        vectorScore: score,
      })
    );
  });
  return hits;
};

/**
 * 关键字检索（mysql）
 * 入参是问题、用户、股票代码、起始日期和条数。出参是全文命中，以及实际送进全文索引的文本。
 * 过滤用的股票代码先从问题里拿掉；拿掉后组不出词，就不再查全文。有起始日期时，只查这一天及之后的文档。
 */
const keywordRecall = async ({
  query,
  ownerId,
  stockCode,
  dateFrom,
  limit,
}) => {
  const text = keywordTextOf(query, stockCode);
  if (!hasKeywordText(text)) return { text, hits: [] };
  const rows = await store.searchChunksByKeyword(ownerId, {
    text,
    stockCode,
    dateFrom,
    limit,
  });
  const hits = rows.map((row, index) => {
    const rank = index + 1;
    const score = scoreOf(row.score);
    return chunkHit(row, {
      rank,
      score,
      keywordRank: rank,
      keywordScore: score,
    });
  });
  return { text, hits };
};

/**
 * 混合检索 RRF
 * 入参是两路各自按名次排好的命中。出参按融合分从高到低，还没按 topK 截断。
 * 融合分 = 1/(60+向量名次) + 1/(60+关键词名次)。某一路没有这条，那一路不加分。
 * 只累加名次。余弦分和全文分不在一个量纲上。分数相同时按 chunk id 排，同一条问题重复检索名次不变。
 */
const fuseByRank = (vectorHits, keywordHits) => {
  const byId = new Map();
  const take = (hit, source) => {
    const id = Number(hit.id);
    let item = byId.get(id);
    if (!item) {
      item = {
        row: hit,
        vectorRank: null,
        vectorScore: null,
        keywordRank: null,
        keywordScore: null,
      };
      byId.set(id, item);
    }
    if (source === "vector") {
      item.vectorRank = hit.vectorRank;
      item.vectorScore = hit.vectorScore;
    } else {
      item.keywordRank = hit.keywordRank;
      item.keywordScore = hit.keywordScore;
    }
  };
  vectorHits.forEach((hit) => take(hit, "vector"));
  keywordHits.forEach((hit) => take(hit, "keyword"));

  return [...byId.values()]
    .map((item) => {
      let score = 0;
      if (item.vectorRank != null) score += 1 / (RRF_K + item.vectorRank);
      if (item.keywordRank != null) score += 1 / (RRF_K + item.keywordRank);
      return { item, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.item.row.id - right.item.row.id
    );
};

const hybridHitsOf = (fused) =>
  fused.map(({ item, score }, index) =>
    chunkHit(item.row, {
      rank: index + 1,
      score,
      vectorRank: item.vectorRank,
      vectorScore: item.vectorScore,
      keywordRank: item.keywordRank,
      keywordScore: item.keywordScore,
      rrfRank: index + 1,
      rrfScore: score,
    })
  );

/**
 * 重排
 * 入参是已经召回的候选、问题、topK、阈值和 AbortSignal。
 * 出参的 ranked 按重排分排列，低于阈值的标 dropped，实验台仍显示这些行。
 * hits 是去掉 dropped 之后的前 topK 条。
 * 阈值只和重排分比较。余弦分、全文分、融合分不在这个量纲上。
 */
const rerankHits = async ({ query, hits, topK, minScore, signal }) => {
  if (!hits.length) return { hits: [], ranked: [] };
  throwIfAborted(signal);
  const scored = await rerankPassages(
    query,
    hits.map((hit) => hit.content),
    { signal }
  );
  const scoreByIndex = new Map(scored.map((item) => [item.index, item.score]));
  const ordered = hits
    .map((hit, index) => ({
      hit,
      score: scoreByIndex.has(index) ? scoreByIndex.get(index) : null,
    }))
    .sort((left, right) => {
      if (left.score == null && right.score == null)
        return left.hit.id - right.hit.id;
      if (left.score == null) return 1;
      if (right.score == null) return -1;
      return right.score - left.score || left.hit.id - right.hit.id;
    });
  const ranked = ordered.map((item, index) => {
    const dropped =
      minScore != null && (item.score == null || item.score < minScore);
    return chunkHit(item.hit, {
      rank: index + 1,
      score: item.score == null ? 0 : item.score,
      vectorRank: item.hit.vectorRank,
      vectorScore: item.hit.vectorScore,
      keywordRank: item.hit.keywordRank,
      keywordScore: item.hit.keywordScore,
      rrfRank: item.hit.rrfRank,
      rrfScore: item.hit.rrfScore,
      rerankRank: index + 1,
      rerankScore: item.score,
      dropped,
    });
  });
  return {
    ranked,
    hits: ranked.filter((hit) => !hit.dropped).slice(0, topK),
  };
};

/**
 * 入参是问题、当前用户、topK、mode（vector / keyword / hybrid）、是否重排、阈值、可选的股票代码和 AbortSignal。
 * 显式传入的六位代码优先于从问题里识别出来的代码。出参是按该模式排好的片段，原文来自 MySQL。
 * 1. 解析过滤用的股票代码和起始日期。向量按 payload 过滤，关键词按文档过滤。带了 dateFrom 就只留这一天及之后的研报。
 * 2. vector、keyword 各按自己的分取 topK。hybrid 两路各先取 20 条，RRF 合并后再截成 topK。
 * 3. 打开重排时，召回放宽到 20 条。hybrid 取融合后的前 20 条，和问题一起重排，再取 topK。
 * 4. 重排分低于阈值的标 dropped，不放进 hits。ranked 仍保留这些行，实验台用来置灰。
 */
const retrieve = async ({
  query,
  userId,
  topK,
  mode = "vector",
  rerank = false,
  minScore,
  stockCode,
  dateFrom,
  signal,
} = {}) => {
  if (!MODES.has(mode))
    throw new Error(`检索模式只能是 vector、keyword、hybrid，收到 ${mode}`);
  const ownerId = Number(userId);
  if (!Number.isInteger(ownerId) || ownerId <= 0)
    throw new Error("缺少 user_id");
  throwIfAborted(signal);

  const limit = topKOf(topK);
  const code = filterStockCode(query, stockCode);
  const since = dateFromOf(dateFrom);
  const threshold = minScoreOf(minScore);
  const rerankOn = Boolean(rerank);
  // 重排要看到名次靠后的正确段，所以召回先取 20 条，而不是直接取 topK。
  const recallLimit = mode === "hybrid" || rerankOn ? RECALL_LIMIT : limit;

  let vectorHits = [];
  let keywordHits = [];
  let keywordQuery = null;

  if (mode === "vector" || mode === "hybrid") {
    vectorHits = await vectorRecall({
      query,
      ownerId,
      stockCode: code,
      dateFrom: since,
      limit: recallLimit,
      signal,
    });
  }
  if (mode === "keyword" || mode === "hybrid") {
    throwIfAborted(signal);
    const keyword = await keywordRecall({
      query,
      ownerId,
      stockCode: code,
      dateFrom: since,
      limit: recallLimit,
    });
    keywordHits = keyword.hits;
    keywordQuery = keyword.text;
  }

  const pool =
    mode === "hybrid"
      ? hybridHitsOf(fuseByRank(vectorHits, keywordHits)).slice(
          0,
          rerankOn ? RECALL_LIMIT : limit
        )
      : mode === "vector"
        ? vectorHits
        : keywordHits;

  if (rerankOn) {
    const reranked = await rerankHits({
      query,
      hits: pool,
      topK: limit,
      minScore: threshold,
      signal,
    });
    return {
      mode,
      topK: limit,
      stockCode: code,
      keywordQuery,
      rerank: true,
      minScore: threshold,
      hits: reranked.hits,
      ranked: reranked.ranked,
    };
  }

  return {
    mode,
    topK: limit,
    stockCode: code,
    keywordQuery,
    rerank: false,
    minScore: null,
    hits: pool,
    ranked: null,
  };
};

module.exports = {
  MIN_SCORE_MIN,
  MIN_SCORE_MAX,
  DEFAULT_MIN_SCORE,
  stockCodeOf,
  keywordTextOf,
  retrieve,
};
