const AipOcrClient = require("baidu-aip-sdk").ocr;
const fs = require("fs");
const fundMapService = require("./fundMap");

// 百度控制台获取的密钥
const APP_ID = 7425498;
const API_KEY = "IdQYfqDXQCqNTICGIPuBfEWC";
const SECRET_KEY = "3PVmhxh5wooE4JDfXISXCiCPMLj6L44f";

const client = new AipOcrClient(APP_ID, API_KEY, SECRET_KEY);

/**
 * 解析支付宝截图
 */
async function parseScreenshot(imagePath) {
  const image = fs.readFileSync(imagePath).toString("base64");

  try {
    const result = await client.generalBasic(image);
    const words = result.words_result.map((item) => item.words);

    // 逻辑：寻找基金名称和金额
    // 支付宝特征：基金名称下面通常紧跟着金额数字
    const parsedData = parseAlipayOCR(words);

    return parsedData;
  } catch (err) {
    console.error("OCR 解析失败:", err);
    throw err;
  }
}

function parseAlipayOCR(words) {
  const results = [];
  const processedIndices = new Set();

  // 1. 正则定义
  const amountRegex = /^[+-]?\d{1,3}(,\d{3})*\.\d{2}$/; // 匹配金额格式
  const codeRegex = /\d{6}/; // 匹配 6位代码
  const rateRegex = /^[+-]?\d+(\.\d+)?%$/; // 匹配百分比

  // 2. 强化噪音库：精准剔除图表和导航干扰
  const noiseList = [
    "金额排序",
    "昨日收益",
    "持有收益",
    "收益率",
    "中高风险",
    "中风险",
    "低风险",
    "蚂小财",
    "讨论区",
    "诊基",
    "业绩走势",
    "累计收益",
    "市场解读",
    "基金经理",
    "自选",
    "持有",
    "机会",
    "基金市场",
    "资产详情",
    "全部",
    "金额（元）",
    "昨日收益（元）",
    "累计盈亏",
    "收益明细",
    "交易记录",
    "投资计划",
    "01-",
    "02-",
    "03-",
    "04-",
    "05-",
    "06-",
    "07-",
    "08-",
    "09-",
    "10-",
    "11-",
    "12-", // 过滤日期和图表轴
  ];

  const isNoise = (text) => noiseList.some((noise) => text.includes(noise));

  const isArtifact = (text) => {
    if (!text) return false;
    const navIcons = ["四", "因", "◆", ">", "》", "包", "田", "⊙", "·"];
    return (
      (text.length === 1 && navIcons.includes(text)) ||
      /^[\u25A0-\u25FF◆]+$/.test(text) ||
      /^\d{1,2}$/.test(text)
    );
  };

  for (let i = 0; i < words.length; i++) {
    if (processedIndices.has(i)) continue;
    const current = words[i].trim();

    // --- 模式 A：资产详情页模式 (场景1) ---
    // 核心修复：匹配代码行时，不检查 isNoise，因为代码行通常包含“中高风险”
    if (codeRegex.test(current)) {
      const code = current.match(codeRegex)[0];
      let name = "";

      // A1. 向上找名称：找最近的一个不是噪音且有长度的行
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const pName = words[j].trim();
        if (pName.length > 4 && !isNoise(pName) && !isArtifact(pName)) {
          name = pName;
          break;
        }
      }

      // A2. 向下找金额：找最近的一个有效的非零金额
      let amount = 0;
      for (let k = i + 1; k < Math.min(i + 10, words.length); k++) {
        if (amountRegex.test(words[k])) {
          const val = parseFloat(words[k].replace(/,/g, ""));
          if (val !== 0) {
            amount = val;
            break;
          }
        }
      }

      if (name && amount) {
        results.push({ name, code, amount, source: "Detail_Page" });
        // 标记该区域已处理，防止被模式B重复识别
        for (
          let m = Math.max(0, i - 1);
          m < Math.min(words.length, i + 6);
          m++
        ) {
          processedIndices.add(m);
        }
        continue;
      }
    }

    // --- 模式 B：持仓列表页模式 ---
    if (amountRegex.test(current) && !processedIndices.has(i)) {
      const amount = parseFloat(current.replace(/,/g, ""));

      // 重要：持仓金额（主锚点）不可能是 0.00
      // 如果是 0.00，它一定是“昨日收益”或图表垃圾数据，直接跳过
      if (amount === 0) continue;

      // 过滤掉类似 -93.57 这种出现在“累计收益”附近的图表数据
      if (i > 0 && isNoise(words[i - 1])) continue;

      let name1 = "";
      if (i > 0 && !amountRegex.test(words[i - 1]) && !isNoise(words[i - 1])) {
        name1 = words[i - 1].trim();
      }

      let name2 = "";
      const part2 = words[i + 2] ? words[i + 2].trim() : "";
      if (
        part2 &&
        part2.length < 15 &&
        !amountRegex.test(part2) &&
        !rateRegex.test(part2) &&
        !isArtifact(part2) &&
        !isNoise(part2) &&
        part2 !== "0.00"
      ) {
        name2 = part2;
      }

      let fullName = (name1 + name2).trim();
      while (fullName.length > 0 && isArtifact(fullName.slice(-1))) {
        fullName = fullName.slice(0, -1);
      }

      // 过滤掉包含日期的伪名称（如 基金01-）
      if (
        fullName.length >= 4 &&
        !isNoise(fullName) &&
        !/\d{2}-/.test(fullName)
      ) {
        results.push({
          name: fullName,
          amount: amount,
          code: extractCode(fullName) || "",
          source: "List_Page",
        });
        processedIndices.add(i);
      }
    }
  }

  const _results = deduplicate(results);

  console.log("resutlL ", _results);
  return _results.map((item) => {
    if (!item.code) {
      let matched = fundMapService.searchCodeByName(item.name);
      if (matched) {
        item.code = matched.code;
        item.name = matched.name;
      }
    }
    return item;
  });
}

function extractCode(text) {
  const m = text.match(/\d{6}/);
  return m ? m[0] : "";
}

function deduplicate(arr) {
  const map = new Map();
  for (const item of arr) {
    const key = item.name + item.amount.toFixed(2);
    if (!map.has(key)) map.set(key, item);
  }
  return Array.from(map.values());
}
module.exports = { parseScreenshot };
