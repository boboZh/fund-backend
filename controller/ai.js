const { exec } = require("../db/mysql");
const { client } = require("../services/ai");

// 根据用户第一条消息生成对话标题
const generateTitleByFirstMsg = async (userFirstMessage) => {
  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content:
          "你是一个起名助手。请根据用户提供的一条对话内容，总结成一个10个字以内的简短标题，不要解释，直接输出标题",
      },
      {
        role: "user",
        content: userFirstMessage,
      },
    ],
    stream: false,
  });
  return response.choices[0].message.content.trim();
};

// 验证sessionId是否存在
const checkSessionIdValid = async (sessionId, userId) => {
  const result = await exec(
    `SELECT session_id FROM chat_sessions WHERE session_id = ? AND user_id = ?`,
    [sessionId, userId],
  );
  return result;
};

// 创建新会话
const createNewSession = async (sessionId, userId) => {
  return await exec(
    `INSERT INTO chat_sessions (session_id, user_id, title) VALUES (?, ?, ?)`,
    [sessionId, userId, "新对话"],
  );
};
// 更新会话标题
const updateSessionTitle = async (sessionId, title) => {
  return await exec(`UPDATE chat_sessions SET title = ? WHERE session_id = ?`, [
    title,
    sessionId,
  ]);
};

// 获取会话列表
const getSessionList = async (userId) => {
  return await exec(`SELECT * FROM chat_sessions WHERE user_id = ? `, [userId]);
};

// 获取sessionId对应的历史消息
const getSessionMessages = async (sessionId) => {
  const history = await exec(
    "SELECT * FROM chat_messages WHERE session_id = ?",
    [sessionId],
  );
  return (
    history?.map((msg) => {
      const obj = { role: msg.role };
      if (msg.role === "user") obj.content = msg.content;
      if (msg.role === "assistant") {
        if (msg.toolCalls) {
          // const rawCalls =
          //   typeof msg.toolCalls === "string"
          //     ? JSON.parse(msg.toolCalls)
          //     : msg.toolCalls;
          // obj.tool_calls = rawCalls.map((tc) => {
          //   return {
          //     id: tc.id,
          //     type: "function",
          //     function: {
          //       name: tc.function.name,
          //       arguments: tc.function.arguments || "{}", // openai限制arguments必须是个合法的json字符串
          //     },
          //   };
          // });
          obj.tool_calls = msg.toolCalls;
          obj.content = null; // 有工具调用时，工具设置为null
        } else {
          obj.content = msg.content;
        }
      }
      if (msg.role === "tool") {
        console.log("msg: ", msg);

        obj.content = msg.content;
        obj.tool_call_id = msg.toolCallId;
        obj.name = msg.functionName;
      }
      return obj;
    }) || []
  );
};
// 存储用户发的消息-ui层面,
const saveUiMsg = async (sessionId, userId, role, content) => {
  return await exec(
    `INSERT INTO chat_ui_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)`,
    [sessionId, userId, role, content],
  );
};
// 获取对话聊天记录
const getUiMsgList = async (sessionId) => {
  const history = await exec(
    `SELECT * FROM chat_ui_messages WHERE session_id = ?`,
    [sessionId],
  );
  return history || [];
};
// 存储user用户发的消息
const saveUserMessage = async (sessionId, userId, content) => {
  return await exec(
    `INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)`,
    [sessionId, userId, "user", content],
  );
};
// 存储Assistant消息
const saveAssistantMessage = async (
  sessionId,
  userId,
  content = "",
  toolcalls,
) => {
  if (toolcalls) {
    return await exec(
      `INSERT INTO chat_messages (session_id, user_id, role, tool_calls, content) VALUES (?, ?, ?, ?, ?)`,
      [
        sessionId,
        userId,
        "assistant",
        typeof toolcalls === "object" ? JSON.stringify(toolcalls) : toolcalls,
        "",
      ],
    ); //toolcalls如果是对象类型，必须转为JSON.stringify(toolcalls) mysql2驱动在发送数据给MySQL之前，必须把JS对象/数组转成字符串，通常是调用对象的toString(), 结果会变成"[object Object]",MySQL会报错，因为"[object Object]"不符合JSON格式要求，无法存入JSON类型的字段
  } else {
    return await exec(
      `INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)`,
      [sessionId, userId, "assistant", content],
    );
  }
};
// 存储tool工具调用响应消息
const saveToolCallResultMessage = async (
  sessionId,
  userId,
  content,
  toolCallId,
) => {
  return await exec(
    `INSERT INTO chat_messages (session_id, user_id, role, content, tool_call_id) VALUES (?, ?, ?, ?, ?)`,
    [
      sessionId,
      userId,
      "tool",
      typeof content === "object" ? JSON.stringify(content) : content,
      toolCallId,
    ],
  );
};
// 删除单个会话
const deleteSingleSession = async (sessionId, userId) => {
  return await exec(
    `DELETE FROM chat_sessions WHERE session_id = ? AND user_id = ?`,
    [sessionId, userId],
  );
};

module.exports = {
  generateTitleByFirstMsg,
  checkSessionIdValid,
  createNewSession,
  updateSessionTitle,
  getSessionMessages,
  saveUserMessage,
  saveAssistantMessage,
  saveToolCallResultMessage,
  getSessionList,
  saveUiMsg,
  getUiMsgList,
  deleteSingleSession,
};
