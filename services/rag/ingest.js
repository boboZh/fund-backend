const fse = require("fs-extra");
const { extractPdfPages } = require("./parsePdf");
const { orderDocument, LAYOUT_VERSION, dropToc } = require("./readingOrder");
const { pdfPathOf, droppedPathOf, layoutPathOf } = require("./paths");
const store = require("./store");
const { postIngest } = require("./pythonIngest");

const running = new Set();
const MIN_CHARS_PER_PAGE = 30;

const readDropped = async (fileHash) => {
  const filePath = droppedPathOf(fileHash);
  if (!(await fse.pathExists(filePath))) return [];
  try {
    const saved = await fse.readJson(filePath);
    return Array.isArray(saved) ? saved : [];
  } catch (err) {
    console.error("读取去噪记录失败:", err);
    return [];
  }
};

const fail = async (docId, message) => {
  await store.updateDoc(docId, {
    status: "failed",
    error_msg: String(message || "解析失败").slice(0, 500),
  });
};

const sourceCharCount = (pages) =>
  pages.reduce(
    (sum, page) =>
      sum +
      page.items.reduce(
        (inner, item) => inner + String(item.str || "").trim().length,
        0
      ),
    0
  );

const readLayout = async (fileHash) => {
  const filePath = layoutPathOf(fileHash);
  if (!(await fse.pathExists(filePath))) return null;
  try {
    const saved = await fse.readJson(filePath);
    if (
      saved?.version !== LAYOUT_VERSION ||
      !Array.isArray(saved.paragraphs) ||
      !saved.paragraphs.length
    ) {
      return null;
    }
    return saved;
  } catch (err) {
    console.error("读取版面缓存失败:", err);
    return null;
  }
};

const writeLayout = async (fileHash, layout) => {
  const filePath = layoutPathOf(fileHash);
  const tmpPath = `${filePath}.tmp`;
  await fse.writeJson(tmpPath, layout);
  await fse.move(tmpPath, filePath, { overwrite: true });
};

/**
 * 入参是已入库的研报和 PDF。出参是按阅读顺序拼好的段落。
 * 同一份 PDF 的版面结果按文件哈希缓存，重新切块只改段落合并，不再请求模型。
 */
const layoutDoc = async (doc, buffer) => {
  const cached = await readLayout(doc.fileHash);
  if (cached) return cached;

  //把一份 PDF 的二进制内容拆成「每一页上的文字碎片」，顺便记下每个碎片在页面上的坐标
  const pages = await extractPdfPages(buffer);
  // 计算正文文字数量
  const charsPerPage = pages.length ? sourceCharCount(pages) / pages.length : 0;
  if (charsPerPage < MIN_CHARS_PER_PAGE) {
    throw new Error("这份 PDF 几乎没有可复制的文字，可能是扫描件");
  }
  const laid = await orderDocument(pages, {
    onPage: (current, total) =>
      store
        .updateDoc(doc.id, {
          error_msg: `正在整理第 ${current}/${total} 页版面`,
        })
        .catch((err) => console.error("回写版面进度失败:", err)),
  });
  if (!laid.paragraphs.length) throw new Error("没有整理出可用段落");
  await writeLayout(doc.fileHash, laid);
  return laid;
};
/**
 * 入参是已经插入的研报 id。版面仍在这里整理，切块和向量交给 Python 的 POST /ingest。
 * 路由不 await 这个函数：整理版面和向量化都会超过前端的 30 秒超时，浏览器先拿到 parsing。
 */
const ingestDoc = async (docId) => {
  if (running.has(docId)) return;
  running.add(docId);
  try {
    const doc = await store.getDocById(docId);
    if (!doc) return;
    await store.updateDoc(docId, { status: "parsing", error_msg: null });

    const filePath = pdfPathOf(doc.fileHash);
    if (!(await fse.pathExists(filePath))) {
      await fail(docId, "找不到已上传的 PDF，请重新选择文件");
      return;
    }

    const parsed = await layoutDoc(doc, await fse.readFile(filePath));
    const withoutToc = dropToc(parsed.paragraphs);
    await fse.writeJson(
      droppedPathOf(doc.fileHash),
      [...(parsed.dropped || []), ...withoutToc.dropped].slice(0, 50)
    );
    if (!withoutToc.paragraphs.length) {
      await fail(docId, "没有切出可用段落");
      return;
    }

    const result = await postIngest(doc, parsed.pageCount, withoutToc.paragraphs);
    if (result?.doc?.status === "failed") {
      console.error(
        `Python 入库未完成 doc=${docId}:`,
        result.doc.errorMsg || result.doc.error_msg || ""
      );
    }
  } catch (err) {
    console.error(`研报入库失败 doc=${docId}:`, err);
    await fail(docId, err.message || "解析失败").catch((updateErr) => {
      console.error("写入失败状态也失败了:", updateErr);
    });
  } finally {
    running.delete(docId);
  }
};

const recoverStuckDocs = () => store.recoverStuckDocs();

module.exports = {
  ingestDoc,
  readDropped,
  recoverStuckDocs,
};
