jest.mock("./rag/embed", () => ({ embedQuery: jest.fn() }));
jest.mock("./rag/rerank", () => ({ rerankPassages: jest.fn() }));
jest.mock("./rag/qdrant", () => ({
  COLLECTION: "research_chunks",
  getClient: jest.fn(),
}));
jest.mock("./rag/store", () => ({
  listChunksByIds: jest.fn(),
  searchChunksByKeyword: jest.fn(),
}));
jest.mock("../controller/fund", () => ({
  getPortfolio: jest.fn(),
  getFundInfoByCode: jest.fn(),
  setFundAlert: jest.fn(),
}));
jest.mock("openai", () => ({ OpenAI: jest.fn() }));

const retrieveModule = require("./rag/retrieve");
const mockRetrieve = jest.fn();
retrieveModule.retrieve = mockRetrieve;

const { actions, tools } = require("./ai");
const { signalContext } = require("../utils/context");

const tool = tools.find((item) => item.function.name === "search_research_reports");
const action = actions.search_research_reports;

describe("search_research_reports", () => {
  beforeEach(() => {
    mockRetrieve.mockReset();
  });

  test("工具声明只要求 query，并写明要把代词补成公司名", () => {
    expect(tool.strict).toBeUndefined();
    expect(tool.function.parameters.required).toEqual(["query"]);
    expect(tool.function.description).toContain("不要凭记忆回答");
    expect(tool.function.parameters.properties.stockCode.description).toContain("可选");
    expect(tool.function.parameters.properties.query.description).toContain("那它的目标价呢");
    expect(action.description).toBe("正在检索公司研报");
  });

  test("按混合、重排、topK 5 和评测阈值检索，并给片段编号", async () => {
    mockRetrieve.mockResolvedValue({
      hits: [
        {
          title: "广汇能源深度报告",
          org: "开源证券",
          reportDate: "2026-10-05",
          pageStart: 7,
          heading: "盈利预测与估值",
          content: "目标价 12 元",
        },
      ],
    });
    const controller = new AbortController();

    const raw = await signalContext.run(controller.signal, () =>
      action.func(
        { query: "广汇能源的目标价", stockCode: "600256", dateFrom: "2026-01-01" },
        8
      )
    );

    expect(mockRetrieve).toHaveBeenCalledWith({
      query: "广汇能源的目标价",
      userId: 8,
      mode: "hybrid",
      rerank: true,
      topK: 5,
      minScore: retrieveModule.DEFAULT_MIN_SCORE,
      stockCode: "600256",
      dateFrom: "2026-01-01",
      signal: controller.signal,
    });
    expect(JSON.parse(raw)).toEqual([
      {
        ref: 1,
        title: "广汇能源深度报告",
        org: "开源证券",
        reportDate: "2026-10-05",
        page: 7,
        heading: "盈利预测与估值",
        content: "目标价 12 元",
      },
    ]);
    expect(action.msgModel(raw)).toBe("找到1条相关研报片段");
  });

  test("没有命中时返回空数组，步骤文案说明库里没有", async () => {
    mockRetrieve.mockResolvedValue({ hits: [] });

    const raw = await action.func({ query: "长鑫科技的投资逻辑" }, 8);

    expect(JSON.parse(raw)).toEqual([]);
    expect(action.msgModel(raw)).toBe("研报库里没有找到相关内容");
  });
});
