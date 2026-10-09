const { OpenAI } = require("openai");
const {
  getPortfolio,
  getFundInfoByCode,
  setFundAlert,
} = require("../controller/fund");
const { retrieve, DEFAULT_MIN_SCORE } = require("./rag/retrieve");
const { signalContext } = require("../utils/context");

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});

const tools = [
  {
    type: "function",
    strict: true, // 对函数调用强制执行严格模式，保证模型生成的参数完全符合你的 JSON Schema
    function: {
      name: "get_fund_valuation",
      description: "获取特定基金代码的实时估值涨跌幅",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "基金代码",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    strict: true,
    function: {
      name: "set_fund_alert",
      description: "为特定基金设置止盈或止损预警点",
      parameters: {
        type: "object",
        properties: {
          fundCode: {
            type: "string",
            description: "基金代码",
          },
          targetProfitRate: {
            type: "number",
            description: "止盈点，如5.0代表5%",
          },
          stopLossRate: {
            type: "number",
            description: "止损点，如5.0代表5%",
          },
          applyAll: {
            type: "boolean",
            descript: "是否应用到所有持仓基金",
          },
        },
        required: ["code", "threshold", "type"],
      },
    },
  },
  {
    type: "function",
    strict: true,
    function: {
      name: "get_user_portfolio",
      description: "获取当前登录用户的所有基金持仓明细，包括基金代码和持仓金额",
      parameters: {
        type: "object",
        properties: {}, // 无需参数，服务端从session/cookie拿userId
      },
    },
  },
  {
    type: "function",
    // 不设 strict。DeepSeek 的严格模式要求每个字段都必填，stockCode 和 dateFrom 是可选的。
    function: {
      name: "search_research_reports",
      description:
        "检索当前用户已入库的公司研报。用户询问公司、行业、产品、财务数字、评级、目标价、盈利预测或观点时必须先调用，没有股票代码也要调用。这些内容不要凭记忆回答。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "必须是补全了指代的独立问题。用户问「那它的目标价呢」，要把「它」替换成上文的公司名再传过来。不要把代词原样传入。问题不指向某一家公司时，保持原问题，不要编造公司名。",
          },
          stockCode: {
            type: "string",
            description:
              "可选。六位股票代码。能确定公司时传入；没有公司或代码时省略此字段，检索会覆盖当前用户的全部研报。不要因为缺少代码而拒绝调用。",
          },
          dateFrom: {
            type: "string",
            description:
              "只看这一天及之后的研报，格式 YYYY-MM-DD。用户问最新研报时传入。",
          },
        },
        required: ["query"],
      },
    },
  },
];

/**
 * 入参是模型生成的 query、可选股票代码和起始日期，以及当前用户。
 * 出参是 JSON 字符串。命中片段按 ref 从 1 编号；一条都没有时是空数组。
 * 固定走混合检索、重排、topK 5 和评测定出的阈值。用户停止生成时，沿用这一轮请求的 AbortSignal。
 */
const searchResearchReports = async (args, userId) => {
  const query = String((args && args.query) || "").trim();
  if (!query) throw new Error("缺少检索问题");
  const result = await retrieve({
    query,
    userId,
    mode: "hybrid",
    rerank: true,
    topK: 5,
    minScore: DEFAULT_MIN_SCORE,
    stockCode: args.stockCode,
    dateFrom: args.dateFrom,
    signal: signalContext.getStore(),
  });
  const passages = result.hits.map((hit, index) => ({
    ref: index + 1,
    title: hit.title,
    org: hit.org,
    reportDate: hit.reportDate,
    page: hit.pageStart,
    heading: hit.heading,
    content: hit.content,
  }));
  return JSON.stringify(passages);
};

const actions = {
  get_user_portfolio: {
    func: async (args, userId) => {
      const summary = await getPortfolio(userId);
      return JSON.stringify({
        status: "success",
        data: summary.funds,
        info: "这是用户当前的最新持仓数据",
      });
    },
    description: "调取您的持仓数据",
    msgModel: (res) => {
      const { data } = JSON.parse(res);
      return `调取您的持仓数据成功，共查到您当前持有${data.length}只基金`;
    },
  },
  get_fund_valuation: {
    func: async (args, userId) => {
      const info = await getFundInfoByCode(args.code);
      return JSON.stringify(info);
    },
    description: (args) => `正在搜索基金${args.code}的详细信息...`,
    msgModel: (res) => {
      const { fundName, fundCode } = JSON.parse(res);
      return `查询基金${fundName}(${fundCode})的信息`;
    },
  },
  set_fund_alert: {
    func: async (args, userId) => {
      try {
        const { fundCode, targetProfitRate, stopLossRate, applyAll } = args;
        await setFundAlert(
          fundCode,
          targetProfitRate,
          stopLossRate,
          applyAll,
          userId
        );
        return JSON.stringify({
          status: "success",
          info: "设置成功",
          args,
        });
      } catch (err) {
        console.log("setFundAlertErrorFromAiService: ", err);
        return JSON.striongify({
          status: "failed",
          info: "设置失败，请稍后重试",
        });
      }
    },
    description: (args) =>
      `正在设置${args.fundCode}${args.applyAll ? "及您持仓中其它基金" : ""}的止盈止损预警信息...`,
    msgModel: (res) => {
      const {
        args: { fundCode, applyAll },
      } = JSON.parse(res);
      return `设置基金(${fundCode})${applyAll ? "及您持仓中其它基金" : ""}的止盈止损预警信息`;
    },
  },
  search_research_reports: {
    func: searchResearchReports,
    description: "正在检索公司研报",
    msgModel: (res) => {
      const rows = JSON.parse(res);
      if (!Array.isArray(rows) || rows.length === 0) return "研报库里没有找到相关内容";
      return `找到${rows.length}条相关研报片段`;
    },
  },
};

async function getChatResponse(userInput, userId) {
  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `你是一名理财Agent，如果需要用户信息，请调用工具`,
      },
      {
        role: "user",
        content: userInput,
      },
    ],
    stream: true,
    tools: tools,
  });

  const responseMessage = response.choices[0].message;
  const toolCalls = responseMessage.tool_calls;

  if (toolCalls) {
  } else {
    return response;
  }
}

// 2.0 问答交互，nodejs端要传入大量的持仓数据，浪费token
async function getChatResponse_2(userInput, fundData, userNickname) {
  const systemContext = `你是一位专业的基金投资顾问，
      当前用户昵称为${userNickname}。
      这是用户的持仓数据：${JSON.stringify(fundData)}。
      
      你的任务：
      1. 如果用户询问关于自己持仓的问题，请结合上述数据回答。
      2. 如果用户询问一般性投资问题（如黄金、大盘走势），请提供专业分析。
      3. 如果用户询问非投资类问题（如天气、闲聊），请礼貌回答并尝试引导回理财话题。
      4. 所有回答请使用Markdown格式，语气要专业且亲切。`;
  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemContext },
      { role: "user", content: userInput },
    ],
    stream: true,
  });

  return response;
}

// 初版：单向的喂数据回答分析
async function getPortfolioAdvice(fundData, userNickname) {
  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `你是一位专业的基金投资顾问，能够根据用户的持仓数据提供个性化的投资建议。请进行以下分析：
          1. 整体持仓分布是否合理（行业集中度、风险等级）。
          2. 针对当前盈利或亏损较大的基金给出操作建议（持有、加仓、减仓）。
          3. 给出一段简短的投资鼓励或风险警告。
          要求：语气专业且亲切，回答字数控制在 500 字以内。`,
      },
      {
        role: "user",
        content: `用户 [${userNickname}] 的持仓明细：${JSON.stringify(fundData)}请，分析现状并给出建议`,
      },
    ],
    stream: true,
  });

  return response;
}

module.exports = {
  getPortfolioAdvice,
  getChatResponse,
  client,
  tools,
  actions,
};
