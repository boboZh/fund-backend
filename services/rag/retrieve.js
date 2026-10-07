const { embedQuery } = require("./embed");
const { COLLECTION, getClient } = require("./qdrant");
const store = require("./store");

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

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

const topKOf = (value) => {
  if (value == null || value === "") return DEFAULT_TOP_K;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TOP_K;
  return Math.min(MAX_TOP_K, Math.max(1, Math.round(parsed)));
};

const throwIfAborted = (signal) => {
  if (!signal || !signal.aborted) return;
  const error = new Error("检索已取消");
  error.name = "AbortError";
  throw error;
};

/**
 * 入参是问题、当前用户、topK、mode 和可选的 AbortSignal。
 * 出参是按余弦相似度排好的片段，原文来自 MySQL。
 * 这一期只做 mode = "vector"：
 * 1. 问题原样向量化。
 * 2. 同一次 Query 里带上 user_id，能确定股票代码时再加 stock_code，并按相似度取 topK。
 * 3. 用 point id 回 MySQL 取正文，带上余弦分。Qdrant 里有、MySQL 里已经没有的点丢掉。
 */
const retrieve = async ({ query, userId, topK, mode = "vector", signal } = {}) => {
  if (mode !== "vector") throw new Error(`这一期只支持向量检索，收到 ${mode}`);
  const ownerId = Number(userId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) throw new Error("缺少 user_id");

  const limit = topKOf(topK);
  const stockCode = stockCodeOf(query);
  const vector = await embedQuery(query, { signal });
  throwIfAborted(signal);

  const must = [{ key: "user_id", match: { value: ownerId } }];
  if (stockCode) must.push({ key: "stock_code", match: { value: stockCode } });

  const result = await getClient().query(COLLECTION, {
    query: vector,
    limit,
    filter: { must },
    with_payload: false,
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
    hits.push({
      rank: hits.length + 1,
      score: point.score,
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
  });

  return { mode: "vector", topK: limit, stockCode, hits };
};

module.exports = {
  stockCodeOf,
  retrieve,
};
