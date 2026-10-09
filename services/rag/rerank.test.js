const mockPost = jest.fn();

jest.mock("axios", () => ({
  post: (...args) => mockPost(...args),
}));

const { rerankPassages } = require("./rerank");

beforeEach(() => {
  mockPost.mockReset();
  process.env.RAG_API_KEY = "rag-test-key";
  process.env.RAG_BASE_URL = "https://api.siliconflow.cn/v1";
  process.env.RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
});

describe("重排", () => {
  test("把问题和每段正文一起交给重排接口，并带回下标和分数", async () => {
    mockPost.mockResolvedValue({
      data: {
        results: [
          { index: 1, relevance_score: 0.2 },
          { index: 0, relevance_score: 0.9 },
        ],
      },
    });

    const scores = await rerankPassages("目标价", ["甲", "乙"]);

    expect(mockPost).toHaveBeenCalledWith(
      "https://api.siliconflow.cn/v1/rerank",
      {
        model: "BAAI/bge-reranker-v2-m3",
        query: "目标价",
        documents: ["甲", "乙"],
        top_n: 2,
        return_documents: false,
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer rag-test-key" }),
      })
    );
    expect(scores).toEqual([
      { index: 1, score: 0.2 },
      { index: 0, score: 0.9 },
    ]);
  });

  test("没有候选时不请求接口", async () => {
    await expect(rerankPassages("目标价", [])).resolves.toEqual([]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("参数错误不重试", async () => {
    const err = new Error("bad");
    err.response = { status: 400, data: { message: "模型不存在" } };
    mockPost.mockRejectedValue(err);

    await expect(rerankPassages("目标价", ["甲"])).rejects.toThrow("模型不存在");
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test("服务端失败会再试", async () => {
    const err = new Error("unavailable");
    err.response = { status: 503, data: {} };
    mockPost
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ data: { results: [{ index: 0, relevance_score: 0.4 }] } });

    const scores = await rerankPassages("目标价", ["甲"]);

    expect(scores).toEqual([{ index: 0, score: 0.4 }]);
    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});
