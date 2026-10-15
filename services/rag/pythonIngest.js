const axios = require("axios");

const ingestUrl = () =>
  process.env.RAG_INGEST_URL || "http://127.0.0.1:9001/ingest";

const messageOf = (err) => {
  const detail = err.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (err.code === "ECONNREFUSED") return "Python 入库服务没有启动";
  if (err.code === "ECONNABORTED") return "Python 入库超时";
  return err.message || "调用 Python 入库失败";
};

/**
 * 入参是已入库的研报、版面页数、去目录后的段落。出参是 Python 返回的 doc 和 duplicate。
 * replace 为 true：入库、重切、重试都要带上。不带时，同一哈希已有文档会被当成重复，不再切块。
 * 切块和向量化在这次请求里同步做完，超时留 10 分钟。
 */
const postIngest = async (doc, pageCount, paragraphs) => {
  try {
    const response = await axios.post(
      ingestUrl(),
      {
        userId: doc.userId,
        fileHash: doc.fileHash,
        fileName: doc.fileName,
        filePath: doc.filePath || "",
        stockCode: doc.stockCode,
        stockName: doc.stockName,
        title: doc.title,
        org: doc.org,
        reportDate: doc.reportDate,
        maxChars: doc.maxChars,
        overlapParagraphs: doc.overlapParagraphs,
        pageCount,
        replace: true,
        paragraphs: paragraphs.map((paragraph) => ({
          text: paragraph.text,
          heading: paragraph.heading ?? null,
          kind: paragraph.kind || "text",
          page: paragraph.page,
        })),
      },
      {
        timeout: 10 * 60 * 1000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
    return response.data;
  } catch (err) {
    throw new Error(messageOf(err));
  }
};

module.exports = {
  postIngest,
  ingestUrl,
};
