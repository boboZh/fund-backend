const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const {
  getFundInfoByCode,
  addFund,
  getPortfolio,
  batchAddFund,
  ocrAnalyze,
} = require("../controller/fund");
const { SuccessModel, ErrorModel } = require("../model/resModel");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

router.get("/getInfoByCode/:code", async (req, res) => {
  const fundCode = req.params.code;
  try {
    const info = await getFundInfoByCode(fundCode);
    res.json(new SuccessModel(info));
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});

router.post("/add", authMiddleware, async (req, res) => {
  const { code, amount } = req.body;
  try {
    await addFund(req.userId, code, amount);
    res.json(new SuccessModel("添加成功"));
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});

router.post("/batchAdd", authMiddleware, async (req, res) => {
  const { funds } = req.body;
  try {
    const result = await batchAddFund(
      req.userId,
      funds.map((item) => {
        return {
          ...item,
          amount: item.amount || 0,
        };
      }),
    );
    res.json(new SuccessModel(`添加成功${result.length}条`));
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});

router.get("/portfolioReport", authMiddleware, async (req, res) => {
  try {
    const report = await getPortfolio(req.userId);
    res.json(new SuccessModel(report));
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});

(router.post(
  "/ocrAnalyze",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) return res.status(400).json(new ErrorModel("请上传图片"));

    try {
      const data = await ocrAnalyze(req.file);
      console.log("ocr-route: ", data);
      res.json(new SuccessModel(data));
    } catch (err) {
      res.status(500).json(new ErrorModel(err.message || "识别失败"));
    }
  },
),
  (module.exports = router));
