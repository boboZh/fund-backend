const axios = require("axios");

jest.mock("axios", () => ({
  post: jest.fn(),
}));

const { postIngest } = require("./pythonIngest");

const doc = {
  userId: 1,
  fileHash: "a".repeat(32),
  fileName: "广汇能源.pdf",
  filePath: "public/uploads/research/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf",
  stockCode: "600256",
  stockName: "广汇能源",
  title: "公司深度报告",
  org: "开源证券",
  reportDate: "2026-10-05",
  maxChars: 800,
  overlapParagraphs: 1,
};

const paragraphs = [
  { text: "目标价上调到25元。", heading: "估值", kind: "text", page: 7 },
];

beforeEach(() => {
  axios.post.mockReset();
  delete process.env.RAG_INGEST_URL;
});

test("把段落交给 Python /ingest，并在已有文档上重切", async () => {
  axios.post.mockResolvedValue({
    data: { duplicate: false, doc: { id: 7, status: "embedded" } },
  });

  const result = await postIngest(doc, 12, paragraphs);

  expect(result.doc.status).toBe("embedded");
  expect(axios.post).toHaveBeenCalledWith(
    "http://127.0.0.1:9001/ingest",
    {
      userId: 1,
      fileHash: doc.fileHash,
      fileName: doc.fileName,
      filePath: doc.filePath,
      stockCode: "600256",
      stockName: "广汇能源",
      title: "公司深度报告",
      org: "开源证券",
      reportDate: "2026-10-05",
      maxChars: 800,
      overlapParagraphs: 1,
      pageCount: 12,
      replace: true,
      paragraphs,
    },
    expect.objectContaining({ timeout: 10 * 60 * 1000 })
  );
});

test("服务没启动时抛出可写入 error_msg 的错误", async () => {
  const err = new Error("connect ECONNREFUSED");
  err.code = "ECONNREFUSED";
  axios.post.mockRejectedValue(err);
  await expect(postIngest(doc, 1, paragraphs)).rejects.toThrow(
    "Python 入库服务没有启动"
  );
});
