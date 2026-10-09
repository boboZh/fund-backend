jest.mock("../services/rag/retrieve", () => ({
  retrieve: jest.fn(),
  DEFAULT_MIN_SCORE: 0.06,
}));
jest.mock("../services/rag/store", () => ({
  listChunkBodies: jest.fn(),
}));
jest.mock("../services/ai", () => ({
  client: { chat: { completions: { create: jest.fn() } } },
}));

const { missReason, corpusOf, formatTable } = require("./rag-eval");

describe("评测失败落点", () => {
  test("库里没有整句时，不把责任算到召回", () => {
    expect(missReason({ inCorpus: false, inFilter: false, inPool: false, inHits: false, poolIsWide: true })).toBe(
      "库里没有整句原文，回到解析或切块"
    );
  });

  test("原文在别的股票下，是过滤条件", () => {
    expect(missReason({ inCorpus: true, inFilter: false, inPool: false, inHits: false, poolIsWide: true })).toBe(
      "过滤条件把含原文的文档排除了"
    );
  });

  test("混合检索的池子是前 20，向量模式只有前 5", () => {
    expect(missReason({ inCorpus: true, inFilter: true, inPool: false, inHits: false, poolIsWide: true })).toBe(
      "召回没进前 20"
    );
    expect(missReason({ inCorpus: true, inFilter: true, inPool: false, inHits: false, poolIsWide: false })).toBe(
      "没进这次召回的前 5"
    );
  });

  test("进了召回池但没留在 hits，是重排或阈值", () => {
    expect(missReason({ inCorpus: true, inFilter: true, inPool: true, inHits: false, poolIsWide: true })).toBe(
      "重排或阈值把它排出了前 5"
    );
  });

  test("留在 hits 里不算检索失败", () => {
    expect(missReason({ inCorpus: true, inFilter: true, inPool: true, inHits: true, poolIsWide: true })).toBe("");
  });

  test("没有指定股票时，库里有原文就算在过滤范围内", () => {
    const bodies = [{ content: "富油煤需求增长", stockCode: "600256" }];
    expect(corpusOf(bodies, "富油煤需求增长", undefined)).toEqual({ inCorpus: true, inFilter: true });
    expect(corpusOf(bodies, "富油煤需求增长", "000560")).toEqual({ inCorpus: true, inFilter: false });
  });
});

describe("对照表", () => {
  test("四种配置各有 recall 和拒答、生成漏写", () => {
    const text = formatTable([
      {
        label: "向量",
        hitCounts: { 1: 8, 3: 10, 5: 10 },
        total: 10,
        rejectEmpty: 0,
        rejectTotal: 4,
        generationGaps: 1,
      },
    ]);
    expect(text).toContain("检索命中但回答没有");
    expect(text).toContain("8/10");
    expect(text).toContain("0/4");
    expect(text).toContain("1");
  });
});
