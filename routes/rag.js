const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const fse = require("fs-extra");
const authMiddleware = require("../middleware/auth");
const { SuccessModel, ErrorModel } = require("../model/resModel");
const { parsePdfBuffer } = require("../services/rag/parsePdf");
const { parseResearchMeta } = require("../services/rag/meta");
const { RESEARCH_DIR, pdfPathOf } = require("../services/rag/paths");
const store = require("../services/rag/store");
const { ingestDoc, readDropped } = require("../services/rag/ingest");

const router = express.Router();
fse.ensureDirSync(RESEARCH_DIR);

const HASH_RE = /^[a-f0-9]{32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const pdfUpload = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json(new ErrorModel("PDF 不能超过 20MB"));
    }
    return res.status(400).json(new ErrorModel(err.message || "上传失败"));
  });
};

const decodeFileName = (name = "") => {
  if (/[\u4e00-\u9fa5]/.test(name)) return name;
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  if (/[\u4e00-\u9fa5]/.test(decoded)) return decoded;
  return name;
};

const clampNumber = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const readMeta = (body) => {
  const stockCode = String(body.stockCode || "").trim();
  const stockName = String(body.stockName || "").trim();
  const title = String(body.title || "").trim();
  const org = String(body.org || "").trim();
  const reportDate = String(body.reportDate || "").trim();
  if (!/^\d{6}$/.test(stockCode)) return "股票代码需要是 6 位数字";
  if (!stockName || stockName.length > 50) return "请填写股票名称";
  if (!title || title.length > 255) return "请填写研报标题";
  if (!org || org.length > 100) return "请填写机构";
  if (
    !DATE_RE.test(reportDate) ||
    Number.isNaN(new Date(`${reportDate}T00:00:00Z`).getTime())
  ) {
    return "请填写有效的报告日期";
  }
  const [year, month, day] = reportDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return "请填写有效的报告日期";
  }
  return {
    stockCode,
    stockName,
    title,
    org,
    reportDate,
    maxChars: clampNumber(body.maxChars, 400, 1200, 800),
    overlapParagraphs: Number(body.overlapParagraphs) === 0 ? 0 : 1,
  };
};

router.post("/preview", authMiddleware, pdfUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json(new ErrorModel("请上传 PDF"));
    const fileName = decodeFileName(req.file.originalname);
    if (!fileName.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json(new ErrorModel("只支持 PDF"));
    }
    const fileHash = crypto
      .createHash("md5")
      .update(req.file.buffer)
      .digest("hex");
    await fse.writeFile(pdfPathOf(fileHash), req.file.buffer);

    const parsed = await parsePdfBuffer(req.file.buffer);
    const { suggestion, filledFrom } = parseResearchMeta({
      fileName,
      lines: parsed.metaLines,
    });
    const charsPerPage = parsed.pageCount
      ? parsed.charCount / parsed.pageCount
      : 0;
    const duplicateDoc = await store.findDocByHash(req.userId, fileHash);
    res.json(
      new SuccessModel({
        fileHash,
        fileName,
        pageCount: parsed.pageCount,
        charCount: parsed.charCount,
        suggestion,
        filledFrom,
        dropped: parsed.dropped,
        duplicateDoc,
        warning:
          charsPerPage < 30
            ? "这份 PDF 几乎没有可复制的文字，可能是扫描件，入库后会失败"
            : "",
      })
    );
  } catch (err) {
    console.error("rag-preview:", err);
    res.status(500).json(new ErrorModel("解析 PDF 失败"));
  }
});

router.post("/docs", authMiddleware, async (req, res) => {
  try {
    const fileHash = String(req.body.fileHash || "");
    const fileName = String(req.body.fileName || "").trim();
    if (!HASH_RE.test(fileHash)) {
      return res.status(400).json(new ErrorModel("请先选择 PDF"));
    }
    if (!fileName) return res.status(400).json(new ErrorModel("缺少文件名"));
    const meta = readMeta(req.body);
    if (typeof meta === "string")
      return res.status(400).json(new ErrorModel(meta));
    if (!(await fse.pathExists(pdfPathOf(fileHash)))) {
      return res
        .status(400)
        .json(new ErrorModel("找不到已上传的 PDF，请重新选择文件"));
    }

    const existing = await store.findDocByHash(req.userId, fileHash);
    if (existing)
      return res.json(new SuccessModel({ doc: existing, duplicate: true }));

    const id = await store.insertDoc({
      userId: req.userId,
      fileHash,
      fileName: fileName.slice(0, 255),
      filePath: `public/uploads/research/${fileHash}.pdf`,
      ...meta,
    });
    ingestDoc(id);
    const doc = await store.getDoc(id, req.userId);
    res.json(new SuccessModel({ doc, duplicate: false }));
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const doc = await store.findDocByHash(
        req.userId,
        String(req.body.fileHash || "")
      );
      return res.json(new SuccessModel({ doc, duplicate: true }));
    }
    console.error("rag-create:", err);
    res.status(500).json(new ErrorModel("保存研报失败"));
  }
});

router.get("/docs", authMiddleware, async (req, res) => {
  try {
    const docs = await store.listDocs(req.userId);
    res.json(new SuccessModel(docs));
  } catch (err) {
    console.error("rag-list:", err);
    res.status(500).json(new ErrorModel("获取研报列表失败"));
  }
});

router.get("/docs/:id/chunks", authMiddleware, async (req, res) => {
  try {
    const doc = await store.getDoc(req.params.id, req.userId);
    if (!doc) return res.status(404).json(new ErrorModel("研报不存在"));
    const chunks = await store.listChunks(doc.id, req.userId);
    const dropped = await readDropped(doc.fileHash);
    res.json(new SuccessModel({ doc, chunks, dropped }));
  } catch (err) {
    console.error("rag-chunks:", err);
    res.status(500).json(new ErrorModel("获取切块失败"));
  }
});

router.post("/docs/:id/rechunk", authMiddleware, async (req, res) => {
  try {
    const doc = await store.getDoc(req.params.id, req.userId);
    if (!doc) return res.status(404).json(new ErrorModel("研报不存在"));
    const meta = readMeta({ ...doc, ...req.body, reportDate: doc.reportDate });
    if (typeof meta === "string")
      return res.status(400).json(new ErrorModel(meta));
    await store.updateDoc(doc.id, {
      max_chars: meta.maxChars,
      overlap_paragraphs: meta.overlapParagraphs,
      status: "parsing",
      error_msg: null,
    });
    ingestDoc(doc.id);
    const latest = await store.getDoc(doc.id, req.userId);
    res.json(new SuccessModel(latest));
  } catch (err) {
    console.error("rag-rechunk:", err);
    res.status(500).json(new ErrorModel("重新切块失败"));
  }
});

router.post("/docs/:id/retry", authMiddleware, async (req, res) => {
  try {
    const doc = await store.getDoc(req.params.id, req.userId);
    if (!doc) return res.status(404).json(new ErrorModel("研报不存在"));
    ingestDoc(doc.id);
    const latest = await store.getDoc(doc.id, req.userId);
    res.json(new SuccessModel(latest));
  } catch (err) {
    console.error("rag-retry:", err);
    res.status(500).json(new ErrorModel("重试失败"));
  }
});

router.delete("/docs/:id", authMiddleware, async (req, res) => {
  try {
    const result = await store.deleteDoc(req.params.id, req.userId);
    if (!result.affectedRows)
      return res.status(404).json(new ErrorModel("研报不存在"));
    res.json(new SuccessModel("已删除"));
  } catch (err) {
    console.error("rag-delete:", err);
    res.status(500).json(new ErrorModel("删除失败"));
  }
});

module.exports = router;
