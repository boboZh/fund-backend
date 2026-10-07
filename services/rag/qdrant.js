const { QdrantClient } = require("@qdrant/js-client-rest");

const COLLECTION = "research_chunks";

// 这些字段会在搜索时和向量一起过滤。user_id 是每次查询的必需条件，所有用户的研报在同一个 collection 里。
// report_date 用整数（20261005）而不是日期字符串，范围过滤才能直接比较。
const PAYLOAD_INDEXES = [
  ["user_id", "integer"],
  ["doc_id", "integer"],
  ["stock_code", "keyword"],
  ["report_date", "integer"],
];

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
  client = new QdrantClient({
    url: process.env.QDRANT_URL || "http://127.0.0.1:6333",
  });
  return client;
};

const vectorParamsOf = (info) => {
  const vectors =
    info.config && info.config.params && info.config.params.vectors;
  if (!vectors || typeof vectors.size !== "number") return null;
  return { size: vectors.size, distance: vectors.distance };
};

const ensurePayloadIndexes = async (qdrant) => {
  const info = await qdrant.getCollection(COLLECTION);
  const schema = info.payload_schema || {};
  for (const [fieldName, fieldSchema] of PAYLOAD_INDEXES) {
    const current = schema[fieldName];
    if (current && current.data_type === fieldSchema) continue;
    if (current) {
      throw new Error(
        `Qdrant 字段 ${fieldName} 的索引类型是 ${current.data_type}，需要 ${fieldSchema}`
      );
    }
    await qdrant.createPayloadIndex(COLLECTION, {
      field_name: fieldName,
      field_schema: fieldSchema,
      wait: true, // 表示这次请求要等 Qdrant 把索引真正建完再返回，而不是收到请求就立刻返回。
    });
  }
};

/**
 * Qdrant 不可达或向量配置对不上时抛错。
 * 1. collection 不存在则按 EMBED_DIM、Cosine 创建。
 * 2. 已存在则核对维度和距离，不一致直接失败，避免把向量写进错误的空间。
 * 3. 补齐还没有的 payload 索引。
 */
const ensureCollection = async () => {
  const qdrant = getClient();
  const dim = embedDim();
  const { exists } = await qdrant.collectionExists(COLLECTION);
  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: dim, distance: "Cosine" },
    });
  } else {
    const info = await qdrant.getCollection(COLLECTION);
    const vectors = vectorParamsOf(info);
    const actual = vectors ? `${vectors.size}/${vectors.distance}` : "未知";
    if (!vectors || vectors.size !== dim || vectors.distance !== "Cosine") {
      throw new Error(
        `collection ${COLLECTION} 的向量配置是 ${actual}，需要 ${dim}/Cosine`
      );
    }
  }
  await ensurePayloadIndexes(qdrant);
  console.log(`Qdrant collection ${COLLECTION} 已就绪`);
};

// 范围过滤用整数比较。2026-10-05 写成 20261005，才能表达「这天之后」。
const reportDateNumber = (value) => {
  const digits = String(value || "").replace(/-/g, "");
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`报告日期无法写入向量库: ${value}`);
  }
  return Number(digits);
};

/**
 * 入参是研报和一块已经有 MySQL id 的切块。出参是 Qdrant payload。
 * 只放过滤和展示用的短字段。正文留在 MySQL，避免同一段话存两份。
 */
const payloadOf = (doc, chunk) => ({
  user_id: Number(doc.userId),
  doc_id: Number(doc.id),
  stock_code: doc.stockCode,
  stock_name: doc.stockName,
  title: doc.title,
  org: doc.org,
  report_date: reportDateNumber(doc.reportDate),
  page_start: chunk.pageStart ?? null,
  heading: chunk.heading || null,
  chunk_type: chunk.chunkType,
});

/**
 * 入参是研报、带自增 id 的切块，以及等长的向量。成功时无返回值。
 * 维度或条数对不上就抛错，不会 upsert。point id 用 research_chunks.id。
 */
const upsertChunks = async (doc, chunks, vectors) => {
  if (chunks.length !== vectors.length) {
    throw new Error(`向量条数 ${vectors.length} 和切块 ${chunks.length} 不一致`);
  }
  const dim = embedDim();
  const points = chunks.map((chunk, index) => {
    const vector = vectors[index];
    const actual = Array.isArray(vector) ? vector.length : "空";
    if (actual !== dim) throw new Error(`向量维度是 ${actual}，需要 ${dim}`);
    if (!Number.isInteger(Number(chunk.id)) || Number(chunk.id) <= 0) {
      throw new Error("切块缺少 MySQL 自增 id，不能写入 Qdrant");
    }
    return {
      id: Number(chunk.id),
      vector,
      payload: payloadOf(doc, chunk),
    };
  });
  if (!points.length) return;
  await getClient().upsert(COLLECTION, { wait: true, points });
};

// 按文档删点。重切会换成新的自增 id，不先删掉的话，旧 point 会留在库里。
const deleteByDoc = async (docId, userId) => {
  const must = [{ key: "doc_id", match: { value: Number(docId) } }];
  if (userId != null) {
    must.push({ key: "user_id", match: { value: Number(userId) } });
  }
  await getClient().delete(COLLECTION, { wait: true, filter: { must } });
};

module.exports = {
  COLLECTION,
  getClient,
  ensureCollection,
  payloadOf,
  upsertChunks,
  deleteByDoc,
};
