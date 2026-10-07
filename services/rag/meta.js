const CODE_WITH_NAME =
  /([\u4e00-\u9fa5A-Za-z]{2,12})\s*[（(]\s*(\d{6})(?:\.(?:SH|SZ|BJ))?\s*[）)]/i;
const CODE_THEN_NAME =
  /(?<!\d)(\d{6})(?:\.(?:SH|SZ|BJ))?(?!\d)\s*[_\-\s]+([\u4e00-\u9fa5]{2,12})/i;
const NAME_THEN_CODE =
  /([\u4e00-\u9fa5]{2,12})\s*[_\-\s]+(\d{6})(?:\.(?:SH|SZ|BJ))?(?!\d)/i;
const ORG_RE = /[\u4e00-\u9fa5A-Za-z]{2,10}(?:证券|期货)/;
const DATE_TEXT =
  /(20\d{2})\s*[-.年/]\s*(\d{1,2})\s*[-.月/]\s*(\d{1,2})\s*日?/;
const DATE_COMPACT = /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/;

const emptyMeta = () => ({
  stockCode: "",
  stockName: "",
  title: "",
  reportDate: "",
  org: "",
});

const pad = (value) => String(value).padStart(2, "0");

const toIsoDate = (year, month, day) => {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return "";
  return `${y}-${pad(m)}-${pad(d)}`;
};

const findDate = (text) => {
  const written = text.match(DATE_TEXT);
  if (written) return toIsoDate(written[1], written[2], written[3]);
  const compact = text.match(DATE_COMPACT);
  if (compact) return toIsoDate(compact[1], compact[2], compact[3]);
  return "";
};

const stripDates = (text) =>
  text.replace(DATE_TEXT, " ").replace(DATE_COMPACT, " ");

const findCodeAndName = (text) => {
  const source = stripDates(text);
  const wrapped = source.match(CODE_WITH_NAME);
  if (wrapped) return { stockName: wrapped[1], stockCode: wrapped[2] };
  const codeFirst = source.match(CODE_THEN_NAME);
  if (codeFirst) return { stockCode: codeFirst[1], stockName: codeFirst[2] };
  const nameFirst = source.match(NAME_THEN_CODE);
  if (nameFirst) return { stockName: nameFirst[1], stockCode: nameFirst[2] };
  const codeOnly = source.match(/(?<!\d)(\d{6})(?:\.(?:SH|SZ|BJ))?(?!\d)/i);
  if (codeOnly) return { stockCode: codeOnly[1], stockName: "" };
  return { stockCode: "", stockName: "" };
};

const findOrg = (text) => {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const shortLine = lines.find(
    (line) => line.length <= 20 && ORG_RE.test(line),
  );
  const matched = (shortLine || text).match(ORG_RE);
  return matched ? matched[0] : "";
};

const cleanTitle = (text) =>
  text
    .replace(/\.pdf$/i, "")
    .replace(/\s*\d+\s*页\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);

const titleFromFileName = (fileName) => {
  const cleaned = cleanTitle(fileName || "");
  if (/[：:]/.test(cleaned) && /[\u4e00-\u9fa5]{2,}/.test(cleaned)) {
    return cleaned;
  }
  return "";
};

const titleFromLines = (lines) => {
  const texts = (lines || []).map((line) =>
    typeof line === "string" ? line : line.text,
  );
  const wrapped = texts.find(
    (text) =>
      text &&
      text.length <= 200 &&
      /[（(]\s*\d{6}/.test(text),
  );
  if (wrapped) return cleanTitle(wrapped);
  return "";
};

const parseBlob = (text) => {
  const meta = emptyMeta();
  if (!text) return meta;
  const identity = findCodeAndName(text);
  meta.stockCode = identity.stockCode;
  meta.stockName = identity.stockName;
  meta.reportDate = findDate(text);
  meta.org = findOrg(text);
  return meta;
};

const pick = (pdfValue, fileValue) => {
  if (pdfValue) return { value: pdfValue, from: "pdf" };
  if (fileValue) return { value: fileValue, from: "filename" };
  return { value: "", from: "" };
};

const pickTitle = (pdfTitle, fileTitle) => {
  if (pdfTitle && fileTitle) {
    if (fileTitle.length > pdfTitle.length) {
      return { value: fileTitle, from: "filename" };
    }
    return { value: pdfTitle, from: "pdf" };
  }
  return pick(pdfTitle, fileTitle);
};

/**
 * 从文件名和首页文字里识别研报元数据。
 * 某一项没识别到时留空，由调用方决定是否手填。
 */
const parseResearchMeta = ({ fileName = "", lines = [] } = {}) => {
  const fileText = (fileName || "").replace(/\.pdf$/i, "");
  const lineTexts = (lines || []).map((line) =>
    typeof line === "string" ? line : line.text,
  );
  const pdfText = lineTexts.join("\n");
  const fromFile = parseBlob(fileText);
  const fromPdf = parseBlob(pdfText);
  fromFile.title = titleFromFileName(fileName);
  fromPdf.title = titleFromLines(lineTexts);

  const fields = ["stockCode", "stockName", "reportDate", "org"];
  const suggestion = emptyMeta();
  const filledFrom = {
    stockCode: "",
    stockName: "",
    title: "",
    reportDate: "",
    org: "",
  };
  fields.forEach((field) => {
    const picked = pick(fromPdf[field], fromFile[field]);
    suggestion[field] = picked.value;
    filledFrom[field] = picked.from;
  });
  const title = pickTitle(fromPdf.title, fromFile.title);
  suggestion.title = title.value;
  filledFrom.title = title.from;
  return { suggestion, filledFrom };
};

module.exports = {
  parseResearchMeta,
  findDate,
  findCodeAndName,
};
