const { splitParagraphs } = require("./chunk");

const para = (text, heading, kind = "text", page = 1) => ({
  text,
  heading,
  kind,
  page,
});

describe("按段落切块", () => {
  test("短段落合并后，切点仍落在段落之间", () => {
    const chunks = splitParagraphs(
      [
        para("产能继续释放。", "成长"),
        para("需求保持旺盛。", "成长"),
        para("成本开始下行。", "成长"),
      ],
      { maxChars: 800, overlapParagraphs: 0 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("产能继续释放。\n需求保持旺盛。\n成本开始下行。");
    expect(chunks[0].paragraphCount).toBe(3);
  });

  test("遇到新小节就开新块", () => {
    const chunks = splitParagraphs(
      [para("产能继续释放。", "成长"), para("目标价上调到25元。", "估值")],
      { maxChars: 800, overlapParagraphs: 1 },
    );
    expect(chunks.map((chunk) => chunk.heading)).toEqual(["成长", "估值"]);
    expect(chunks[1].content).toBe("目标价上调到25元。");
  });

  test("超长段落按句号拆开，不从字中间截断", () => {
    const first = `${"收入增长".repeat(8)}。`;
    const second = `${"利润改善".repeat(8)}。`;
    const third = `${"估值合理".repeat(8)}。`;
    const chunks = splitParagraphs([para(`${first}${second}${third}`, "盈利")], {
      maxChars: first.length + second.length,
      overlapParagraphs: 0,
    });
    expect(chunks.map((chunk) => chunk.content)).toEqual([`${first}${second}`, third]);
    chunks.forEach((chunk) => {
      expect(chunk.content.endsWith("。")).toBe(true);
    });
  });

  test("重叠是完整的上一段，而不是回退若干个字", () => {
    const first = `第一段${"产能".repeat(12)}。`;
    const second = `第二段${"需求".repeat(12)}。`;
    const third = `第三段${"成本".repeat(12)}。`;
    const chunks = splitParagraphs(
      [para(first, "成长"), para(second, "成长"), para(third, "成长")],
      { maxChars: first.length + 1 + second.length, overlapParagraphs: 1 },
    );
    expect(chunks[0].content).toBe(`${first}\n${second}`);
    expect(chunks[1].content.startsWith(second)).toBe(true);
    expect(chunks[1].content).toContain(third);
  });

  test("表格和首页核心数据单独成块", () => {
    const chunks = splitParagraphs(
      [
        para("评级 买入\n目标价 25", "核心数据", "summary"),
        para("收入 10 20 30\n利润 1 2 3", "财务", "table"),
        para("主业仍然稳定。", "概述"),
      ],
      { maxChars: 800, overlapParagraphs: 1 },
    );
    expect(chunks.map((chunk) => chunk.chunkType)).toEqual(["summary", "table", "text"]);
    expect(chunks[1].content).toBe("收入 10 20 30\n利润 1 2 3");
  });

  test("一整张表即使超过字数上限也保持一块", () => {
    const row = "主营收入（百万元） | 1,741 | 2,535 | 5,119 | 7,179";
    const chunks = splitParagraphs(
      [para(`${row}\n${row}\n${row}`, "盈利预测", "table"), para("维持买入评级。", "盈利预测")],
      { maxChars: 50, overlapParagraphs: 1 },
    );
    expect(chunks[0].chunkType).toBe("table");
    expect(chunks[0].content.split("\n")).toHaveLength(3);
    expect(chunks[1].content).toBe("维持买入评级。");
    expect(chunks[1].content.startsWith(row)).toBe(false);
  });
});
