const express = require("express");
const router = express.Router();
const { getPortfolioAdvice, getChatResponse } = require("../services/ai");
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
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const { message, funds, userNickname } = req.body;
    if (!message) return res.end("请输入您的问题");

    const stream = await getChatResponse(message, funds, userNickname);
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        res.write(content);
      }
    }
    res.end();
  } catch (err) {
    console.error("chat-error:", err);
    res.end("ai暂时休息了，请稍后再试");
  }
});

module.exports = router;
