const { exec } = require("../db/mysql");
const { getFundHoldings } = require("../services/crawler");
const { getPortfolioReport } = require("../services/calculator");
const { parseImgInfo } = require("../services/ocr");
const fs = require("fs");

// 根据基金代码获取基金信息
const getFundInfoByCode = async (fundCode) => {
  const info = await getFundHoldings(fundCode);
  return info;
};

/**
 * 单个导入持有基金
 */
const addFund = async (userId, fundCode, amount) => {
  const sql = `
    INSERT INTO portfolios (user_id, fund_code, amount) 
    VALUES (?, ?, ?) 
    ON DUPLICATE KEY UPDATE amount = VALUES(amount)
  `;
  return await exec(sql, [userId, fundCode, amount]);
};

/**
 * 批量导入持有基金
 */
const batchAddFund = async (userId, fundList) => {
  // fundList 格式: [{ code: '001508', amount: 500 }, { code: '005827', amount: 1000 }]
  const sql = `
    INSERT INTO portfolios (user_id, fund_code, amount) 
    VALUES (?, ?, ?) 
    ON DUPLICATE KEY UPDATE amount = VALUES(amount)
  `;

  const promises = fundList.map((item) =>
    exec(sql, [userId, item.code, item.amount]),
  );

  return await Promise.all(promises);
};

/**
 * 修改单个持仓金额
 */
const modifyFundAmount = async (userId, fundCode, amount) => {
  const sql = `
    UPDATE portfolios 
    SET amount = ? 
    WHERE user_id = ? AND fund_code = ?
  `;
  const result = await exec(sql, [amount, userId, fundCode]);
  return result.affectedRows > 0; // 返回是否修改成功
};

/**
 * 批量修改持仓金额
 */
const batchModifyFundAmount = async (userId, funds) => {};

/**
 * 删除单个基金
 */
const deleteFund = async (userId, fundCode) => {
  const sql = `
    DELETE FROM portfolios 
    WHERE user_id = ? AND fund_code = ?
  `;
  const result = await exec(sql, [userId, fundCode]);
  return result.affectedRows > 0;
};

/**
 * 批量删除持有基金
 */
const batchDeleteFund = async (userId, fundCodes) => {
  // fundCodes 格式: ['001508', '005827', '000001']
  if (!fundCodes || fundCodes.length === 0) return 0;

  // mysql2 处理 IN 的特殊方式：使用 [fundCodes] 传入数组
  const sql = `
    DELETE FROM portfolios 
    WHERE user_id = ? AND fund_code IN (?)
  `;
  const result = await exec(sql, [userId, fundCodes]);
  return result.affectedRows; // 返回删除了多少行
};

/**
 * 获取持仓统计信息
 */
const getPortfolio = async (userId) => {
  const sql = `
        SELECT fund_code, amount, target_profit_rate, stop_loss_rate, updated_at 
        FROM portfolios 
        WHERE user_id = ? 
        ORDER BY updated_at DESC
    `;
  const list = await exec(sql, [userId]);
  /**
   *
   */
  const report = await getPortfolioReport(list);

  return report;
};

// 图片识别
const ocrAnalyze = async (file) => {
  // 解析图片信息
  const data = await parseImgInfo(file.path);
  // 清理临时文件
  fs.unlinkSync(file.path);

  return data;
};

// 设置预警信息
const setFundAlert = async (
  fundCode,
  targetProfitRate,
  stopLossRate,
  applyAll = false,
  userId,
) => {
  let result;
  if (applyAll) {
    // 应用到全部
    const sql = `
        UPDATE portfolios 
        SET target_profit_rate = ?, stop_loss_rate = ? 
        WHERE user_id = ?
      `;
    result = await exec(sql, [targetProfitRate, stopLossRate]);
  } else {
    // 仅设置单项
    const sql = `
        UPDATE portfolios 
        SET target_profit_rate = ?, stop_loss_rate = ? 
        WHERE user_id = ? AND fund_code = ?
      `;
    result = await exec(sql, [
      targetProfitRate,
      stopLossRate,
      userId,
      fundCode,
    ]);
  }
  return result.affectedRows;
};

module.exports = {
  getFundInfoByCode,
  addFund,
  batchAddFund,
  deleteFund,
  batchDeleteFund,
  getPortfolio,
  modifyFundAmount,
  batchModifyFundAmount,
  ocrAnalyze,
  setFundAlert,
};
