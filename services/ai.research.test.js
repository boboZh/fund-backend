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

const { actions, tools, mergeResearchSources } = require("./ai");
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
          id: 9,
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
        id: 9,
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

describe("mergeResearchSources", () => {
  const passage = (id, ref, content) =>
    JSON.stringify([
      {
        id,
        ref,
        title: "标题",
        org: "开源证券",
        reportDate: "2026-10-05",
        page: 7,
        heading: "盈利预测",
        content,
      },
    ]);

  test("同一 chunk 只保留第一次，两次调用的 ref 连续且不重号", () => {
    const first = mergeResearchSources(
      [],
      [
        { name: "search_research_reports", content: passage(9, 1, "甲") },
        { name: "search_research_reports", content: passage(9, 1, "甲重复") },
        { name: "get_user_portfolio", content: "{\"data\":[]}" },
      ]
    );
    const second = mergeResearchSources(first.sources, [
      {
        name: "search_research_reports",
        content: JSON.stringify([
          {
            id: 9,
            ref: 1,
            title: "标题",
            org: "开源证券",
            reportDate: "2026-10-05",
            page: 7,
            heading: "盈利预测",
            content: "甲又来了",
          },
          {
            id: 4,
            ref: 2,
            title: "另一份",
            org: "中信",
            reportDate: "2026-09-01",
            page: 3,
            heading: "产能",
            content: "乙",
          },
        ]),
      },
    ]);

    expect(second.sources.map((item) => [item.id, item.ref, item.content])).toEqual([
      [9, 1, "甲"],
      [4, 2, "乙"],
    ]);
    expect(JSON.parse(first.contents[0])).toEqual([
      {
        ref: 1,
        title: "标题",
        org: "开源证券",
        reportDate: "2026-10-05",
        page: 7,
        heading: "盈利预测",
        content: "甲",
      },
    ]);
    expect(JSON.parse(first.contents[1])[0].ref).toBe(1);
    expect(first.contents[1]).not.toContain('"id"');
    expect(first.contents[2]).toBe("{\"data\":[]}");
    expect(JSON.parse(second.contents[0]).map((item) => item.ref)).toEqual([1, 2]);
  });
});
