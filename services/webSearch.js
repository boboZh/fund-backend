const axios = require("axios");
const { signalContext } = require("../utils/context");

const TIME_RANGES = new Set(["day", "week", "month", "year"]);

// 搜索失败也返回工具结果，让模型可以说明限制并使用已有证据继续回答。
// 不将供应商原始错误传给模型或日志，避免泄露请求头中的密钥。
const searchWeb = async (args = {}) => {
  const signal = signalContext.getStore();
  signal?.throwIfAborted();
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const failure = (message) => JSON.stringify({ status: "error", message, results: [] });
  if (!query || query.length > 1000) return failure("联网搜索问题须为1至1000个字符");
  if (args.timeRange !== undefined && !TIME_RANGES.has(args.timeRange)) {
    return failure("联网搜索时间范围无效");
  }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return failure("联网搜索尚未配置 TAVILY_API_KEY，请联系管理员配置后重试");

  try {
    const { data } = await axios.post(
      "https://api.tavily.com/search",
      {
        query,
        topic: "general",
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        include_published_date: true,
        ...(args.timeRange ? { time_range: args.timeRange } : {}),
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000, signal }
    );
    if (!Array.isArray(data?.results)) return failure("联网搜索服务返回异常，请稍后重试");
    const results = data.results.filter((row) => {
      if (!row || typeof row.content !== "string" || !row.content.trim()) return false;
      try {
        return ["http:", "https:"].includes(new URL(row.url).protocol);
      } catch {
        return false;
      }
    }).slice(0, 5).map((row) => ({
      title: String(row.title || row.url).slice(0, 300),
      url: row.url,
      publishedDate: row.published_date || null,
      content: row.content.slice(0, 2000),
    }));
    return JSON.stringify({ status: "success", searchedAt: new Date().toISOString(), results });
  } catch (err) {
    signal?.throwIfAborted();
    if (axios.isCancel(err) || err.name === "AbortError") throw err;
    return failure("联网搜索暂时失败，请稍后重试；本次未获取到网络信息");
  }
};

module.exports = { searchWeb };
