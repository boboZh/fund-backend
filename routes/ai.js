const express = require("express");
const router = express.Router();
const {
  getPortfolioAdvice,
  client,
  tools,
  actions,
} = require("../services/ai");
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
} = require("../controller/ai");
const { ErrorModel, SuccessModel } = require("../model/resModel");
const authMiddleware = require("../middleware/auth");

router.post("/chat", authMiddleware, async (req, res) => {
  let { message, sessionId } = req.body;
  const userId = req.userId;

  console.log("sessionid: ", sessionId);
  // 这里报错形式待优化
  if (!message) return res.end("请输入您的问题");
  if (!sessionId) return res.status(400).json(new ErrorModel("无效sessionId"));
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let sessionHistory = [];
  if (sessionId) {
    try {
      const sessions = await checkSessionIdValid(sessionId, userId);
      if (sessions.length) {
        sessionHistory = await getSessionMessages(sessionId);
      } else {
        await createNewSession(sessionId, userId);
        generateTitleByFirstMsg(message).then(async (title) => {
          console.log("generate title: ", title);
          await updateSessionTitle(sessionId, title);
        });
      }
    } catch (err) {
      console.log("init-chat-error:", err);
    }
  } else {
    res.end();
  }

  const messages = [
    {
      role: "system",
      content:
        "你是一个高效的投资助手。当用户的问题包含多个指令时，请务必在单词响应中输出所有必要的tool_calls",
    },
    ...sessionHistory,
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
      console.log("messages: ", messages);
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
            console.log("tc: ", tc);
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
        console.log("fullToolCall：", toolCallMap);

        const _toolCalls = Object.values(toolCallMap);

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

        console.log("toolCalls: ", JSON.stringify(_toolCalls));

        _toolCalls.map(async (toolCall, index) => {
          const { id, functionName, json, tc } = toolCall;

          messages.push({
            role: "assistant",
            // ...tc,
            tool_calls: [
              {
                type: "function",
                id,
                function: {
                  name: functionName,
                  arguments: json,
                },
              },
            ],
          });
          await saveAssistantMessage(sessionId, userId, "", [
            {
              type: "function",
              id,
              function: {
                name: functionName,
                arguments: json,
              },
            },
          ]);

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
        });

        // messages.push({
        //   role: "assistant",
        //   tool_calls: _toolCalls.map(async (item) => {
        //     // await saveAssistantMessage(sessionId, userId, "", delta.tool_calls);

        //     const { id, functionName, json } = item;
        //     return {
        //       id,
        //       type: "function",
        //       function: {
        //         name: functionName,
        //         arguments: json,
        //       },
        //     };
        //   }),
        // });
        // dataList.map(async (item, index) => {
        //   const { id, functionName } = _toolCalls[index];
        //   messages.push({
        //     role: "tool",
        //     tool_call_id: id,
        //     content: item,
        //   });
        //   // await saveToolCallResultMessage(sessionId, userId, item, id);
        // });
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
    console.log("ai-error: ", err);
    res.status(500).json(new ErrorModel(err.message || "AI服务异常"));
  }
});

// 获取对话历史聊天记录-展示在ui层面的聊天记录
router.get("/message/list", authMiddleware, async (req, res) => {
  const { sessionId } = req.query;
  try {
    const history = await getUiMsgList(sessionId);
    res.json(new SuccessModel(history));
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
    console.log(`delete-session-error-${sessionId}: `, err);
    res.status(500).json(new ErrorModel("服务器内部错误"));
  }
});

module.exports = router;
