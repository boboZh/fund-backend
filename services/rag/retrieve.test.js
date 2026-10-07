const mockEmbedQuery = jest.fn();
const mockQuery = jest.fn();

jest.mock("./embed", () => ({
  embedQuery: (...args) => mockEmbedQuery(...args),
}));

jest.mock("./qdrant", () => ({
  COLLECTION: "research_chunks",
  getClient: () => ({ query: (...args) => mockQuery(...args) }),
}));

jest.mock("./store", () => ({
  listChunksByIds: jest.fn(),
}));

const store = require("./store");
const { stockCodeOf, retrieve } = require("./retrieve");

const row = (id, content) => ({
  id,
  docId: 3,
  chunkType: "text",
  pageStart: 7,
  pageEnd: 7,
  heading: "盈利预测与估值",
  content,
  stockCode: "600256",
  stockName: "广汇能源",
  title: "深度报告",
  org: "开源证券",
  reportDate: "2026-10-05",
});

beforeEach(() => {
  mockEmbedQuery.mockReset();
  mockQuery.mockReset();
  store.listChunksByIds.mockReset();
  mockEmbedQuery.mockResolvedValue([0.1, 0.2]);
});

describe("从问题里取股票代码", () => {
  test("括号里的六位代码可以取出", () => {
    expect(stockCodeOf("广汇能源（600256）的产能怎么看")).toBe("600256");
  });

  test("没有代码，或同时出现两家，就不限定股票", () => {
    expect(stockCodeOf("往后产量靠什么上去")).toBeNull();
    expect(stockCodeOf("比较 600256 和 000001")).toBeNull();
  });

  test("更长的数字不会被切成六位代码", () => {
    expect(stockCodeOf("编号 16002567")).toBeNull();
  });
});

describe("向量检索", () => {
  test("同一次查询里始终带 user_id，有唯一代码时再加 stock_code", async () => {
    mockQuery.mockResolvedValue({ points: [] });
    store.listChunksByIds.mockResolvedValue([]);

    await retrieve({ query: "600256 的目标价", userId: 8, topK: 3 });

    expect(mockEmbedQuery).toHaveBeenCalledWith("600256 的目标价", { signal: undefined });
    expect(mockQuery).toHaveBeenCalledWith("research_chunks", {
      query: [0.1, 0.2],
      limit: 3,
      filter: {
        must: [
          { key: "user_id", match: { value: 8 } },
          { key: "stock_code", match: { value: "600256" } },
        ],
      },
      with_payload: false,
    });
  });

  test("没有代码时只按用户过滤，topK 默认 5", async () => {
    mockQuery.mockResolvedValue({ points: [] });
    store.listChunksByIds.mockResolvedValue([]);

    const result = await retrieve({ query: "产能怎么上去", userId: 8 });

    expect(mockQuery.mock.calls[0][1].limit).toBe(5);
    expect(mockQuery.mock.calls[0][1].filter.must).toEqual([
      { key: "user_id", match: { value: 8 } },
    ]);
    expect(result.stockCode).toBeNull();
  });

  test("按 Qdrant 的顺序回 MySQL 取原文，并带上余弦分", async () => {
    mockQuery.mockResolvedValue({
      points: [
        { id: 9, score: 0.91 },
        { id: 4, score: 0.72 },
        { id: 15, score: 0.4 },
      ],
    });
    store.listChunksByIds.mockResolvedValue([row(4, "第二段"), row(9, "第一段")]);

    const result = await retrieve({ query: "目标价", userId: 8, topK: 5 });

    expect(store.listChunksByIds).toHaveBeenCalledWith(8, [9, 4, 15]);
    expect(result.hits.map((hit) => [hit.rank, hit.id, hit.score, hit.content])).toEqual([
      [1, 9, 0.91, "第一段"],
      [2, 4, 0.72, "第二段"],
    ]);
  });

  test("其他模式先不实现", async () => {
    await expect(retrieve({ query: "目标价", userId: 8, mode: "keyword" })).rejects.toThrow(
      "这一期只支持向量检索"
    );
    expect(mockEmbedQuery).not.toHaveBeenCalled();
  });
});
