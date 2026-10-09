const axios = require("axios");

const RETRIES = 2;

const isAbort = (err) =>
  err.name === "AbortError" || err.code === "ERR_CANCELED";

const throwIfAborted = (signal) => {
  if (!signal || !signal.aborted) return;
  const error = new Error("重排已取消");
  error.name = "AbortError";
  throw error;
};

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort); //时间到了之后去掉 abort 监听，是让这次等待和后面的请求脱钩。监听留着的话，用户若在随后的重排请求里点了停止，这个已经结束的 sleep 仍会再跑一遍 onAbort。Promise 已经 resolve 过，再 reject 不会改变结果，但回调和它带上的计时器会一直挂在这个 signal 上，直到整次检索结束。
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("重排已取消");
      error.name = "AbortError";
      reject(error);
    };
    if (signal) signal.addEventListener("abort", onAbort);
  });

const shouldRetry = (err) => {
  if (isAbort(err)) return false;
  const status = err.response && err.response.status;
  if (status && status >= 400 && status < 500 && status !== 429) return false;
  return true;
};

const messageOf = (err) => {
  const data = err.response && err.response.data;
  if (data && data.message) return String(data.message);
  return err.message || "重排失败";
};

/**
 * 入参是问题和候选正文。出参是每条正文的下标和重排分。
 * 重排模型把问题和这一段放在同一次打分里，比事先各自编码再比余弦准，所以只拿召回留下的少量候选来跑。
 * 失败再试 2 次。取消和参数错误不重试。
 */
const rerankPassages = async (query, documents, { signal } = {}) => {
  const docs = (documents || []).map((doc) => String(doc ?? ""));
  if (!docs.length) return [];
  const apiKey = process.env.RAG_API_KEY;
  if (!apiKey) throw new Error("缺少 RAG_API_KEY");
  const base = String(
    process.env.RAG_BASE_URL || "https://api.siliconflow.cn/v1"
  ).replace(/\/$/, "");

  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      throwIfAborted(signal);
      const response = await axios.post(
        `${base}/rerank`,
        {
          model: process.env.RERANK_MODEL || "BAAI/bge-reranker-v2-m3",
          query: String(query ?? ""),
          documents: docs,
          top_n: docs.length,
          return_documents: false,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
          timeout: 60000,
        }
      );
      const results = response.data && response.data.results;
      if (!Array.isArray(results) || !results.length) {
        throw new Error("重排没有返回分数");
      }
      return results
        .map((row) => ({
          index: Number(row.index),
          score: Number(row.relevance_score ?? row.score),
        }))
        .filter(
          (row) => Number.isInteger(row.index) && Number.isFinite(row.score)
        );
    } catch (err) {
      if (isAbort(err)) throw err;
      lastError = err;
      if (!shouldRetry(err) || attempt === RETRIES) break;
      await sleep(200 * (attempt + 1), signal);
    }
  }
  const error = new Error(messageOf(lastError));
  error.name = lastError.name;
  throw error;
};

module.exports = {
  rerankPassages,
};
