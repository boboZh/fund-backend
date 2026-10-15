const axios = require("axios");

const retrieveUrl = () =>
  process.env.RAG_RETRIEVE_URL || "http://127.0.0.1:9001/retrieve";

const isAbort = (err) =>
  err.name === "AbortError" ||
  err.name === "CanceledError" ||
  err.code === "ERR_CANCELED";

const messageOf = (err) => {
  if (err.response && err.response.status === 499) return "检索已取消";
  const detail = err.response && err.response.data && err.response.data.detail;
  if (typeof detail === "string" && detail) return detail;
  if (err.code === "ECONNREFUSED") return "Python 检索服务没有启动";
  if (err.code === "ECONNABORTED") return "Python 检索超时";
  return err.message || "调用 Python 检索失败";
};

/**
 * 入参与 retrieve() 相同：问题、用户、topK、模式、是否重排、阈值、股票代码、起始日期、AbortSignal。
 * 出参是 Python POST /retrieve 的响应体，字段与原来的 retrieve() 相同。
 * 向量和重排各最多请求 3 次，单次 60 秒，所以这里留 6 分钟。取消信号原样交给 axios，连接断开后 Python 不再重试。
 */
const postRetrieve = async ({
  query,
  userId,
  topK,
  mode,
  rerank,
  minScore,
  stockCode,
  dateFrom,
  signal,
} = {}) => {
  const body = { query, userId };
  if (topK != null && topK !== "") body.topK = topK;
  if (mode != null && mode !== "") body.mode = mode;
  if (typeof rerank === "boolean") body.rerank = rerank;
  if (minScore != null && minScore !== "") body.minScore = minScore;
  if (stockCode != null) body.stockCode = stockCode;
  if (dateFrom != null && dateFrom !== "") body.dateFrom = dateFrom;

  try {
    const response = await axios.post(retrieveUrl(), body, {
      timeout: 6 * 60 * 1000,
      signal,
    });
    return response.data;
  } catch (err) {
    if (isAbort(err)) {
      // 对话路由只把 name 为 AbortError 的异常当成用户停止，避免记成检索失败。
      const abortError = new Error("检索已取消");
      abortError.name = "AbortError";
      abortError.code = "ERR_CANCELED";
      throw abortError;
    }
    throw new Error(messageOf(err));
  }
};

module.exports = {
  postRetrieve,
  retrieveUrl,
};
