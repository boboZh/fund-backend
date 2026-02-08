const crawler = require("./crawler");

const invalid = (val) => !val && val !== 0;

/**
 * 估值及持仓盈亏点数计算规则
 * @param {*} portfolio
 * @returns
 */

async function getPortfolioReport(portfolio) {
  let totalAmount = 0; // 所有持仓金额
  let totalDailyProfit = 0; // 今日所有收益

  const list = [];

  for (const item of portfolio) {
    const realtimeData = await getEstimate(item.fundCode);
    if (!realtimeData) continue;
    const amount = parseFloat(item.amount);
    totalAmount += amount;

    if (invalid(realtimeData.estimatePercent)) {
      list.push({
        ...item,
        fundName: realtimeData.fundName,
        dailyProfit: "--",
        change: "--",
        lastNetValue: "--",
      });
      continue;
    }

    console.log("ampunt: ", realtimeData.estimatePercent, item.amount);

    const estimatePercent = parseFloat(realtimeData.estimatePercent);
    const dailyProfit = amount * (estimatePercent / 100);

    totalDailyProfit += dailyProfit;

    list.push({
      ...item,
      fundName: realtimeData.fundName,
      dailyProfit: dailyProfit.toFixed(2),
      change: realtimeData.estimatePercent + "%",
      lastNetValue: realtimeData.lastNetValue,
    });
  }

  return {
    summary: { totalAmount, totalDailyProfit },
    funds: list,
    timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
  };
}

async function getEstimate(fundCode) {
  const { holdings, lastNetValue, fundName } =
    await crawler.getFundHoldings(fundCode);

  // 没有拿到持仓股信息
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

  const stockCodes = holdings.map((h) => h.stockCode);
  const stockQuotes = await crawler.getStocksRealtime(stockCodes);

  let totalWeight = 0;
  let estimatedChange = 0;

  const details = holdings.map((stock) => {
    const change = stockQuotes[stock.stockCode] || 0;
    totalWeight += stock.weight;
    estimatedChange += change * stock.weight;
    return {
      stockName: stock.name,
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
