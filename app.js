const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const fundMapService = require("./services/fundMap");
const createError = require("http-errors");
const userRouter = require("./routes/user");
const fundRouter = require("./routes/fund");

const app = express();

// --- 中间件配置 ---

// 1. 处理跨域
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  }),
);

// 解析 JSON 请求体
app.use(express.json());

// 2. 引入 cookie-parser (修正了 secret 拼写)
const COOKIE_SECRET = "your random secret string 123";
app.use(cookieParser(COOKIE_SECRET));

// --- 路由配置 ---

// 注意：这里决定了你的基础路径
// 访问 login 接口将是 /api/user/login
app.use("/api/user", userRouter);
app.use("/api/fund", fundRouter);

// --- 错误处理 ---

// 404 捕获：如果上面的路由都没匹配上，执行这里
app.use((req, res, next) => {
  next(createError(404, "接口不存在"));
});

// 全局错误处理：接收所有 next(err) 传过来的错误
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    status: status,
    message: err.message,
  });
});

app.listen(3000, async () => {
  await fundMapService.init();
  console.log("✅ Server running at http://localhost:3000");
});
