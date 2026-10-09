const { execStrict } = require("../../db/mysql");

const DOC_FIELDS = `
  id, user_id, file_hash, file_name, file_path, stock_code, stock_name,
  DATE_FORMAT(report_date, '%Y-%m-%d') AS report_date,
  title, org, page_count, max_chars, overlap_paragraphs, embed_model,
  status, error_msg, created_at, updated_at
`;

const findDocByHash = async (userId, fileHash) => {
  const rows = await execStrict(
    `SELECT ${DOC_FIELDS} FROM research_docs WHERE user_id = ? AND file_hash = ? LIMIT 1`,
    [userId, fileHash],
  );
  return rows[0] || null;
};

const getDoc = async (id, userId) => {
  const rows = await execStrict(
    `SELECT ${DOC_FIELDS} FROM research_docs WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId],
  );
  return rows[0] || null;
};

const getDocById = async (id) => {
  const rows = await execStrict(
    `SELECT ${DOC_FIELDS} FROM research_docs WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
};

const listDocs = async (userId) =>
  execStrict(
    `SELECT ${DOC_FIELDS} FROM research_docs WHERE user_id = ? ORDER BY updated_at DESC, id DESC`,
    [userId],
  );

const insertDoc = async (doc) => {
  const result = await execStrict(
    `INSERT INTO research_docs
      (user_id, file_hash, file_name, file_path, stock_code, stock_name, report_date, title, org, max_chars, overlap_paragraphs, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsing')`,
    [
      doc.userId,
      doc.fileHash,
      doc.fileName,
      doc.filePath,
      doc.stockCode,
      doc.stockName,
      doc.reportDate,
      doc.title,
      doc.org,
      doc.maxChars,
      doc.overlapParagraphs,
    ],
  );
  return result.insertId;
};

const UPDATABLE = new Set([
  "status",
  "error_msg",
  "page_count",
  "max_chars",
  "overlap_paragraphs",
  "embed_model",
]);

const updateDoc = async (id, fields) => {
  const sets = [];
  const params = [];
  Object.entries(fields).forEach(([key, value]) => {
    if (!UPDATABLE.has(key)) return;
    sets.push(`${key} = ?`);
    params.push(value);
  });
  if (!sets.length) return;
  params.push(id);
  await execStrict(`UPDATE research_docs SET ${sets.join(", ")} WHERE id = ?`, params);
};

const replaceChunks = async (docId, userId, chunks) => {
  await execStrict(`DELETE FROM research_chunks WHERE doc_id = ?`, [docId]);
  if (!chunks.length) return;
  const placeholders = chunks.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const params = [];
  chunks.forEach((chunk) => {
    params.push(
      docId,
      userId,
      chunk.chunkIndex,
      chunk.chunkType,
      chunk.pageStart,
      chunk.pageEnd,
      chunk.heading ? chunk.heading.slice(0, 255) : null,
      chunk.paragraphCount,
      chunk.content,
      chunk.charCount,
    );
  });
  await execStrict(
    `INSERT INTO research_chunks
      (doc_id, user_id, chunk_index, chunk_type, page_start, page_end, heading, paragraph_count, content, char_count)
     VALUES ${placeholders}`,
    params,
  );
};

const listChunks = async (docId, userId) =>
  execStrict(
    `SELECT id, doc_id, chunk_index, chunk_type, page_start, page_end, heading, paragraph_count, content, char_count
     FROM research_chunks WHERE doc_id = ? AND user_id = ? ORDER BY chunk_index ASC`,
    [docId, userId],
  );

// 按 Qdrant 返回的 point id 取原文。user_id 一起限定，避免把别的用户的块读出来。
const listChunksByIds = async (userId, ids) => {
  const chunkIds = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!chunkIds.length) return [];
  const placeholders = chunkIds.map(() => "?").join(", ");
  return execStrict(
    `SELECT c.id, c.doc_id, c.chunk_index, c.chunk_type, c.page_start, c.page_end,
            c.heading, c.content,
            d.stock_code, d.stock_name, d.title, d.org,
            DATE_FORMAT(d.report_date, '%Y-%m-%d') AS report_date
     FROM research_chunks c
     JOIN research_docs d ON d.id = c.doc_id
     WHERE c.user_id = ? AND c.id IN (${placeholders})`,
    [userId, ...chunkIds],
  );
};

const deleteDoc = async (id, userId) =>
  execStrict(`DELETE FROM research_docs WHERE id = ? AND user_id = ?`, [id, userId]);

/**
 * 入参是用户、去掉股票代码后的检索词、可选股票代码、条数。出参按全文分从高到低，最多 limit 条。
 * 这一路的分是自然语言模式的 TF-IDF，和余弦分不在一个量纲上，调用方只用名次。
 * 能确定股票时先收成这家公司的 doc_id，再取全文前 N 条。过滤和召回同时做，正确公司的段落才会进候选。
 */
const searchChunksByKeyword = async (userId, { text, stockCode, dateFrom, limit }) => {
  const queryText = String(text || "").trim();
  if (!queryText) return [];
  const ownerId = Number(userId);
  // 条数来自检索参数，已经收成 1–20 的整数。字面量拼进 SQL，是因为部分 MySQL 版本的预处理语句不接受 LIMIT 占位符。
  const size = Math.min(20, Math.max(1, Math.round(Number(limit) || 20)));

  const params = [queryText, ownerId];
  let docClause = "";
  if (stockCode) {
    const docs = await execStrict(
      `SELECT id FROM research_docs WHERE user_id = ? AND stock_code = ?`,
      [ownerId, stockCode]
    );
    const docIds = docs
      .map((doc) => Number(doc.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!docIds.length) return [];
    docClause = ` AND c.doc_id IN (${docIds.map(() => "?").join(", ")})`;
    params.push(...docIds);
  }
  // 起始日期和股票代码一起收窄文档，全文只在这些文档里取前 N 条。
  if (dateFrom) {
    docClause += ` AND d.report_date >= ?`;
    params.push(dateFrom);
  }
  params.push(queryText);

  return execStrict(
    `SELECT c.id, c.doc_id, c.chunk_type, c.page_start, c.page_end, c.heading, c.content,
            d.stock_code, d.stock_name, d.title, d.org,
            DATE_FORMAT(d.report_date, '%Y-%m-%d') AS report_date,
            MATCH(c.content) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
     FROM research_chunks c
     JOIN research_docs d ON d.id = c.doc_id
     WHERE c.user_id = ?${docClause}
       AND MATCH(c.content) AGAINST (? IN NATURAL LANGUAGE MODE)
     ORDER BY score DESC
     LIMIT ${size}`,
    params
  );
};

// 评测用来看正确原文还在不在库里。只取正文和股票代码，判断是解析丢了，还是过滤或召回没带上。
const listChunkBodies = async (userId) =>
  execStrict(
    `SELECT c.id, c.content, d.stock_code
     FROM research_chunks c
     JOIN research_docs d ON d.id = c.doc_id
     WHERE c.user_id = ?`,
    [userId],
  );

const recoverStuckDocs = async () =>
  execStrict(
    `UPDATE research_docs SET status = 'failed', error_msg = '服务重启中断，请重试' WHERE status IN ('parsing', 'embedding')`,
  );

module.exports = {
  findDocByHash,
  getDoc,
  getDocById,
  listDocs,
  insertDoc,
  updateDoc,
  replaceChunks,
  listChunks,
  listChunksByIds,
  searchChunksByKeyword,
  listChunkBodies,
  deleteDoc,
  recoverStuckDocs,
};
