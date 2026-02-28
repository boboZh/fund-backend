const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const fundMapService = require("./services/fundMap");
const createError = require("http-errors");
const userRouter = require("./routes/user");
const fundRouter = require("./routes/fund");
const aiRouter = require("./routes/ai");
const { WebSocketServer } = require("ws");

const app = express();

// --- 中间件配置 ---

const env = process.env.NODE_ENV || "dev";

// 配置 CORS, 本地直连调试
app.use(
  cors({
    // 动态允许请求的 origin
    origin: function (origin, callback) {
      // 本地开发时，允许所有本地 origin，或者写死前端的 origin (如 'http://localhost:5173')
      // 如果没有 origin (比如 postman 直接请求)，也放行
      if (
        !origin ||
        origin.includes("localhost") ||
        origin.includes("127.0.0.1")
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true, // 关键：允许前端携带凭证（Cookie/Authorization）
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control"],
  }),
);

// 解析 JSON 请求体
app.use(express.json());

// 2. 引入 cookie-parser (修正了 secret 拼写)
const COOKIE_SECRET = "your random secret string 123";
app.use(cookieParser(COOKIE_SECRET));

// --- 路由配置 ---

// 注意：这里决定了你的基础路径
// 访问 login 接口将是 /user/login
app.use("/api/user", userRouter);
app.use("/api/fund", fundRouter);
app.use("/api/ai", aiRouter);

// --- 错误处理 ---

app.use((req, res, next) => {
  console.log("--req path--", req.path);
  next();
});

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

const server = app.listen(3000, async () => {
  await fundMapService.init();
  console.log("✅ Server running at http://localhost:3000");
});

const wss = new WebSocketServer({
  server,
  path: "/api/audio-stream",
});

wss.on("connection", (ws) => {
  console.log("websocket 前端已连接，准备下发实时音频流");

  const sampleRate = 16000;
  const duration = 0.1; // 每100ms发送一个切片
  const numSamples = sampleRate * duration;

  let time = 0; // 记录时间轴，保证波形连续

  const timer = setInterval(() => {
    // 创建Int16Array，存放16-bit PCM裸数据
    const pcmData = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcmData[i] = Math.sin(2 * Math.PI * 440 * time) * 8000;
      time += 1 / sampleRate;
    }

    // 转换成Nodejs的Buffer 并发送二进制帧
    if (ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(pcmData.buffer));
    }
  }, 100); // 模拟网络每100ms推送一次

  ws.on("close", () => {
    console.log("websocket 连接已断开");
    clearInterval(timer); // 断开时清除定时器，防止内存泄漏
  });
});
