const express = require("express");
const router = express.Router();
const multer = require("multer");
const fse = require("fs-extra");
const path = require("path");

const { exec } = require("../db/mysql");
const authMiddleware = require("../middleware/auth");
const { SuccessModel, ErrorModel } = require("../model/resModel");
const { route } = require("./ai");

const UPLOAD_DIR = path.resolve(__dirname, "../public/uploads/files");
const CHUNK_DIR = path.resolve(__dirname, "../public/uploads/chunks");
fse.ensureDirSync(UPLOAD_DIR);
fse.ensureDirSync(CHUNK_DIR);

// multer处理表单。fs-extra处理文件切片
const upload = multer({
  dest: CHUNK_DIR,
});

// 校验，实现秒传、断点续传。
router.post("/verify", authMiddleware, async (req, res) => {
  try {
    const { fileHash, fileName } = req.body;

    const sql = `SELECT * FROM uploaded_files WHERE file_hash = ?`;
    const rows = await exec(sql, [fileHash]);
    if (rows.length > 0) {
      return res.json(
        new SuccessModel({ shouldUpload: false }, "秒传成功，已存在"),
      );
    }
    // 检查是否有为合并的零碎切片（断点续传）
    const chunkPath = path.resolve(CHUNK_DIR, fileHash);
    let uploadedChunks = [];
    if (fse.existsSync(chunkPath)) {
      uploadedChunks = fse.readdirSync(chunkPath);
    }
    res.json(
      new SuccessModel({ shouldUpload: true, uploadedChunks }, "需要上传"),
    );
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message));
  }
});
// 接收切片
router.post(
  "/upload/chunk",
  authMiddleware,
  upload.single("chunk"),
  async (req, res) => {
    try {
      const { fileHash, chunkHash } = req.body;
      const chunkPath = path.resolve(CHUNK_DIR, fileHash);
      if (!fse.existsSync(chunkPath)) {
        await fse.mkdirs(chunkPath);
      }
      // 将multer暂存的文件移到以fileHash命名的专属文件夹内
      await fse.move(req.file.path, path.resolve(chunkPath, chunkHash), {
        overwrite: true,
      });
      res.json(new SuccessModel("切片上传成功"));
    } catch (err) {
      res.status(500).json(new ErrorModel("切片上传失败"));
    }
  },
);
router.post("/merge", authMiddleware, async (req, res) => {
  try {
    const { fileHash, fileName } = req.body;
    const userId = req.userId;
    const ext = path.extname(fileName);
    const finalFileName = `${fileHash}${ext}`;
    const finalFilePath = path.resolve(UPLOAD_DIR, finalFileName);
    const chunkDir = path.resolve(CHUNK_DIR, fileHash);
    // 读取切片，严格按照索引顺序排序
    const chunks = await fse.readdir(chunkDir);
    chunks.sort((a, b) => a.split("-")[1] - b.split("-")[1]);

    // 流式合并，防内存溢出
    const writeStream = fse.createWriteStream(finalFilePath);
    for (const chunk of chunks) {
      const chunkPath = path.resolve(chunkDir, chunk);
      const readStream = fse.createReadStream(chunkPath);
      await new Promise((resolve) => {
        readStream.pipe(writeStream, { end: false });
        readStream.on("end", () => {
          fse.unlink(chunkPath); // 边合边删
          resolve();
        });
      });
    }
    writeStream.end();
    fse.rmdirSync(chunkDir);

    const dbPath = `/uploads/files/${finalFileName}`;
    const insertSql = `INSERT INTO uploaded_files (file_hash, file_name, file_path, user_id) VALUES (?, ?, ?, ?)`;
    await exec(insertSql, [fileHash, fileName, dbPath, userId]);
    res.json(new SuccessModel({ url: dbPath }, "文件合并入库成功"));
  } catch (err) {
    res.status(500).json(new ErrorModel("合并失败"));
  }
});

module.exports = router;
