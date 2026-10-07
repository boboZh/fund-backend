const contentOf = (items, type) =>
  items.map((item) => item.text).join(type === "table" || type === "summary" ? "\n" : "\n");

const contentLength = (items, type) => contentOf(items, type).length;

const packLongText = (paragraph, maxChars) => {
  if (paragraph.kind !== "text" || paragraph.text.length <= maxChars) {
    return [paragraph];
  }
  const pieces = paragraph.text
    .split(/(?<=[。！？；])/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (pieces.length <= 1) return [paragraph];

  const groups = [];
  let buffer = "";
  const push = () => {
    if (!buffer) return;
    groups.push({ ...paragraph, text: buffer });
    buffer = "";
  };
  pieces.forEach((piece) => {
    if (buffer && buffer.length + piece.length > maxChars) push();
    buffer += piece;
  });
  push();
  return groups;
};

const toChunk = (items, type, chunkIndex) => {
  const content = contentOf(items, type);
  return {
    chunkIndex,
    chunkType: type,
    pageStart: items[0].page,
    pageEnd: items[items.length - 1].page,
    heading: items[0].heading || null,
    paragraphCount: items.length,
    content,
    charCount: content.length,
  };
};

/**
 * 按段落切块。maxChars 只决定短段能不能合并、超长段要不要按句子拆开。
 * overlapParagraphs 为 1 时，下一块以完整的上一段开头，且不跨小节。
 */
const splitParagraphs = (paragraphs, { maxChars = 800, overlapParagraphs = 1 } = {}) => {
  if (![0, 1].includes(overlapParagraphs)) {
    throw new Error("overlapParagraphs 只能是 0 或 1");
  }
  if (!Number.isFinite(maxChars) || maxChars < 50) {
    throw new Error("maxChars 过小");
  }

  const chunks = [];
  let buffer = [];
  let bufferType = "text";

  const emit = (items, type) => {
    if (!items.length) return;
    chunks.push(toChunk(items, type, chunks.length));
  };

  const flush = (carry) => {
    emit(buffer, bufferType);
    buffer = carry ? [carry] : [];
  };

  const enqueue = (paragraph) => {
    const type = paragraph.kind || "text";
    // 表格连续行合成一块，不受合并上限限制。首页数据卡单独成块。
    if (type === "table") {
      if (buffer.length && bufferType !== "table") emit(buffer, bufferType);
      if (bufferType !== "table") buffer = [];
      bufferType = "table";
      buffer = [...buffer, paragraph];
      return;
    }
    if (type === "summary") {
      if (buffer.length) emit(buffer, bufferType);
      buffer = [];
      emit([paragraph], type);
      return;
    }
    const headingChanged =
      buffer.length > 0 && (buffer[0].heading || null) !== (paragraph.heading || null);
    const typeChanged = buffer.length > 0 && bufferType !== type;
    if (headingChanged || typeChanged) flush(null);

    const pieces = packLongText(paragraph, maxChars);
    pieces.forEach((piece) => {
      if (!buffer.length) {
        buffer = [piece];
        bufferType = type;
        return;
      }
      if (contentLength([...buffer, piece], type) <= maxChars) {
        buffer = [...buffer, piece];
        return;
      }
      const last = buffer[buffer.length - 1];
      const canOverlap =
        overlapParagraphs === 1 &&
        type === "text" &&
        last.text.length < maxChars &&
        contentLength([last, piece], type) <= maxChars &&
        (last.heading || null) === (piece.heading || null);
      emit(buffer, type);
      buffer = canOverlap ? [last, piece] : [piece];
      bufferType = type;
    });
  };

  paragraphs.forEach(enqueue);
  if (buffer.length) emit(buffer, bufferType);
  return chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index }));
};

module.exports = {
  splitParagraphs,
};
