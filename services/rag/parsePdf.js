const path = require("path");
const { pathToFileURL } = require("url");
const { buildDocument } = require("./layout");

let pdfjsPromise;

const loadPdfjs = () => {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
      const workerPath = path.join(
        path.dirname(require.resolve("pdfjs-dist/package.json")),
        "legacy/build/pdf.worker.mjs"
      );
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
};
// 把一份 PDF 的二进制内容拆成「每一页上的文字碎片」，顺便记下每个碎片在页面上的坐标
const extractPdfPages = async (buffer) => {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent(); // 只读取文本内容，后续解析图片可以引入模型一句话总结篇内容插入文本
      const items = content.items
        .filter((item) => item.str && item.transform)
        .map((item) => ({
          str: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          height:
            Math.hypot(item.transform[2], item.transform[3]) ||
            item.height ||
            10,
        }));
      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        items,
      });
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
};

const parsePdfBuffer = async (buffer) =>
  buildDocument(await extractPdfPages(buffer));

module.exports = {
  extractPdfPages,
  parsePdfBuffer,
};
