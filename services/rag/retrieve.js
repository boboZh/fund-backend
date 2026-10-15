const pythonRetrieve = require("./pythonRetrieve");

// 10 道有答案、3 道无答案上，重排分在这里分开。比较是 score < minScore。
// 下沿能让无答案题一条都不留；上沿是最弱正确段的分数，再高就会把它丢掉。
// 分数高于上沿的是更强的命中，要留下。默认取下沿，避免把还没见过的正确段滤掉。
const MIN_SCORE_MIN = 0.06;
const MIN_SCORE_MAX = 0.7419;
const DEFAULT_MIN_SCORE = MIN_SCORE_MIN;

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

/**
 * 入参与原来的本地 retrieve() 相同。出参是 Python POST /retrieve 的响应体。
 * 召回、RRF 和重排都在 Python 里做。signal 用来在用户停止时断开这次请求。
 */
// 调用时再取 postRetrieve，测试替换的是模块上的这一跳。
const retrieve = (options) => pythonRetrieve.postRetrieve(options);

module.exports = {
  MIN_SCORE_MIN,
  MIN_SCORE_MAX,
  DEFAULT_MIN_SCORE,
  stockCodeOf,
  keywordTextOf,
  retrieve,
};
