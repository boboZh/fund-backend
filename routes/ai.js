const express = require("express");
const router = express.Router();
const {
  getPortfolioAdvice,
  client,
  tools,
  actions,
} = require("../services/ai");
const { sliceMessages, getSafeSplitIndex } = require("../utils/tools");
const {
  getSessionMessages,
  saveAssistantMessage,
  saveUserMessage,
  saveToolCallResultMessage,
  checkSessionIdValid,
  createNewSession,
  generateTitleByFirstMsg,
  updateSessionTitle,
  getSessionList,
  saveUiMsg,
  getUiMsgList,
  deleteSingleSession,
  generateMemorySummary,
  updateSessionSummary,
  deleteCompressedMessages,
} = require("../controller/ai");
const { ErrorModel, SuccessModel } = require("../model/resModel");
const authMiddleware = require("../middleware/auth");

router.post("/chat", authMiddleware, async (req, res) => {
  let { message, sessionId } = req.body;
  const userId = req.userId;

  // 这里报错形式待优化
  if (!message) return res.end("请输入您的问题");
  if (!sessionId) return res.status(400).json(new ErrorModel("无效sessionId"));
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let sessionHistory = [];
  let currentSummary = "";
  if (sessionId) {
    try {
      const sessions = await checkSessionIdValid(sessionId, userId);
      if (sessions.length) {
        sessionHistory = await getSessionMessages(sessionId);
      } else {
        await createNewSession(sessionId, userId);
        generateTitleByFirstMsg(message).then(async (title) => {
          await updateSessionTitle(sessionId, title);
        });
      }
    } catch (err) {
      console.error("init-chat-error:", err);
    }
  } else {
    res.end();
  }

  // 当历史消息超过20条时，压缩前10条
  const COMPRESS_THRESHOLD = 20;
  const COMPRESS_COUNT = 10;
  console.log("sessionHistoryLength: ", sessionHistory.length);
  if (sessionHistory.length > COMPRESS_THRESHOLD) {
    // 获取安全的切割点
    const safeSplitIndex = getSafeSplitIndex(sessionHistory, COMPRESS_COUNT);

    if (safeSplitIndex > 0) {
      // 截取需要压缩的历史消息
      // const messagesToCompress = sessionHistory.slice(0, COMPRESS_COUNT);
      const messagesToCompress = sessionHistory.slice(0, safeSplitIndex);

      // 调用ai生成新的摘要
      currentSummary = await generateMemorySummary(
        currentSummary,
        messagesToCompress,
      );
      // 将新的摘要写入数据库
      await updateSessionSummary(sessionId, currentSummary);
      // 删除已压缩的历史记录
      deleteCompressedMessages(
        sessionId,
        messagesToCompress.map((item) => item.id),
      ).catch((err) => {
        console.error(`异步删除压缩消息失败：${sessionId}: `, err);
      });
      // 更新当前内存里的历史记录
      // sessionHistory = sessionHistory.slice(COMPRESS_COUNT);
      sessionHistory = sessionHistory.slice(safeSplitIndex);
    }
  }

  console.log("summary: ", currentSummary);

  const systemPrompt =
    "你是一个高效的投资助手。当用户的问题包含多个指令时，请务必在单词响应中输出所有必要的tool_calls";

  // 摘要作为长期记忆，拼接到系统提示词
  const finalSystemPrompt = currentSummary
    ? `${systemPrompt}\n\n【关于用户的长期记忆】：\n${currentSummary}`
    : systemPrompt;

  // const slicedMessages = sliceMessages(sessionHistory).map((item) => {
  //   const { id, ...rest } = item;
  //   return rest;
  // });

  const messages = [
    {
      role: "system",
      content: finalSystemPrompt,
    },
    ...sessionHistory.map((item) => {
      const { id, ...rest } = item;
      return rest;
    }),
    // ...slicedMessages,
    {
      role: "user",
      content: message,
    },
  ];

  // 用户消息存入聊天记录
  await saveUserMessage(sessionId, userId, message);
  await saveUiMsg(sessionId, userId, "user", message);

  let aiResponse = "";

  try {
    let isToolCall = false;
    let isFirstChat = true;

    while (isFirstChat || isToolCall) {
      const toolCallMap = {}; // 每轮对话结束后，清空toolCallMap
      const stream = await client.chat.completions.create({
        model: "deepseek-chat",
        messages,
        tools,
        stream: true,
        tool_choice: "auto",
      });
      isToolCall = false;
      isFirstChat = false;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (delta.tool_calls) {
          isToolCall = true;
          for (const tc of delta.tool_calls) {
            if (!toolCallMap[tc.index]) {
              toolCallMap[tc.index] = {
                json: "",
              };
            }
            if (tc?.id) {
              toolCallMap[tc.index].id = tc.id;
            }
            if (tc.function?.name) {
              toolCallMap[tc.index].functionName = tc.function.name;
            }
            if (tc.function?.arguments) {
              toolCallMap[tc.index].json += tc.function.arguments;
            }
            toolCallMap[tc.index].tc = tc;
          }
        } else if (delta.content) {
          aiResponse += delta.content;
          res.write(delta.content);
        }
      }
      if (isToolCall) {
        const _toolCalls = Object.values(toolCallMap);

        // function calling
        const runTask = async (taskItem, index) => {
          const { json, functionName, id } = taskItem;
          const functionArgs = JSON.parse(json || "{}");
          const { func, description, msgModel } = actions[functionName];
          const taskId = `task_${Date.now()}_${index}`;
          const _desc =
            typeof description === "function"
              ? description(functionArgs)
              : description;
          res.write(`[S:${taskId}:loading:${_desc}]`);
          try {
            const result = await func(functionArgs, userId);
            res.write(`[S:${taskId}:success:${msgModel(result)}]`);

            return result;
          } catch (err) {
            res.write(`[S:${taskId}:error:${description}出错]`);
            throw err;
          }
        };

        // 同时处理多个工具调用
        const dataList = await Promise.all(
          _toolCalls.map((item, index) => runTask(item, index)),
        );

        const assistantToolCalls = _toolCalls.map((toolCall) => {
          const { id, functionName, json, tc } = toolCall;

          return {
            type: "function",
            id,
            function: {
              name: functionName,
              arguments: json,
            },
          };
        });
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: assistantToolCalls,
        });
        await saveAssistantMessage(sessionId, userId, "", assistantToolCalls);

        for (let index = 0; index < _toolCalls.length; index++) {
          const toolCall = _toolCalls[index];
          const { id } = toolCall;

          messages.push({
            role: "tool",
            tool_call_id: id,
            content: dataList[index],
          });

          await saveToolCallResultMessage(
            sessionId,
            userId,
            dataList[index],
            id,
          );
        }
      } else {
        break;
      }
    }
    await saveAssistantMessage(sessionId, userId, aiResponse);
    await saveUiMsg(sessionId, userId, "ai", aiResponse);
    res.end();
  } catch (err) {
    console.error("chat-error:", err);
    res.end("ai暂时休息了，请稍后再试");
  }
});

router.post("/analyze-portfolio", authMiddleware, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-chache");
  res.setHeader("Connection", "keep-alive");
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
    console.error("ai-error: ", err);
    res.status(500).json(new ErrorModel(err.message || "AI服务异常"));
  }
});

// 获取对话历史聊天记录-展示在ui层面的聊天记录
router.post("/message/list", authMiddleware, async (req, res) => {
  const { sessionId, page = 1, pageSize = 20 } = req.body;
  try {
    const result = await getUiMsgList(
      sessionId,
      parseInt(page),
      parseInt(pageSize),
    );
    res.json(new SuccessModel(result));
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});
// 获取对话列表
router.get("/session/list", authMiddleware, async (req, res) => {
  const { userId } = req;
  try {
    const sessions = await getSessionList(userId);
    res.json(new SuccessModel(sessions));
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});
// 删除单个会话
router.post("/session/delete", authMiddleware, async (req, res) => {
  const { userId } = req;
  const { sessionId } = req.body;
  try {
    const result = await deleteSingleSession(sessionId, userId);
    if (result.affectedRows > 0) {
      res.json(new SuccessModel("会话删除成功"));
    } else {
      res.status(403).json(new ErrorModel("删除失败: 无权操作或会话不存在"));
    }
  } catch (err) {
    console.error(`delete-session-error-${sessionId}: `, err);
    res.status(500).json(new ErrorModel("服务器内部错误"));
  }
});

module.exports = router;
