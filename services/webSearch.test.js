jest.mock("axios", () => ({ post: jest.fn(), isCancel: jest.fn(() => false) }));
const axios = require("axios");
const { searchWeb } = require("./webSearch");
const { signalContext } = require("../utils/context");

describe("searchWeb", () => {
  const originalKey = process.env.TAVILY_API_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TAVILY_API_KEY = "test-key";
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalKey;
  });
  test("传递时间范围和取消信号，过滤无效链接并限制内容长度", async () => {
    axios.post.mockResolvedValue({ data: { results: [
      { title: "公告", url: "https://investor.nvidia.com/", published_date: "2026-11-16", content: "甲".repeat(2100) },
      { url: "javascript:alert(1)", content: "恶意链接" },
      { url: "https://example.com/", content: "" },
      null,
    ] } });
    const controller = new AbortController();
    const raw = await signalContext.run(controller.signal, () =>
      searchWeb({ query: " 英伟达 NVDA 最新消息 ", timeRange: "week" })
    );
    expect(axios.post).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({ query: "英伟达 NVDA 最新消息", time_range: "week", max_results: 5 }),
      { headers: { Authorization: "Bearer test-key" }, timeout: 15000, signal: controller.signal }
    );
    const result = JSON.parse(raw);
    expect(result.status).toBe("success");
    expect(result.searchedAt).toBeTruthy();
    expect(result.results).toEqual([{
      title: "公告", url: "https://investor.nvidia.com/", publishedDate: "2026-11-16", content: "甲".repeat(2000),
    }]);
  });
  test("缺少密钥时说明配置问题，不发网络请求", async () => {
    delete process.env.TAVILY_API_KEY;
    expect(JSON.parse(await searchWeb({ query: "NVDA" })).message).toContain("TAVILY_API_KEY");
    expect(axios.post).not.toHaveBeenCalled();
  });
  test.each([{}, { query: " " }, { query: "甲".repeat(1001) }, { query: "NVDA", timeRange: "invalid" }])(
    "无效参数不发网络请求：%j", async (args) => {
      expect(JSON.parse(await searchWeb(args)).status).toBe("error");
      expect(axios.post).not.toHaveBeenCalled();
    }
  );
  test("区分没有结果、响应异常和请求失败，不泄露供应商错误", async () => {
    axios.post.mockResolvedValueOnce({ data: { results: [] } });
    expect(JSON.parse(await searchWeb({ query: "NVDA" }))).toMatchObject({ status: "success", results: [] });
    axios.post.mockResolvedValueOnce({ data: {} });
    expect(JSON.parse(await searchWeb({ query: "NVDA" })).status).toBe("error");
    axios.post.mockRejectedValueOnce(new Error("secret-key"));
    const raw = await searchWeb({ query: "NVDA" });
    expect(JSON.parse(raw).status).toBe("error");
    expect(raw).not.toContain("secret-key");
  });
  test("无发布日期时保留未知日期", async () => {
    axios.post.mockResolvedValue({ data: { results: [{ url: "https://example.com", content: "片段" }] } });
    expect(JSON.parse(await searchWeb({ query: "NVDA" })).results[0].publishedDate).toBeNull();
  });
  test("已取消的请求不发网络请求", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(signalContext.run(controller.signal, () => searchWeb({ query: "NVDA" }))).rejects.toThrow();
    expect(axios.post).not.toHaveBeenCalled();
  });
  test("请求中取消时向路由抛出 AbortError", async () => {
    const controller = new AbortController();
    axios.post.mockImplementation(async () => {
      controller.abort();
      throw new Error("cancelled");
    });
    await expect(signalContext.run(controller.signal, () => searchWeb({ query: "NVDA" })))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
