const { OpenAI } = require("openai");

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});

async function getChatResponse(userInput, fundData, userNickname) {
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

  console.log("AI response received: ", response);

  return response;
}

module.exports = {
  getPortfolioAdvice,
  getChatResponse,
};
