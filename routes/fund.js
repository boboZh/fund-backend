const express = require("express");
const router = express.Router();
const { getFundInfoByCode } = require("../controller/fund");
const { SuccessModel, ErrorModel } = require("../model/resModel");

router.get("/getInfoByCode/:code", async (req, res) => {
  const fundCode = req.params.code;
  try {
    const info = await getFundInfoByCode(fundCode);
    res.json(new SuccessModel(info));
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});

module.exports = router;
