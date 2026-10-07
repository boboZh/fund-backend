const { buildDocument } = require("./layout");

const item = (str, x, y, width, height = 12) => ({ str, x, y, width, height });

const page = (items, width = 600, pageNumber = 1) => ({
  pageNumber,
  width,
  height: 800,
  items,
});

describe("版面还原", () => {
  test("首页左侧栏单独成为核心数据，右侧正文按段落分开", () => {
    const doc = buildDocument([
      page([
        item("投资评级", 40, 700, 80),
        item("买入", 40, 680, 40),
        item("目标价", 40, 660, 60),
        item("25元", 40, 640, 40),
        item("公司深耕主业。", 280, 700, 200, 12),
        item("产能继续增长。", 280, 660, 200, 12),
      ]),
    ]);
    const summary = doc.paragraphs.find((paragraph) => paragraph.kind === "summary");
    expect(summary.text).toContain("投资评级");
    expect(summary.text).toContain("目标价");
    expect(summary.heading).toBe("核心数据");
    const body = doc.paragraphs.filter((paragraph) => paragraph.kind === "text");
    expect(body.some((paragraph) => paragraph.text.includes("公司深耕主业"))).toBe(true);
    expect(body.some((paragraph) => paragraph.text.includes("投资评级"))).toBe(false);
  });

  test("免责声明及其后的内容不进入段落", () => {
    const doc = buildDocument([
      page([
        item("主业稳定增长。", 80, 700, 240, 12),
        item("免责声明", 80, 560, 80, 16),
        item("市场有风险，投资需谨慎。", 80, 520, 260, 12),
      ]),
    ]);
    const texts = doc.paragraphs.map((paragraph) => paragraph.text).join("\n");
    expect(texts).toContain("主业稳定增长");
    expect(texts).not.toContain("免责声明");
    expect(texts).not.toContain("市场有风险");
    expect(doc.dropped.some((item) => item.reason === "免责声明")).toBe(true);
  });

  test("同一行高的左栏数字不会插进右栏正文", () => {
    const doc = buildDocument([
      page([
        item("当前股价", 40, 520, 70),
        item("119.81", 150, 500, 40),
        item("总市值", 40, 480, 60),
        item("203", 160, 460, 30),
        item("超节点集群", 320, 500, 80),
        item("方向发展，这对超节点内部提出了更高的要求。", 320, 478, 250),
        item("随着全球AI大模型参数持续增长。", 320, 520, 220),
      ]),
    ]);
    const summary = doc.paragraphs.find((paragraph) => paragraph.kind === "summary");
    const body = doc.paragraphs
      .filter((paragraph) => paragraph.kind !== "summary")
      .map((paragraph) => paragraph.text)
      .join("\n");
    expect(summary.text).toContain("119.81");
    expect(summary.text).toContain("203");
    expect(body).toContain("超节点集群");
    expect(body).toContain("方向发展");
    expect(body).not.toContain("119.81");
    expect(body).not.toContain("203");
  });

  test("盈利预测表保持整表，单元格之间有分隔", () => {
    const doc = buildDocument([
      page(
        [
          item("公司盈利预测如下，维持买入评级。", 40, 500, 280),
          item("预测指标", 40, 430, 70),
          item("2025A", 150, 430, 40),
          item("2026E", 210, 430, 40),
          item("2027E", 270, 430, 40),
          item("2028E", 330, 430, 40),
          item("主营收入（百万元）", 40, 408, 90),
          item("1,741", 150, 408, 40),
          item("2,535", 210, 408, 40),
          item("5,119", 270, 408, 40),
          item("7,179", 330, 408, 40),
          item("增长率（%）", 40, 386, 70),
          item("35.3%", 150, 386, 40),
          item("45.6%", 210, 386, 40),
          item("101.9%", 270, 386, 40),
          item("40.2%", 330, 386, 40),
        ],
        420,
      ),
    ]);
    const table = doc.paragraphs.find((paragraph) => paragraph.kind === "table");
    const prose = doc.paragraphs
      .filter((paragraph) => paragraph.kind === "text")
      .map((paragraph) => paragraph.text)
      .join("\n");
    expect(table).toBeTruthy();
    expect(table.text).toContain("2025A");
    expect(table.text).toContain("1,741");
    expect(table.text).toContain("45.6%");
    expect(table.text).toContain("|");
    expect(prose).toContain("维持买入评级");
    expect(prose).not.toContain("1,741");
    expect(prose).not.toContain("45.6%");
  });

  test("连续三页重复的页眉被去掉，首页文字仍可用于识别机构", () => {
    const pages = [1, 2, 3].map((pageNumber) =>
      page(
        [
          item("开源证券", 80, 760, 80, 10),
          item(`第${pageNumber}页正文内容足够长。`, 80, 700, 240, 12),
          item(String(pageNumber), 300, 40, 10, 10),
        ],
        600,
        pageNumber,
      ),
    );
    const doc = buildDocument(pages);
    const texts = doc.paragraphs.map((paragraph) => paragraph.text).join("\n");
    expect(texts).not.toContain("开源证券");
    expect(texts).toContain("第1页正文内容足够长");
    expect(doc.metaLines.some((line) => line.text === "开源证券")).toBe(true);
    expect(doc.dropped.some((item) => item.reason === "页眉页脚")).toBe(true);
  });
});
