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

module.exports = {
  COLLECTION,
  getClient,
  ensureCollection,
};
