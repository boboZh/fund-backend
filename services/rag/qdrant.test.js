const { payloadOf, upsertChunks } = require("./qdrant");

const doc = {
  id: 3,
  userId: 1,
  stockCode: "600256",
  stockName: "广汇能源",
  title: "深度报告",
  org: "开源证券",
  reportDate: "2026-10-05",
};

const chunk = {
  id: 9,
  pageStart: 7,
  heading: "盈利预测与估值",
  chunkType: "text",
  content: "目标价 12.5 元。",
};

describe("Qdrant payload", () => {
  test("只放过滤和展示字段，正文不进向量库", () => {
    expect(payloadOf(doc, chunk)).toEqual({
      user_id: 1,
      doc_id: 3,
      stock_code: "600256",
      stock_name: "广汇能源",
      title: "深度报告",
      org: "开源证券",
      report_date: 20261005,
      page_start: 7,
      heading: "盈利预测与估值",
      chunk_type: "text",
    });
  });

  test("维度不对时不调用 Qdrant", async () => {
    process.env.EMBED_DIM = "4";
    await expect(upsertChunks(doc, [chunk], [[0.1, 0.2, 0.3]])).rejects.toThrow(
      "向量维度是 3，需要 4"
    );
  });
});
