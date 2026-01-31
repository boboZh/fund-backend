const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");

const app = express();
const PORT = 3000;

// 设置 Express 全局响应头，确保浏览器以 UTF-8 解析
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

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
    console.log("$: ", $);
    const holdings = [];
    // 定位持仓表格
    $("#position_shares table tr").each((i, el) => {
      if (i === 0) return;
      const cols = $(el).find("td");
      if (cols.length > 0) {
        const stockAnchor = $(cols[0]).find("a");
        const stockName = stockAnchor.text().trim();
        const stockHref = stockAnchor.attr("href") || "";
        const codeMatch = stockHref.match(/\d{6}/);

        if (codeMatch && stockName) {
          const stockCodeRaw = codeMatch[0];
          const percentage = parseFloat($(cols[1]).text().replace("%", ""));
          const prefix =
            stockCodeRaw.startsWith("6") || stockCodeRaw.startsWith("688")
              ? "sh"
              : "sz";

          holdings.push({
            name: stockName,
            code: prefix + stockCodeRaw,
            weight: percentage,
          });
        }
      }
    });
    return holdings;
  } catch (error) {
    console.error("获取持仓失败:", error.message);
    return [];
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

app.get("/estimate/:code", async (req, res) => {
  const fundCode = req.params.code;
  const holdings = await getFundHoldings(fundCode);

  if (holdings.length === 0) {
    return res
      .status(404)
      .json({ error: "未能获取持仓数据，请检查基金代码是否正确" });
  }

  const stockCodes = holdings.map((h) => h.code);
  const stockQuotes = await getStocksRealtime(stockCodes);

  let totalWeight = 0;
  let estimatedChange = 0;

  const details = holdings.map((stock) => {
    const change = stockQuotes[stock.code] || 0;
    totalWeight += stock.weight;
    estimatedChange += change * stock.weight;
    return {
      name: stock.name,
      weight: stock.weight.toFixed(2) + "%",
      realtimeChange: change.toFixed(2) + "%",
    };
  });

  // 结果归一化
  const finalEstimate =
    totalWeight > 0 ? (estimatedChange / totalWeight).toFixed(2) : "0.00";

  res.json({
    fundCode,
    fundName: "基金实时估值 (基于前十大持仓)",
    timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
    estimatedChange: finalEstimate + "%",
    top10TotalWeight: totalWeight.toFixed(2) + "%",
    details,
  });
});

app.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
});
