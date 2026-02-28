// 优化 上下文token消耗
/**
 * 滑动窗口两种方案：
 * 方案一：按照消息的长度进行截取
 * 方案二：按照token的长度截取
 * 两种方案截取后，都要对数据的头部和尾部做合法清洗。都会不可避免地丢失上下文。
 *
 * 以下按照消息长度截取
 * 使用滑动窗口策略，保留最近N轮对话，清洗头部和尾部，保证tool_calls后面跟随的tool的数量和tool_calls长度一致
 */
const MAX_HISTORY_LENGTH = 10;
export const sliceMessages = (
  messages,
  maxHistoryLength = MAX_HISTORY_LENGTH,
) => {
  let result = messages.slice(-maxHistoryLength);

  // 处理头部
  while (result.length > 0 && result[0].role === "tool") {
    result.shift(); // 移除数组第一个元素
  }

  if (result.length === 0) return result;

  // 处理尾部
  const lastOne = result[result.length - 1];

  const getRecentAssistant = (list, index) => {
    while (index >= 0) {
      if (list[index].role === "assistant") return index;
      index--;
    }
    return -1;
  };

  if (lastOne.role === "tool") {
    const assistantIdx = getRecentAssistant(result, result.length - 1);
    if (assistantIdx === -1) {
      while (result.length > 0 && result[result.length - 1].role === "tool") {
        result.pop();
      }
      return result;
    }
    const { tool_calls } = result[assistantIdx];
    if (tool_calls.length === result.length - 1 - assistantIdx) {
      return result;
    } else {
      return assistantIdx > 1 ? result.slice(0, assistantIdx - 1) : [];
    }
  } else if (lastOne.role === "assistant" && lastOne.tool_calls) {
    return result.slice(0, -1);
  }
  return result;
};

// 动态寻找安全切割点， 防止一刀切，漏掉中间重要业务信息
export const getSafeSplitIndex = (messages, targetIndex) => {
  let safeIndex = targetIndex;

  if (safeIndex >= messages.length || safeIndex <= 0) return safeIndex;

  while (
    safeIndex >= 0 &&
    (messages[safeIndex].role === "tool" ||
      (messages[safeIndex - 1] &&
        messages[safeIndex - 1].role === "assistant" &&
        messages[safeIndex - 1].tool_calls))
  ) {
    safeIndex--;
  }

  return safeIndex;
};

// 清洗数据，防止存储过程报错，存入了不完整的ai上下文
export const sanitizeHistory = (messages) => {
  if (messages.length === 0) return messages;

  while (true) {
    const lastMsg = messages[messages.length - 1];
    if (
      lastMsg.role === "assistant" &&
      lastMsg.tool_calls &&
      lastMsg.tool_calls.length > 0
    ) {
      messages.pop();
    } else {
      break;
    }
  }
  return messages;
};
