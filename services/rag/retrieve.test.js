const mockEmbedQuery = jest.fn();
const mockQuery = jest.fn();

jest.mock("./embed", () => ({
  embedQuery: (...args) => mockEmbedQuery(...args),
}));

jest.mock("./qdrant", () => ({
  COLLECTION: "research_chunks",
  getClient: () => ({ query: (...args) => mockQuery(...args) }),
}));

const mockRerankPassages = jest.fn();

jest.mock("./store", () => ({
  listChunksByIds: jest.fn(),
  searchChunksByKeyword: jest.fn(),
}));

jest.mock("./rerank", () => ({
  rerankPassages: (...args) => mockRerankPassages(...args),
}));

const store = require("./store");
const { stockCodeOf, keywordTextOf, retrieve } = require("./retrieve");

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
  store.searchChunksByKeyword.mockReset();
  mockRerankPassages.mockReset();
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

describe("关键词检索前去掉已经用来过滤的股票代码", () => {
  test("括号里的代码会连同空括号一起拿掉", () => {
    expect(keywordTextOf("广汇能源（600256）的产能怎么看", "600256")).toBe("广汇能源 的产能怎么看");
    expect(keywordTextOf("广汇能源(600256)产能", "600256")).toBe("广汇能源 产能");
  });

  test("没有形成过滤条件时，代码留在问题里", () => {
    expect(keywordTextOf("比较 600256 和 000001", null)).toBe("比较 600256 和 000001");
  });

  test("只剩代码时，关键词查询为空", () => {
    expect(keywordTextOf("（600256）", "600256")).toBe("");
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
    expect(result.keywordQuery).toBeNull();
    expect(store.searchChunksByKeyword).not.toHaveBeenCalled();
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

  test("不认识的模式直接拒绝", async () => {
    await expect(retrieve({ query: "目标价", userId: 8, mode: "rerank" })).rejects.toThrow(
      "检索模式只能是"
    );
    expect(mockEmbedQuery).not.toHaveBeenCalled();
  });
});

describe("关键词检索", () => {
  test("按全文分排，并带上关键词名次", async () => {
    store.searchChunksByKeyword.mockResolvedValue([
      { ...row(9, "第一段"), score: "1.50" },
      { ...row(4, "第二段"), score: 0.2 },
    ]);

    const result = await retrieve({ query: "增持", userId: 8, mode: "keyword", topK: 4 });

    expect(mockEmbedQuery).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(store.searchChunksByKeyword).toHaveBeenCalledWith(8, {
      text: "增持",
      stockCode: null,
      limit: 4,
    });
    expect(result.hits.map((hit) => [hit.rank, hit.id, hit.score, hit.keywordRank, hit.vectorRank])).toEqual([
      [1, 9, 1.5, 1, null],
      [2, 4, 0.2, 2, null],
    ]);
  });

  test("已经用来过滤的代码会从全文查询里拿掉，并按这家公司的文档检索", async () => {
    store.searchChunksByKeyword.mockResolvedValue([]);

    const result = await retrieve({
      query: "广汇能源（600256）的产能怎么看",
      userId: 8,
      mode: "keyword",
    });

    expect(store.searchChunksByKeyword).toHaveBeenCalledWith(8, {
      text: "广汇能源 的产能怎么看",
      stockCode: "600256",
      limit: 5,
    });
    expect(result.keywordQuery).toBe("广汇能源 的产能怎么看");
    expect(result.stockCode).toBe("600256");
  });

  test("两家代码都出现时不过滤，代码也留在全文查询里", async () => {
    store.searchChunksByKeyword.mockResolvedValue([]);

    await retrieve({ query: "比较 600256 和 000001 的目标价", userId: 8, mode: "keyword" });

    expect(store.searchChunksByKeyword).toHaveBeenCalledWith(8, {
      text: "比较 600256 和 000001 的目标价",
      stockCode: null,
      limit: 5,
    });
  });

  test("去掉代码后组不出词，就不再查全文", async () => {
    const result = await retrieve({ query: "600256", userId: 8, mode: "keyword" });

    expect(store.searchChunksByKeyword).not.toHaveBeenCalled();
    expect(result.keywordQuery).toBe("");
    expect(result.hits).toEqual([]);
  });

  test("显式传入的代码优先，问题里没有这段数字时全文查询保持原样", async () => {
    store.searchChunksByKeyword.mockResolvedValue([]);

    await retrieve({
      query: "目标价是多少",
      userId: 8,
      mode: "keyword",
      stockCode: "600256",
    });

    expect(store.searchChunksByKeyword).toHaveBeenCalledWith(8, {
      text: "目标价是多少",
      stockCode: "600256",
      limit: 5,
    });
  });
});

describe("混合检索", () => {
  test("两路各取 20 条，按名次融合后再截成 topK", async () => {
    mockQuery.mockResolvedValue({
      points: [
        { id: 1, score: 0.9 },
        { id: 2, score: 0.8 },
        { id: 3, score: 0.7 },
      ],
    });
    store.listChunksByIds.mockResolvedValue([row(3, "丙"), row(1, "甲"), row(2, "乙")]);
    store.searchChunksByKeyword.mockResolvedValue([
      { ...row(2, "乙"), score: 3.2 },
      { ...row(4, "丁"), score: 2.1 },
      { ...row(1, "甲"), score: 1.4 },
    ]);

    const result = await retrieve({
      query: "600256 的目标价",
      userId: 8,
      topK: 4,
      mode: "hybrid",
    });

    expect(mockEmbedQuery).toHaveBeenCalledWith("600256 的目标价", { signal: undefined });
    expect(mockQuery.mock.calls[0][1].limit).toBe(20);
    expect(store.searchChunksByKeyword).toHaveBeenCalledWith(8, {
      text: "的目标价",
      stockCode: "600256",
      limit: 20,
    });
    // 2: 向量第 2 + 关键词第 1；1: 向量第 1 + 关键词第 3；4 只有关键词；3 只有向量。
    expect(result.hits.map((hit) => [hit.id, hit.rank, hit.vectorRank, hit.keywordRank])).toEqual([
      [2, 1, 2, 1],
      [1, 2, 1, 3],
      [4, 3, null, 2],
      [3, 4, 3, null],
    ]);
    expect(result.hits[0].score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(result.hits[0].vectorScore).toBe(0.8);
    expect(result.hits[0].keywordScore).toBe(3.2);
    expect(result.hits[2].vectorScore).toBeNull();
    expect(result.keywordQuery).toBe("的目标价");
    expect(mockRerankPassages).not.toHaveBeenCalled();
  });

  test("重排按相关度重排融合结果，低于阈值的不进 hits，但仍留在 ranked", async () => {
    mockQuery.mockResolvedValue({
      points: [
        { id: 1, score: 0.9 },
        { id: 2, score: 0.8 },
        { id: 3, score: 0.7 },
      ],
    });
    store.listChunksByIds.mockResolvedValue([row(3, "丙"), row(1, "甲"), row(2, "乙")]);
    store.searchChunksByKeyword.mockResolvedValue([
      { ...row(2, "乙"), score: 3.2 },
      { ...row(4, "丁"), score: 2.1 },
      { ...row(1, "甲"), score: 1.4 },
    ]);
    // 融合顺序是 2、1、4、3。重排把融合第 4 的丙提到第 1。
    mockRerankPassages.mockResolvedValue([
      { index: 3, score: 0.91 },
      { index: 0, score: 0.2 },
      { index: 1, score: 0.05 },
      { index: 2, score: 0.04 },
    ]);

    const result = await retrieve({
      query: "600256 的目标价",
      userId: 8,
      topK: 2,
      mode: "hybrid",
      rerank: true,
      minScore: 0.5,
    });

    expect(mockQuery.mock.calls[0][1].limit).toBe(20);
    expect(mockRerankPassages).toHaveBeenCalledWith(
      "600256 的目标价",
      ["乙", "甲", "丁", "丙"],
      { signal: undefined }
    );
    expect(result.hits.map((hit) => [hit.id, hit.rerankRank, hit.rrfRank])).toEqual([[3, 1, 4]]);
    expect(result.ranked.map((hit) => [hit.id, hit.rerankRank, hit.dropped])).toEqual([
      [3, 1, false],
      [2, 2, true],
      [1, 3, true],
      [4, 4, true],
    ]);
    expect(result.ranked[0].rerankScore).toBe(0.91);
    expect(result.minScore).toBe(0.5);
  });
});

describe("重排召回条数", () => {
  test("向量模式打开重排时先取 20 条，没有候选就不调用重排", async () => {
    mockQuery.mockResolvedValue({ points: [] });
    store.listChunksByIds.mockResolvedValue([]);

    const result = await retrieve({
      query: "目标价",
      userId: 8,
      topK: 3,
      mode: "vector",
      rerank: true,
    });

    expect(mockQuery.mock.calls[0][1].limit).toBe(20);
    expect(mockRerankPassages).not.toHaveBeenCalled();
    expect(result.hits).toEqual([]);
    expect(result.ranked).toEqual([]);
  });
});
