const portfolio = require("../data/portfolio.json");
const crawler = require("./crawler");

const invalid = (val) => !val && val !== 0;

async function getPortfolioReport() {
  let totalMarketValue = 0;
  let totalDailyProfit = 0;
  const list = [];

  for (const item of portfolio) {
    const realtimeData = await getEstimate(item.code);
    if (!realtimeData) continue;
    if (invalid(realtimeData.estimatePercent)) {
      list.push({
        name: realtimeData.fundName,
        code: item.code,
        shares: item.shares,
        marketValue: realtimeData.lastNetValue * item.shares,
        dailyProfit: "--",
        change: "--",
        lastNetValue: "--",
      });
      continue;
    }
    // 1. 计算当日估值后的单价
    const estimatedPrice =
      realtimeData.lastNetValue * (1 + realtimeData.estimatePercent / 100);

    // 2. 持仓金额 = 份额 * 最新估算单价
    // const marketValue = item.shares * estimatedPrice;
    // 2.持仓金额改为 用户实际数据
    const marketValue = item.marketValue;

    // 3. 当日盈利金额 = (份额 * 昨日净值) * 估算涨幅
    // const dailyProfit =
    //   item.shares *
    //   realtimeData.lastNetValue *
    //   (realtimeData.estimatePercent / 100);

    const dailyProfit = marketValue * (realtimeData.estimatePercent / 100);

    totalMarketValue += marketValue;
    totalDailyProfit += dailyProfit;

    list.push({
      name: realtimeData.fundName,
      code: item.code,
      shares: item.shares,
      marketValue: marketValue.toFixed(2),
      dailyProfit: dailyProfit.toFixed(2),
      change: realtimeData.estimatePercent + "%",
      lastNetValue: realtimeData.lastNetValue,
    });
  }

  return {
    summary: {
      totalValue: totalMarketValue.toFixed(2),
      totalDailyProfit: totalDailyProfit.toFixed(2),
    },
    funds: list,
    timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
  };
}

async function getEstimate(fundCode) {
  const { holdings, lastNetValue, fundName } =
    await crawler.getFundHoldings(fundCode);

  if (holdings.length === 0) {
    return {
      fundCode,
      fundName,
      timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
      estimatedChange: "--%",
      top10TotalWeight: "--%",
      details: [],
      estimatePercent: null,
      lastNetValue,
    };
  }

  const stockCodes = holdings.map((h) => h.code);
  const stockQuotes = await crawler.getStocksRealtime(stockCodes);

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

  return {
    fundCode,
    fundName,
    timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
    estimatedChange: finalEstimate + "%",
    top10TotalWeight: totalWeight.toFixed(2) + "%",
    details,
    estimatePercent: finalEstimate,
    lastNetValue,
  };
}

module.exports = {
  getEstimate,
  getPortfolioReport,
};
