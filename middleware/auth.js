const { ErrorModel } = require("../model/resModel");

// 权限校验中间件
const authMiddleware = (req, res, next) => {
  // 读取签名的cookie:req.signedCookies.userId
  // 如果没用签名，则是req.cookies.userId
  const userId = req.signedCookies.userId;
  if (!userId) {
    return res.status(401).json(new ErrorModel("请先登录"));
  }
  req.userId = userId;
  next();
};

module.exports = authMiddleware;
