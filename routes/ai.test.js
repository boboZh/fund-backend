jest.mock("openai", () => ({ OpenAI: jest.fn(() => ({ chat: { completions: { create: jest.fn() } } })) }));
jest.mock("axios", () => ({ post: jest.fn(), isCancel: jest.fn(() => false) }));
jest.mock("../services/rag/retrieve", () => ({ retrieve: jest.fn(), DEFAULT_MIN_SCORE: 0.5 }));
jest.mock("../controller/fund", () => ({ getPortfolio: jest.fn(), getFundInfoByCode: jest.fn(), setFundAlert: jest.fn() }));
jest.mock("../middleware/auth", () => (req, res, next) => next());
// 历史工具为 ESM，当前 Jest 未配置 ESM 转换；本测试使用空历史，不验证压缩逻辑。
jest.mock("../utils/tools", () => ({ sanitizeHistory: (messages) => messages }));
jest.mock("../controller/ai", () => ({
  checkSessionIdValid: jest.fn(async () => [{}]),
  getSessionMessages: jest.fn(async () => []),
  saveUserMessage: jest.fn(),
  saveAssistantMessage: jest.fn(),
  saveToolCallResultMessage: jest.fn(),
  saveUiMsg: jest.fn(),
}));

const { EventEmitter } = require("events");
const axios = require("axios");
const { client, tools } = require("../services/ai");
const { retrieve } = require("../services/rag/retrieve");
const { saveToolCallResultMessage, saveUiMsg } = require("../controller/ai");
const router = require("./ai");
const chatHandler = router.stack.find((layer) => layer.route?.path === "/chat").route.stack[1].handle;
const stream = async function* (delta) { yield { choices: [{ delta }] }; };
const call = (name, args, id) => ({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] });

// 经过真实路由、工具分发、搜索服务和持久化缓冲，仅替换模型、外部 API 和数据库。
async function chat() {
  const req = Object.assign(new EventEmitter(), {
    body: { message: "英伟达的目标价和近期走势", sessionId: "session-1" }, userId: 8,
  });
  let body = "";
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setHeader: jest.fn(),
    write: (chunk) => { body += chunk; },
    end: () => { res.writableEnded = true; },
  });
  await chatHandler(req, res);
  return body;
}

describe("AI 聊天联网工具集成", () => {
  const originalKey = process.env.TAVILY_API_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    client.chat.completions.create.mockReset();
    axios.post.mockReset();
    retrieve.mockReset();
    process.env.TAVILY_API_KEY = "test-key";
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalKey;
  });

  test.each([{ hits: [] }, { hits: [{ id: 9, title: "胜蓝股份研报", content: "与英伟达无关的内容" }] }])(
    "研报为空或不相关后允许继续联网并保存网页来源：%j", async ({ hits }) => {
      retrieve.mockResolvedValue({ hits });
      axios.post.mockResolvedValue({ data: { results: [{ title: "NVIDIA 公告", url: "https://investor.nvidia.com/", content: "最新业务信息" }] } });
      client.chat.completions.create
        .mockResolvedValueOnce(stream(call("search_research_reports", { query: "英伟达的目标价" }, "rag-1")))
        .mockResolvedValueOnce(stream(call("search_web", { query: "NVIDIA NVDA 近期走势", timeRange: "week" }, "web-1")))
        .mockResolvedValueOnce(stream({ content: "根据[NVIDIA 公告](https://investor.nvidia.com/)分析。" }));
      const body = await chat();
      expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
      expect(tools.some((tool) => tool.function.name === "search_web")).toBe(true);
      const messages = client.chat.completions.create.mock.calls[2][0].messages;
      expect(messages[0].content).toContain("必须继续调用 search_web");
      expect(messages[0].content).toContain("片段不相关");
      expect(messages.find((msg) => msg.tool_call_id === "web-1")).toMatchObject({
        role: "tool", content: expect.stringContaining('"url":"https://investor.nvidia.com/"'),
      });
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(body).toContain("正在联网搜索公开信息");
      expect(body).toContain("https://investor.nvidia.com/");
      expect(saveToolCallResultMessage).toHaveBeenCalledWith("session-1", 8, expect.stringContaining('"status":"success"'), "web-1");
      expect(saveUiMsg).toHaveBeenCalledWith("session-1", 8, "ai", expect.stringContaining("https://investor.nvidia.com/"), "success", expect.any(Array));
    }
  );

  test("搜索失败交还模型说明限制，流式对话继续完成", async () => {
    axios.post.mockRejectedValue(new Error("network timeout"));
    client.chat.completions.create
      .mockResolvedValueOnce(stream(call("search_web", { query: "NVIDIA 走势" }, "web-1")))
      .mockResolvedValueOnce(stream({ content: "联网搜索暂时失败，本次未获取到网络信息。" }));
    const body = await chat();
    expect(body).toContain("联网搜索暂时失败");
    expect(body).not.toContain("ai暂时休息了");
    expect(saveToolCallResultMessage).toHaveBeenCalledWith("session-1", 8, expect.stringContaining('"status":"error"'), "web-1");
  });
});
