const axios = require("axios");
const fs = require("fs");
const path = require("path");

class FundMapService {
  constructor() {
    this.fundList = []; // 原始数组
    this.fundMap = new Map(); // 名称 -> 代码 的快速映射
    this.isReady = false;
  }

  /**
   * 初始化：下载并解析 JS
   */
  async init() {
    try {
      console.log("正在加载天天基金全量数据...");
      const url = "http://fund.eastmoney.com/js/fundcode_search.js";
      const res = await axios.get(url);

      // 数据格式：var r = [["000001","HXCZHH","华夏成长混合","混合型-灵活","HUAXIACHENGZHANGHUNHE"],...]
      // 我们需要提取出中间的数组部分
      const rawData = res.data;
      const jsonStr = rawData.substring(
        rawData.indexOf("=") + 1,
        rawData.lastIndexOf(";"),
      );

      this.fundList = JSON.parse(jsonStr);

      // 构建映射表：名称 -> 代码
      this.fundList.forEach((item) => {
        const [code, , name, type, pinyin] = item;
        this.fundMap.set(name, code);
      });

      this.isReady = true;
      console.log(`✅ 基金全量数据加载完成，共计 ${this.fundList.length} 条。`);
    } catch (err) {
      console.error("❌ 加载基金全量数据失败:", err);
    } finally {
      // 无论成功失败，都在任务结束的时候开启一个24h的倒计时更新js文件
      setTimeout(() => this.init(), 24 * 50 * 60 * 1000);
    }
  }

  /**
   * 核心功能：通过名称搜索代码
   */
  // services/fundMapService.js 内部修改

  searchCodeByName(ocrName) {
    if (!this.isReady) return null;

    // 1. 第一优先级：精确匹配
    if (this.fundMap.has(ocrName)) {
      return { code: this.fundMap.get(ocrName), name: ocrName };
    }

    // 2. 第二优先级：高权重模糊匹配
    let bestMatch = null;
    let maxScore = 0;

    // 预处理 OCR 名称：去掉干扰项（可选）
    const cleanOcrName = ocrName.replace(/基金|主题|资产/g, "");

    for (const item of this.fundList) {
      const [code, , jsName] = item;

      // 计算分值：jsName 在 cleanOcrName 中出现的字符占比
      let score = 0;
      const jsNameArr = jsName.split("");

      // 计算 jsName 里的每一个字是否在 ocrName 里出现
      jsNameArr.forEach((char) => {
        if (ocrName.includes(char)) {
          score++;
        }
      });

      // 归一化分值 (匹配到的字符数 / JS名称总长度)
      const finalScore = score / jsName.length;

      // 如果匹配度超过 80% (阈值可调)，且比之前的更好
      if (finalScore > 0.8 && finalScore > maxScore) {
        maxScore = finalScore;
        bestMatch = { code, name: jsName, score: finalScore };
      }
    }

    // 3. 特殊处理：如果 OCR 结果里本来就带 6 位数字代码
    const codeMatch = ocrName.match(/\d{6}/);
    if (codeMatch) {
      const code = codeMatch[0];
      // 去 list 里反查这个 code 的准确名称
      const foundByCode = this.fundList.find((i) => i[0] === code);
      if (foundByCode) return { code: foundByCode[0], name: foundByCode[2] };
    }

    return bestMatch;
  }
}

// 导出单例
module.exports = new FundMapService();
