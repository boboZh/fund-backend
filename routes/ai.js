const express = require("express");
const router = express.Router();
const {
  getPortfolioAdvice,
  client,
  tools,
  actions,
  mergeResearchSources,
  citationsTrailer,
  briefResearchToolContent,
} = require("../services/ai");
const {
  sliceMessages,
  getSafeSplitIndex,
  sanitizeHistory,
} = require("../utils/tools");
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
const { signalContext } = require("../utils/context");

router.post("/chat", authMiddleware, async (req, res) => {
  let { message, sessionId, isRegenerate } = req.body;
  const userId = req.userId;

  // 这里报错形式待优化
  if (!message) return res.end("请输入您的问题");
  if (!sessionId) return res.status(400).json(new ErrorModel("无效sessionId"));
  // 防止代理服务器缓存：
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
        sessionHistory = sanitizeHistory(sessionHistory);
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
  if (sessionHistory.length > COMPRESS_THRESHOLD) {
    // 获取安全的切割点
    const safeSplitIndex = getSafeSplitIndex(sessionHistory, COMPRESS_COUNT);

    if (safeSplitIndex > 0) {
      // 截取需要压缩的历史消息
      const messagesToCompress = sessionHistory.slice(0, safeSplitIndex);

      // 调用ai生成新的摘要
      currentSummary = await generateMemorySummary(
        currentSummary,
        messagesToCompress
      );
      // 将新的摘要写入数据库
      await updateSessionSummary(sessionId, currentSummary);
      // 删除已压缩的历史记录
      deleteCompressedMessages(
        sessionId,
        messagesToCompress.map((item) => item.id)
      ).catch((err) => {
        console.error(`异步删除压缩消息失败：${sessionId}: `, err);
      });
      // 更新当前内存里的历史记录
      sessionHistory = sessionHistory.slice(safeSplitIndex);
    }
  }

  // 板块操作建议要先对用户自己的持仓做名称模糊匹配。
  // 研报工具若把「行业、产品」也写成必须先检索，这类问法会被研报抢走，对不上持仓基金。
  const systemPrompt = `你是一个高效、严谨的投资助手。优先完成用户的全部请求，不因某个工具未返回结果就终止整个任务。

一、任务拆分与工具调用
1. 当用户的问题包含多个指令时，识别并处理所有子任务。
2. 对于互不依赖的工具调用，务必在同一轮响应中输出所有必要的 tool_calls。
3. 如果后续调用依赖前一个工具的返回结果，先取得结果，再继续调用，直到完成所有可完成的任务。
4. 仅调用实际可用的工具，不得假装调用工具或编造工具结果。

二、板块、行业、主题或基金的操作建议
1. 当用户询问某个板块、行业、主题或基金如何操作，包括操作建议、加仓、减仓、能不能继续持有等，即使没有提到“我的持仓”，也必须先调用 get_user_portfolio。
2. 使用问题中的主题词，对返回的 fundName 做模糊匹配：
   - 名称包含主题词，算相关。
   - 主题词与名称有明显重叠，也算相关。例如，“半导体材料设备”可以匹配“半导体设备”“半导体”。
3. 只针对匹配到的相关基金给出持仓操作建议，不主动扩展到其他基金，不先检索研报。
4. 根据工具返回的持仓信息进行分析，不推断工具未提供的成本、收益、仓位或风险偏好。
5. 如果建议需要最新市场信息，在取得持仓后，调用可用的实时数据工具或联网搜索工具补充信息。
6. 如果未匹配到相关基金，明确说明当前返回的持仓中未找到相关基金。可以提供一般性的分析框架，但不得将其表述为针对用户持仓的操作建议。
7. 如果持仓工具调用失败，说明暂时无法取得持仓，继续回答不依赖持仓的部分。

三、公司财务数据及研报问题
1. 当用户询问某家公司的财务数字、评级、目标价、盈利预测或研报观点时，必须先调用 search_research_reports，不得直接凭记忆作答。
2. stockCode 是可选参数。问题中没有具体公司时省略它，仍然调用工具，不得声称工具只能查询某一家公司。
3. 对研报库中的内容，只能根据工具返回的片段回答。不得补充片段之外的数字、背景或机构观点。
4. 研报片段未包含所需内容时，明确说明“研报库里未找到相关内容”，然后按第四部分继续处理，不直接终止任务。
5. 多份研报观点不一致时，分别列出机构、日期及其观点或数字，不合成折中数字。
6. 区分公司已披露的实际数据与机构预测，不把预测表述为已经发生的事实。

四、研报库未命中或信息不足时的处理
根据问题类型选择后续路径：

1. 最新市场信息或可核实的客观事实
   - 调用可用的实时数据工具或联网搜索工具继续查证。
   - 优先采用公司公告、交易所披露、官方统计及其他可追溯来源。
   - 回答时说明信息日期、统计期间和必要的数据口径。
   - 外部来源的信息必须明确标注，不得伪装成研报库检索结果。

2. 评级、目标价、盈利预测或机构观点
   - 可以通过联网搜索查找对应机构公开发布的研报或可核实的公开信息。
   - 必须核实机构、发布日期及相关内容。
   - 如果仍未找到，明确说明无法核实，不使用模型记忆补齐，不自行生成机构评级、目标价或盈利预测。

3. 通用金融知识或分析性问题
   - 可以基于模型已有知识解释概念、分析机制或进行条件推理。
   - 明确区分已核实事实、分析假设和预测判断。
   - 不得将模型分析归因于某家机构或某份研报。
   - 涉及最新数据的前提，应先通过工具核实；无法核实时，用明确的条件假设表达。

4. 用户明确限定“只看研报库”或“只根据指定材料”
   - 遵守来源限制，不自行使用外部来源补充。
   - 回答已有材料能够支持的部分，并指出缺失内容。

5. 没有可用的替代工具，或补充检索后仍无法验证
   - 明确说明哪些内容未找到或无法核实。
   - 继续完成其他有依据的子任务，并在适用时提供不依赖缺失数据的分析框架。
   - 不编造实时数据、财务数字、来源或结论。

五、引用规则
1. 引用研报库片段时，在对应句末写 [1]、[2] 等，编号必须对应工具返回片段的 ref。
2. 不自行生成不存在的 ref，不把研报库编号用于外部来源或模型推理。
3. 引用实时工具或联网来源时，使用工具支持的引用格式或在相关句末附上来源链接。
4. 不在正文末尾另列来源清单。
5. 每条引用只支持其实际包含的信息，不扩大引用范围。

六、回答要求
1. 优先直接回答用户的问题，再简要说明依据和信息缺口。
2. 一个子任务检索失败，不影响其他子任务继续执行和回答。
3. 清楚区分研报观点、外部已核实信息与模型分析。
4. 对无法验证的实时信息明确表达不确定性，不编造，不以过时信息冒充最新信息。`;

  // 摘要作为长期记忆，拼接到系统提示词
  const finalSystemPrompt = currentSummary
    ? `${systemPrompt}\n\n【关于用户的长期记忆】：\n${currentSummary}`
    : systemPrompt;

  const messages = [
    {
      role: "system",
      content: finalSystemPrompt,
    },
    ...sessionHistory.map((item) => {
      const { id, ...rest } = item;
      return rest;
    }),
    {
      role: "user",
      content: message,
    },
  ];

  if (!isRegenerate) {
    // 用户消息存入聊天记录
    await saveUiMsg(sessionId, userId, "user", message);
  }

  let aiResponse = "";
  let finalStatus = "success";
  // 声明在 try 外面，finally 才能把这一轮的来源和正文一起落库。
  let sources = [];
  // let isUserMsgSavedToBrain = false;
  const brainMemoryBuffer = []; // 一个完整的会话，会话结束后再全部存入数据库
  const abortController = new AbortController();
  const { signal } = abortController;

  const aiResponseValid = (aiResponse) => aiResponse && aiResponse.trim();

  brainMemoryBuffer.push({
    fn: saveUserMessage,
    args: [sessionId, userId, message],
  });

  const handleClose = async () => {
    if (!res.writableEnded) {
      finalStatus = "abort";
      abortController.abort();
    }
  };

  // 监听前端主动断开连接（Abort）
  // req.on("close", async () => {
  //   console.log("用户主动终止对话");
  //   abortController.abort(); // 终止大模型计算和生成，节省token
  //   // 前端断开时，后端可能正在执行复杂的数据库写入或等待其他IO
  //   // 在这里直接调用async函数，可能会产生竞争条件，或者由于事务关闭导致失败
  //   if (aiResponse && aiResponse.trim()) {
  //     await saveUiMsg(sessionId, userId, "ai", aiResponse, "abort");
  //   }
  // });
  req.on("close", handleClose);
  req.on("aborted", handleClose);
  res.on("close", handleClose);

  try {
    let isToolCall = false;
    let isFirstChat = true;
    // 模型可能先检索再追问，同一轮里分多次调用。来源要跨这些调用累加，ref 才能连续。

    while (isFirstChat || isToolCall) {
      const toolCallMap = {}; // 每轮对话结束后，清空toolCallMap
      const stream = await client.chat.completions.create(
        {
          model: "deepseek-chat",
          messages,
          tools,
          stream: true,
          tool_choice: "auto",
        },
        {
          signal,
        }
      );
      isToolCall = false;
      isFirstChat = false;

      for await (const chunk of stream) {
        // if (!isUserMsgSavedToBrain) {
        //   await saveUserMessage(sessionId, userId, message);
        //   isUserMsgSavedToBrain = true;
        // }

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
        if (signal.aborted) throw new Error("AbortError");

        // everything inside this 'run' block can access the signal
        await signalContext.run(signal, async () => {
          const _toolCalls = Object.values(toolCallMap);

          // function calling
          const runTask = async (taskItem, index) => {
            if (signal.aborted) throw new Error("AbortError");

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
            _toolCalls.map((item, index) => runTask(item, index))
          );
          const merged = mergeResearchSources(
            sources,
            _toolCalls.map((toolCall, index) => ({
              name: toolCall.functionName,
              content: dataList[index],
            }))
          );
          sources = merged.sources;
          const toolContents = merged.contents;

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
          brainMemoryBuffer.push({
            fn: saveAssistantMessage,
            args: [sessionId, userId, "", assistantToolCalls],
          });
          // await saveAssistantMessage(sessionId, userId, "", assistantToolCalls);

          for (let index = 0; index < _toolCalls.length; index++) {
            const toolCall = _toolCalls[index];
            const { id } = toolCall;

            messages.push({
              role: "tool",
              tool_call_id: id,
              content: toolContents[index],
            });

            // 本轮模型看到全文。落库的是短文，下一轮才会把它当历史读回来。
            const storedContent =
              toolCall.functionName === "search_research_reports"
                ? briefResearchToolContent(toolContents[index])
                : toolContents[index];
            brainMemoryBuffer.push({
              fn: saveToolCallResultMessage,
              args: [sessionId, userId, storedContent, id],
            });
          }
        });
      } else {
        break;
      }
    }
    if (finalStatus === "success") {
      if (aiResponseValid(aiResponse)) {
        brainMemoryBuffer.push({
          fn: saveAssistantMessage,
          args: [sessionId, userId, aiResponse],
        });
        // 将完整的上下文对话批量存入数据库
        for (const task of brainMemoryBuffer) {
          try {
            await task.fn(...task.args);
          } catch (dbErr) {
            console.error("批量写入数据库失败，终止当前批次：", dbErr);
            throw dbErr;
          }
        }
      }

      // 不写进 aiResponse。落库的正文和步骤条都不带这段，解析器才能把它从正文里拆开。
      const trailer = citationsTrailer(sources);
      if (trailer && !res.writableEnded) res.write(trailer);

      res.end();
    }
  } catch (err) {
    if (err.name === "AbortError" || err.message?.includes("abort")) {
      finalStatus = "abort";
    } else {
      console.error("chat-error:", err);
      finalStatus = "error";
      if (err.status === 402 && !res.writableEnded) {
        return res.end(
          "\n【系统提示】AI 助手暂时欠费了，请联系管理员充值或更换 API Key。"
        );
      }

      if (!res.writableEnded) {
        res.end("ai暂时休息了，请稍后再试");
      }
    }
  } finally {
    req.off("close", handleClose);
    if (aiResponseValid(aiResponse)) {
      try {
        await saveUiMsg(
          sessionId,
          userId,
          "ai",
          aiResponse,
          finalStatus,
          sources
        );
      } catch (dbErr) {
        console.error("ui-ai-response-save-failed: ", dbErr);
      }
    }

    if (!res.writableEnded) {
      res.end();
    }

    brainMemoryBuffer.length = 0;
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
    res.end("AI服务异常");
  }
});

// 获取对话历史聊天记录-展示在ui层面的聊天记录
router.post("/message/list", authMiddleware, async (req, res) => {
  const { sessionId, page = 1, pageSize = 20 } = req.body;
  try {
    const result = await getUiMsgList(
      sessionId,
      parseInt(page),
      parseInt(pageSize)
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
