const path = require("path");
const fse = require("fs-extra");

const CACHE_DIR = path.resolve(__dirname, "../public/uploads/cache");

const cachePathOf = (fileHash) =>
  path.join(CACHE_DIR, `${fileHash}.cache.json`);

const writeCache = async (doc, parsed, withoutToc, chunks) => {
  await fse.ensureDir(CACHE_DIR);
  const filePath = cachePathOf(doc.fileHash);
  const tmpPath = `${filePath}.tmp`;
  await fse.writeJson(tmpPath, {
    doc,
    parsed,
    withoutToc,
    chunks,
  });
  await fse.move(tmpPath, filePath, { overwrite: true });
};

module.exports = {
  writeCache,
};
