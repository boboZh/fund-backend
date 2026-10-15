const axios = require("axios");

jest.mock("axios", () => ({
  post: jest.fn(),
}));

const { postRetrieve } = require("./pythonRetrieve");

const hit = {
  mode: "hybrid",
  topK: 5,
  stockCode: "600256",
  keywordQuery: "的目标价",
  rerank: true,
  minScore: 0.06,
  hits: [{ id: 9, content: "目标价 12 元" }],
  ranked: [],
};

beforeEach(() => {
  axios.post.mockReset();
  delete process.env.RAG_RETRIEVE_URL;
});

test("把检索参数交给 Python /retrieve，并带回命中", async () => {
  axios.post.mockResolvedValue({ data: hit });
  const controller = new AbortController();

  const result = await postRetrieve({
    query: "广汇能源的目标价",
    userId: 8,
    topK: 5,
    mode: "hybrid",
    rerank: true,
    minScore: 0,
    stockCode: "600256",
    dateFrom: "2026-01-01",
    signal: controller.signal,
  });

  expect(result.hits[0].id).toBe(9);
  expect(axios.post).toHaveBeenCalledWith(
    "http://127.0.0.1:9001/retrieve",
    {
      query: "广汇能源的目标价",
      userId: 8,
      topK: 5,
      mode: "hybrid",
      rerank: true,
      minScore: 0,
      stockCode: "600256",
      dateFrom: "2026-01-01",
    },
    expect.objectContaining({
      timeout: 6 * 60 * 1000,
      signal: controller.signal,
    })
  );
});

test("空的可选条件不写进请求体", async () => {
  axios.post.mockResolvedValue({ data: { hits: [] } });

  await postRetrieve({
    query: "目标价",
    userId: 8,
    minScore: null,
    stockCode: undefined,
    dateFrom: "",
  });

  expect(axios.post.mock.calls[0][1]).toEqual({
    query: "目标价",
    userId: 8,
  });
});

test("Python 返回的 detail 原样抛出", async () => {
  const err = new Error("bad");
  err.response = { status: 400, data: { detail: "股票代码需要是 6 位数字" } };
  axios.post.mockRejectedValue(err);
  await expect(postRetrieve({ query: "目标价", userId: 8 })).rejects.toThrow(
    "股票代码需要是 6 位数字"
  );
});

test("服务没启动时抛出可展示的错误", async () => {
  const err = new Error("connect ECONNREFUSED");
  err.code = "ECONNREFUSED";
  axios.post.mockRejectedValue(err);
  await expect(postRetrieve({ query: "目标价", userId: 8 })).rejects.toThrow(
    "Python 检索服务没有启动"
  );
});

test("取消不改写成普通失败", async () => {
  const err = new Error("canceled");
  err.code = "ERR_CANCELED";
  err.name = "CanceledError";
  axios.post.mockRejectedValue(err);
  await expect(postRetrieve({ query: "目标价", userId: 8 })).rejects.toMatchObject({
    name: "AbortError",
    code: "ERR_CANCELED",
  });
});
