const { ErrorModel } = require("../model/resModel");

// 权限校验中间件
const authMiddleware = async (req, res, next) => {
  // 读取签名的cookie:req.signedCookies.userId
  // 如果没用签名，则是req.cookies.userId
  const userId = req.signedCookies.userId;
  const sessionId = req.signedCookies.sessionId;

  if (!userId) {
    return res.status(401).json(new ErrorModel("请先登录"));
  }
  try {
    const lastestSessionId = await redistClient.get(`session:${userId}`);
    if (!lastestSessionId) {
      return res.status(401).json(new ErrorModel("登录已过期，请重新登录"));
    }
    if (lastestSessionId !== sessionId) {
      return res
        .status(401)
        .json(new ErrorModel("账号已在其它设备登录，请重新登录"));
    }

    req.userId = userId;
    next();
  } catch (err) {
    res.status(500).json(new ErrorModel(err.message || "服务器鉴权出错"));
  }
};

module.exports = authMiddleware;
