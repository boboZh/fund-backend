const axios = require("axios");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");

// 1. 获取基金持仓 (GBK解码)
async function getFundHoldings(fundCode) {
  const url = `http://fund.eastmoney.com/${fundCode}.html`;
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer", // 极其重要：保持原始二进制
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    // 使用 GBK 解码
    const html = iconv.decode(Buffer.from(response.data), "utf-8");
    const $ = cheerio.load(html);
    // 基金名称
    const fundName = $(".fundDetail-header .fundDetail-tit div")
      .html()
      .split("<span>(</span>")[0];

    // 获取昨日净值 (用于计算总持仓金额)
    const lastNetValue = parseFloat(
      $(".dataItem02 .dataNums span").first().text(),
    );
    // const lastNetValue = parseFloat(
    //   $(".dataNums .ui-font-large.ui-color-red.ui-num").first().text()
    // );

    const holdings = [];

    // 定位持仓表格
    $("#position_shares table tr").each((i, el) => {
      if (i === 0) return;
      const cols = $(el).find("td");
      if (cols.length > 0) {
        const stockAnchor = $(cols[0]).find("a");
        const stockName = stockAnchor.text().trim();
        const stockHref = stockAnchor.attr("href") || "";
        const allStockRegex =
          /\b([A-Z]{1,5}(\.[A-Z]{1,2})?|(\d{5,6})(\.(HK|SH|SZ|BJ))?)\b/g;
        const codeMatch = stockHref.match(allStockRegex);

        if (codeMatch && stockName) {
          const stockCodeRaw = codeMatch[0];
          const percentage = parseFloat($(cols[1]).text().replace("%", ""));
          const prefix =
            stockCodeRaw.match(/\d{6}/) &&
            (stockCodeRaw.startsWith("6") || stockCodeRaw.startsWith("688"))
              ? "sh"
              : "sz";

          holdings.push({
            stockName,
            stockCode: prefix + stockCodeRaw,
            weight: percentage,
          });
        }
      }
    });
    return {
      holdings,
      lastNetValue,
      fundName,
      fundCode,
    };
  } catch (error) {
    console.error("获取基金持仓失败:", error.message);
    return {};
  }
}

// 2. 获取股票行情 (GBK解码)
async function getStocksRealtime(stockCodes) {
  if (stockCodes.length === 0) return {};
  const url = `http://hq.sinajs.cn/list=${stockCodes.join(",")}`;
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer", // 极其重要
      headers: {
        Referer: "http://finance.sina.com.cn",
        "User-Agent": "Mozilla/5.0",
      },
    });

    const data = iconv.decode(Buffer.from(response.data), "gbk");
    const lines = data.split("\n");
    const stockMap = {};

    lines.forEach((line) => {
      const match = line.match(/hq_str_(s[hz]\d+)=\"(.*)\"/);
      if (match) {
        const code = match[1];
        const params = match[2].split(",");
        if (params.length > 3) {
          const lastClose = parseFloat(params[2]);
          const current = parseFloat(params[3]);
          if (lastClose > 0 && current > 0) {
            stockMap[code] = ((current - lastClose) / lastClose) * 100;
          }
        }
      }
    });
    return stockMap;
  } catch (error) {
    console.error("获取行情失败:", error.message);
    return {};
  }
}

module.exports = { getFundHoldings, getStocksRealtime };
