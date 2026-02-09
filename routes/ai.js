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
const { writeStatus } = require("../utils/tools");

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
      content:
        "你是一个高效的投资助手。当用户的问题包含多个指令时，请务必在单词响应中输出所有必要的tool_calls",
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
          console.log("delta: ", delta.tool_calls);
        }
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
          }
        } else if (delta.content) {
          res.write(delta.content);
        }
      }
      if (isToolCall) {
        console.log("fullToolCall：", toolCallMap);

        const _toolCalls = Object.values(toolCallMap);

        const runTask = async (taskItem, index) => {
          const { json, functionName } = taskItem;
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

        messages.push({
          role: "assistant",
          tool_calls: _toolCalls.map((item) => {
            const { id, functionName, json } = item;
            return {
              id,
              type: "function",
              function: {
                name: functionName,
                arguments: json,
              },
            };
          }),
        });
        dataList.map((item, index) => {
          const { id } = _toolCalls[index];
          messages.push({
            role: "tool",
            tool_call_id: id,
            content: item,
          });
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
