const mockCreate = jest.fn();

jest.mock("openai", () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    embeddings: { create: (...args) => mockCreate(...args) },
  })),
}));

const { OpenAI } = require("openai");
const { passageText, embedChunks, embedQuery } = require("./embed");

const vector = (index, length = 4) => ({
  index,
  embedding: Array.from({ length }, (_, i) => index * 10 + i),
});

beforeEach(() => {
  mockCreate.mockReset();
  OpenAI.mockClear();
  process.env.RAG_API_KEY = "rag-test-key";
  process.env.RAG_BASE_URL = "https://api.siliconflow.cn/v1";
  process.env.EMBED_MODEL = "BAAI/bge-m3";
  process.env.EMBED_DIM = "4";
});

describe("向量化文本", () => {
  test("块前面加上股票名称和小节标题，原文接在下一行", () => {
    expect(
      passageText({
        stockName: "广汇能源",
        heading: "盈利预测与估值",
        content: "目标价 12.5 元。",
      })
    ).toBe("广汇能源｜盈利预测与估值\n目标价 12.5 元。");
  });

  test("没有小节标题时只保留股票名称", () => {
    expect(
      passageText({
        stockName: "广汇能源",
        heading: null,
        content: "维持买入。",
      })
    ).toBe("广汇能源\n维持买入。");
  });
});

describe("调用 Embedding", () => {
  test("问题原样送出，不加 query 前缀", async () => {
    mockCreate.mockResolvedValue({ data: [vector(0)] });
    await embedQuery("往后产量靠什么上去");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toEqual({
      model: "BAAI/bge-m3",
      input: ["往后产量靠什么上去"],
    });
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "rag-test-key",
        baseURL: "https://api.siliconflow.cn/v1",
      })
    );
  });

  test("块按 16 条一批送出，并带上前缀", async () => {
    mockCreate.mockImplementation(async ({ input }) => ({
      data: input.map((_, index) => vector(index)),
    }));
    const chunks = Array.from({ length: 17 }, (_, index) => ({
      heading: "产能",
      content: `第${index}段。`,
    }));
    const vectors = await embedChunks(chunks, { stockName: "广汇能源" });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].input).toHaveLength(16);
    expect(mockCreate.mock.calls[0][0].input[0]).toBe("广汇能源｜产能\n第0段。");
    expect(mockCreate.mock.calls[1][0].input).toEqual(["广汇能源｜产能\n第16段。"]);
    expect(vectors).toHaveLength(17);
  });

  test("失败后再试 2 次，第三次仍失败就抛错", async () => {
    mockCreate.mockRejectedValue(new Error("上游超时"));
    await expect(embedQuery("目标价")).rejects.toThrow("上游超时");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  test("维度不对立即抛错，不再重试", async () => {
    mockCreate.mockResolvedValue({ data: [vector(0, 3)] });
    await expect(embedQuery("目标价")).rejects.toThrow("向量维度是 3，需要 4");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("已取消的请求不再打到接口", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      embedQuery("目标价", { signal: controller.signal })
    ).rejects.toThrow("embedding 已取消");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
