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

const deleteDoc = async (id, userId) =>
  execStrict(`DELETE FROM research_docs WHERE id = ? AND user_id = ?`, [id, userId]);

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
  deleteDoc,
  recoverStuckDocs,
};
