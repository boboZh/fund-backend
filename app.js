const express = require("express");
const cors = require("cors");

const calculator = require("./services/calculator");
const crawler = require("./services/crawler");

const app = express();
const PORT = 3000;

app.use(cors()); // 允许所有来源访问

// 设置 Express 全局响应头，确保浏览器以 UTF-8 解析
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// 获取单个基金的持仓数据和实时估值
app.get("/api/estimate/:code", async (req, res) => {
  const fundCode = req.params.code;
  try {
    const estimateResult = await calculator.getEstimate(fundCode);
    res.json(estimateResult);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取所有持仓数据
app.get("/api/portfolio", async (req, res) => {
  try {
    const report = await calculator.getPortfolioReport();
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取基金信息
app.get("/api/fund-info/:code", async (req, res) => {
  const fundCode = req.params.code;
  try {
    const fundInfo = await crawler.getFundHoldings(fundCode);
    res.json(fundInfo);
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
});
