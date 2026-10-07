const { OpenAI } = require("openai");

const BATCH_SIZE = 16;
const RETRIES = 2;

let client;

const embedDim = () => {
  const dim = Number(process.env.EMBED_DIM || 1024);
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`EMBED_DIM 无效: ${process.env.EMBED_DIM}`);
  }
  return dim;
};

const getClient = () => {
  if (client) return client;
  const apiKey = process.env.RAG_API_KEY;
  if (!apiKey) throw new Error("缺少 RAG_API_KEY");
  // 和 DeepSeek 的 AI_API_KEY 分开。欠费或超时能分清是对话还是向量化。
  // maxRetries 关掉，重试次数由下面的循环控制，避免维度错误也被 SDK 再打一遍。
  client = new OpenAI({
    apiKey,
    baseURL: process.env.RAG_BASE_URL || "https://api.siliconflow.cn/v1",
    maxRetries: 0,
  });
  return client;
};

/**
 * 入参是股票名称、小节标题和块原文。出参是送去向量化的文本。
 * MySQL 里的 content 保持原文。向量单独带上「公司｜小节」，这块被取出来时仍然知道讲的是哪家公司的哪一节。
 */
const passageText = ({ stockName, heading, content }) => {
  const title = [stockName, heading]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("｜");
  const body = String(content || "");
  if (!title) return body;
  return `${title}\n${body}`;
};

const dimError = (actual) => {
  const error = new Error(`向量维度是 ${actual}，需要 ${embedDim()}`);
  error.code = "EMBED_DIM";
  return error;
};

const isAbort = (err) =>
  err.name === "AbortError" || err.name === "APIUserAbortError";

const throwIfAborted = (signal) => {
  if (!signal || !signal.aborted) return;
  const error = new Error("embedding 已取消");
  error.name = "AbortError";
  throw error;
};

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("embedding 已取消");
      error.name = "AbortError";
      reject(error);
    };
    if (signal) signal.addEventListener("abort", onAbort);
  });

const vectorsFrom = (response, expected) => {
  const rows = Array.isArray(response && response.data) ? response.data : [];
  if (rows.length !== expected) {
    throw new Error(`Embedding 返回 ${rows.length} 条，请求了 ${expected} 条`);
  }
  const dim = embedDim();
  return rows
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((row) => {
      const vector = row.embedding;
      const actual = Array.isArray(vector) ? vector.length : "空";
      if (actual !== dim) throw dimError(actual);
      return vector;
    });
};

/**
 * 入参是已经准备好的文本，以及可选的 AbortSignal。出参是等长的向量数组。
 * 1. 每批最多 16 条。
 * 2. 请求失败再试 2 次。取消和维度错误不重试。
 * 3. 向量长度必须等于 EMBED_DIM，否则抛错。调用方看到这个错误就不要写入 Qdrant。
 */
const embedTexts = async (texts, { signal } = {}) => {
  const inputs = Array.isArray(texts) ? texts : [];
  const vectors = [];
  for (let offset = 0; offset < inputs.length; offset += BATCH_SIZE) {
    throwIfAborted(signal);
    const batch = inputs.slice(offset, offset + BATCH_SIZE);
    vectors.push(...(await embedBatch(batch, signal)));
  }
  return vectors;
};

const embedBatch = async (batch, signal) => {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      throwIfAborted(signal);
      const response = await getClient().embeddings.create(
        {
          model: process.env.EMBED_MODEL || "BAAI/bge-m3",
          input: batch,
        },
        { signal, maxRetries: 0 }
      );
      return vectorsFrom(response, batch.length);
    } catch (err) {
      if (isAbort(err) || err.code === "EMBED_DIM") throw err;
      lastError = err;
      if (attempt === RETRIES) break;
      await sleep(200 * (attempt + 1), signal);
    }
  }
  throw lastError;
};

/**
 * 入参是切好的块和股票名称。出参是与块一一对应的向量。
 * 原文不改，只在送去向量化的字符串前加上「股票名称｜小节标题」。
 */
const embedChunks = async (chunks, { stockName, signal } = {}) => {
  const texts = (chunks || []).map((chunk) =>
    passageText({
      stockName,
      heading: chunk.heading,
      content: chunk.content,
    })
  );
  return embedTexts(texts, { signal });
};

/**
 * 入参是用户问题。出参是一条向量。
 * bge-m3 不用 query: 前缀，问题原样送进去。
 */
const embedQuery = async (query, { signal } = {}) => {
  const text = String(query ?? "");
  if (!text.trim()) throw new Error("问题不能为空");
  const [vector] = await embedTexts([text], { signal });
  return vector;
};

module.exports = {
  passageText,
  embedTexts,
  embedChunks,
  embedQuery,
};
