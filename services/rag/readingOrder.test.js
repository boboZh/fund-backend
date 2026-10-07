const {
  assemblePage,
  parseBlocks,
  assertNumbersFromSource,
  indexItems,
  dropTrailingBoilerplate,
} = require("./readingOrder");

const item = (id, text, x, y, width = 40) => ({ id, text, x, y, width });

describe("模型阅读顺序", () => {
  const items = [
    item(1, "当前股价（元）", 38, 588, 63),
    item(2, "119.81", 188, 588, 27),
    item(3, "机柜向超节点", 473, 607, 74),
    item(4, "集群", 547, 607, 24),
    item(5, "方向发展，这对超节点内部提出了更高的要求。", 250, 589, 180),
    item(6, "投资要点", 245, 676, 88),
    item(7, "预测指标", 40, 430, 70),
    item(8, "2025A", 150, 430, 40),
    item(9, "2026E", 210, 430, 40),
    item(10, "1,741", 150, 408, 40),
    item(11, "2,535", 210, 408, 40),
    item(12, "主营收入（百万元）", 40, 408, 90),
  ];

  test("侧栏数字留在核心数据，右栏句子按行拼回", () => {
    const doc = assemblePage(
      items,
      [
        { role: "sidebar", lines: [[1, 2]] },
        { role: "heading", lines: [[6]] },
        { role: "paragraph", lines: [[3, 4], [5]] },
        { role: "table", lines: [[7, 8, 9], [12, 10, 11]] },
      ],
      1,
    );
    const summary = doc.paragraphs.find((paragraph) => paragraph.kind === "summary");
    const body = doc.paragraphs.find((paragraph) => paragraph.kind === "text");
    const table = doc.paragraphs.find((paragraph) => paragraph.kind === "table");
    expect(summary.text).toContain("119.81");
    expect(summary.text).toContain("当前股价（元）");
    expect(body.text).toBe("机柜向超节点集群方向发展，这对超节点内部提出了更高的要求。");
    expect(body.text).not.toContain("119.81");
    expect(body.heading).toBe("投资要点");
    expect(table.text).toContain("2025A | 2026E");
    expect(table.text).toContain("1,741 | 2,535");
    expect(table.heading).toBe("投资要点");
  });

  test("模型把股价写进正文、并附带改写数字时，仍然只用原文 id", () => {
    const doc = assemblePage(
      items.slice(0, 5),
      [
        {
          role: "sidebar",
          lines: [[1, 2]],
          text: "当前股价 120.00",
        },
        {
          role: "paragraph",
          lines: [[3, 2, 4], [5]],
          text: "目标价 999.99",
        },
      ],
      1,
    );
    const body = doc.paragraphs.find((paragraph) => paragraph.kind === "text").text;
    const summary = doc.paragraphs.find((paragraph) => paragraph.kind === "summary").text;
    expect(summary).toContain("119.81");
    expect(body).not.toContain("119.81");
    expect(body).not.toContain("999.99");
    expect(body).not.toContain("120.00");
    expect(JSON.stringify(doc)).not.toContain("999.99");
  });

  test("未知 id 和重复 id 不会造出新文字", () => {
    const doc = assemblePage(
      [item(1, "主业稳定。", 40, 700, 80)],
      [{ role: "paragraph", lines: [[1, 99], [1]] }],
      2,
    );
    expect(doc.paragraphs).toHaveLength(1);
    expect(doc.paragraphs[0].text).toBe("主业稳定。");
    expect(doc.paragraphs[0].page).toBe(2);
  });

  test("紧挨着的日期碎片不加竖线，隔开的单元格才加", () => {
    const doc = assemblePage(
      [
        item(1, "2026", 32, 773, 24),
        item(2, "-09-30", 56, 773, 40),
        item(3, "1,741", 150, 400, 36),
        item(4, "2,535", 210, 400, 36),
      ],
      [
        { role: "paragraph", lines: [[1, 2]] },
        { role: "table", lines: [[3, 4]] },
      ],
      1,
    );
    expect(doc.paragraphs[0].text).toBe("2026-09-30");
    expect(doc.paragraphs[1].text).toBe("1,741 | 2,535");
  });

  test("可以从代码块里取出 blocks", () => {
    const blocks = parseBlocks('说明\n```json\n{"blocks":[{"role":"paragraph","lines":[[1]]}]}\n```');
    expect(blocks[0].role).toBe("paragraph");
  });

  test("字距被抽成空格时收紧，英文单词和小数保持原样", () => {
    const indexed = indexItems([
      { str: "定 算 力 释 放", x: 1, y: 1, width: 40 },
      { str: "2 0 2 6", x: 20, y: 1, width: 20 },
      { str: "119.81", x: 40, y: 1, width: 20 },
      { str: "Research Nester", x: 60, y: 1, width: 40 },
    ]);
    expect(indexed.map((item) => item.text)).toEqual([
      "定算力释放",
      "2026",
      "119.81",
      "Research Nester",
    ]);
  });

  test("评级说明入库，免责条款及其后的内容不入库", () => {
    const { paragraphs } = dropTrailingBoilerplate([
      { page: 2, text: "维持买入评级。", kind: "text", heading: "盈利预测" },
      { page: 4, text: "投资建议 | 买入 | >20%", kind: "table", heading: "证券投资评级说明" },
      { page: 5, text: "司不会因接收人收到本报告而视其为客户。本公司不承担任何法律责任。", kind: "text", heading: null },
      { page: 5, text: "本报告版权仅为华鑫证券所有。", kind: "text", heading: null },
    ]);
    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "维持买入评级。",
      "投资建议 | 买入 | >20%",
    ]);
  });

  test("原文没有的数字会被拒绝", () => {
    expect(() => assertNumbersFromSource("目标价 119.82", "目标价 119.81")).toThrow(/119\.82/);
  });
});
