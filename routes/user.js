const express = require("express");
const router = express.Router();
const { login, register, getUserList } = require("../controller/user");
const { SuccessModel, ErrorModel } = require("../model/resModel");

router.post("/login", async (req, res, next) => {
  const { phone, password } = req.body;

  try {
    const user = await login(phone, password);
    if (user) {
      res.cookie("userId", user.user_id, {
        maxAge: 1000 * 60 * 60 * 24, // 有效期 24 小时
        httpOnly: true, // 关键：防止前端 JS 读取 Cookie (防 XSS)
        signed: true, // 关键：对 Cookie 进行签名 (防篡改)
        sameSite: "lax", // 兼容性与安全性折中
      });
      res.json(new SuccessModel(user, "登录成功"));
      return;
    }

    res.json(new ErrorModel("登录失败：未查询到用户信息"));
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});

router.post("/register", async (req, res, next) => {
  const { phone, password, nickName, roleId } = req.body;
  try {
    const result = await register(phone, password, nickName, roleId);
    res.json(new SuccessModel("注册成功"));
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});

router.get("/getList", async (req, res, next) => {
  try {
    const list = await getUserList();
    res.json(
      new SuccessModel(
        {
          list,
        },
        "查询成功",
      ),
    );
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器内部错误"));
  }
});

module.exports = router;
