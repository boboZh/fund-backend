const { parseResearchMeta } = require("./meta");

describe("研报元数据识别", () => {
  test("从东方财富风格的文件名识别代码、名称和标题", () => {
    const { suggestion, filledFrom } = parseResearchMeta({
      fileName:
        "广汇能源（600256）：公司深度报告：民营能源全产业链龙头，产能增长业绩可期 25页.pdf",
    });
    expect(suggestion.stockCode).toBe("600256");
    expect(suggestion.stockName).toBe("广汇能源");
    expect(suggestion.title).toBe(
      "广汇能源（600256）：公司深度报告：民营能源全产业链龙头，产能增长业绩可期",
    );
    expect(suggestion.reportDate).toBe("");
    expect(suggestion.org).toBe("");
    expect(filledFrom.stockCode).toBe("filename");
    expect(filledFrom.title).toBe("filename");
  });

  test("从下划线文件名识别代码、名称、机构和日期", () => {
    const { suggestion, filledFrom } = parseResearchMeta({
      fileName: "600256.SH_广汇能源_开源证券_20261005.pdf",
    });
    expect(suggestion.stockCode).toBe("600256");
    expect(suggestion.stockName).toBe("广汇能源");
    expect(suggestion.org).toBe("开源证券");
    expect(suggestion.reportDate).toBe("2026-10-05");
    expect(suggestion.title).toBe("");
    expect(filledFrom.reportDate).toBe("filename");
    expect(filledFrom.org).toBe("filename");
  });

  test("正文里的日期和机构补上文件名没有的字段，日期不会被当成股票代码", () => {
    const { suggestion, filledFrom } = parseResearchMeta({
      fileName: "公司深度报告.pdf",
      lines: [
        { text: "广汇能源（600256）：公司深度报告", fontSize: 18 },
        { text: "开源证券", fontSize: 12 },
        { text: "2026年10月5日", fontSize: 10 },
      ],
    });
    expect(suggestion.stockCode).toBe("600256");
    expect(suggestion.stockName).toBe("广汇能源");
    expect(suggestion.org).toBe("开源证券");
    expect(suggestion.reportDate).toBe("2026-10-05");
    expect(suggestion.title).toContain("广汇能源（600256）");
    expect(filledFrom.stockCode).toBe("pdf");
    expect(filledFrom.org).toBe("pdf");
    expect(suggestion.stockCode).not.toBe("202610");
  });

  test("没识别到的字段留空", () => {
    const { suggestion } = parseResearchMeta({
      fileName: "阅读笔记.pdf",
      lines: [{ text: "这是一段没有代码的说明", fontSize: 12 }],
    });
    expect(suggestion.stockCode).toBe("");
    expect(suggestion.org).toBe("");
    expect(suggestion.reportDate).toBe("");
  });
});
