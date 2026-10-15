const { stockCodeOf, keywordTextOf, retrieve } = require("./retrieve");
const pythonRetrieve = require("./pythonRetrieve");

describe("从问题里取股票代码", () => {
  test("括号里的六位代码可以取出", () => {
    expect(stockCodeOf("广汇能源（600256）的产能怎么看")).toBe("600256");
  });

  test("没有代码，或同时出现两家，就不限定股票", () => {
    expect(stockCodeOf("往后产量靠什么上去")).toBeNull();
    expect(stockCodeOf("比较 600256 和 000001")).toBeNull();
  });

  test("更长的数字不会被切成六位代码", () => {
    expect(stockCodeOf("编号 16002567")).toBeNull();
  });
});

describe("关键词检索前去掉已经用来过滤的股票代码", () => {
  test("括号里的代码会连同空括号一起拿掉", () => {
    expect(keywordTextOf("广汇能源（600256）的产能怎么看", "600256")).toBe(
      "广汇能源 的产能怎么看"
    );
    expect(keywordTextOf("广汇能源(600256)产能", "600256")).toBe("广汇能源 产能");
  });

  test("没有形成过滤条件时，代码留在问题里", () => {
    expect(keywordTextOf("比较 600256 和 000001", null)).toBe(
      "比较 600256 和 000001"
    );
  });

  test("只剩代码时，关键词查询为空", () => {
    expect(keywordTextOf("（600256）", "600256")).toBe("");
  });
});

describe("retrieve", () => {
  test("转发给 Python /retrieve", async () => {
    const postRetrieve = jest
      .spyOn(pythonRetrieve, "postRetrieve")
      .mockResolvedValue({ hits: [] });

    const signal = new AbortController().signal;
    const result = await retrieve({
      query: "目标价",
      userId: 8,
      mode: "keyword",
      signal,
    });

    expect(result).toEqual({ hits: [] });
    expect(postRetrieve).toHaveBeenCalledWith({
      query: "目标价",
      userId: 8,
      mode: "keyword",
      signal,
    });
    postRetrieve.mockRestore();
  });
});
