const express = require("express");
const router = express.Router();
const {
  getPortfolioAdvice,
  client,
  tools,
  actions,
} = require("../services/ai");
const { ErrorModel } = require("../model/resModel");
const authMiddleware = require("../middleware/auth");

router.post("/analyze-portfolio", authMiddleware, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-chache");
  res.setHeader("Connnection", "keep-alive");
  try {
    const { funds, userNickname } = req.body;
    const stream = await getPortfolioAdvice(funds, userNickname);

    for await (const chunk of stream) {
      const content = chunk.choices[0].delta?.content || "";
      if (content) {
        // 实时发送数据到客户端
        res.write(content);
      }
    }
    res.end();
  } catch (err) {
    if (err.status === 402) {
      return res
        .status(200)
        .end("【系统提示】AI 助手暂时欠费了，请联系管理员充值或更换 API Key。");
    }
    console.log("ai-error: ", err);
    res.status(500).json(new ErrorModel(err.message || "AI服务异常"));
  }
});

router.post("/chat", authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.end("请输入您的问题");
  const userId = req.userId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const messages = [
    {
      role: "system",
      content: "你是一个理财助手。如果需要用户信息，请调用工具",
    },
    {
      role: "user",
      content: message,
    },
  ];

  try {
    let isToolCall = false;
    let isFirstChat = true;

    while (isFirstChat || isToolCall) {
      let toolCallId = "";
      let fullToolCallJson = "";
      let toolFunctionName = "";
      const stream = await client.chat.completions.create({
        model: "deepseek-chat",
        messages,
        tools,
        stream: true,
      });
      isToolCall = false;
      isFirstChat = false;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        console.log("delta: ", delta);
        if (delta.tool_calls) {
          isToolCall = true;
          const tc = delta.tool_calls[0];
          if (tc.id) toolCallId = tc.id;
          if (tc.function?.name) toolFunctionName = tc.function.name;
          if (tc.function?.arguments) fullToolCallJson += tc.function.arguments;
          res.write("[THINKING_SIGNAL]");
        } else if (delta.content) {
          res.write(delta.content);
        }
      }
      if (isToolCall) {
        const functionArgs = JSON.parse(fullToolCallJson || "{}");
        console.log(`执行工具：${toolFunctionName}`, functionArgs);

        const functionResponse = await actions[toolFunctionName](
          functionArgs,
          userId,
        );
        console.log("functionResponse: ", functionResponse);
        messages.push({
          role: "assistant",
          tool_calls: [
            {
              id: toolCallId,
              type: "function",
              function: {
                name: toolFunctionName,
                arguments: fullToolCallJson,
              },
            },
          ],
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: functionResponse,
        });
      } else {
        break;
      }
    }

    res.end();
  } catch (err) {
    console.error("chat-error:", err);
    res.end("ai暂时休息了，请稍后再试");
  }
});

module.exports = router;
