const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const fundMapService = require("./services/fundMap");
const createError = require("http-errors");
const userRouter = require("./routes/user");
const fundRouter = require("./routes/fund");
const aiRouter = require("./routes/ai");
const uploadRouter = require("./routes/upload");
const { WebSocketServer } = require("ws");

const path = require("path");
const fs = require("fs");
const client = require("./db/redis");

const app = express();
const isProd = process.env.NODE_ENV === "production";

// --- 中间件配置 ---

// 配置 CORS, 本地直连调试
app.use(
  cors({
    // 动态允许请求的 origin
    origin: function (origin, callback) {
      // 本地开发时，允许所有本地 origin，或者写死前端的 origin (如 'http://localhost:5173')
      // 如果没有 origin (比如 postman 直接请求)，也放行
      const isAllowed =
        !origin ||
        origin.includes("112.126.27.148") ||
        origin.includes("localhost") ||
        origin.includes("127.0.0.1");
      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS: " + origin));
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

// ssr与前端静态资源托管
// 托管前端静态资源
let vite;
const setupFrontend = async () => {
  if (!isProd) {
    console.log("启动vite本地开发中间件");
    const { createServer: createViteServer } = require("vite");
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
      root: path.resolve(__dirname, "../fund-frontend"),
    });
    app.use(vite.middlewares);
  } else {
    console.log("生产环境，启动静态资源托管...");
    const clientDistPath = path.resolve(__dirname, "./dist/client");
    // index必须为false，否则express会直接返回原始的index.html,导致ssr失效
    app.use(express.static(clientDistPath, { index: false })); //
  }
};

setupFrontend().then(() => {
  // --- 路由配置 ---

  // 注意：这里决定了你的基础路径
  // 访问 login 接口将是 /user/login
  app.use("/api/user", userRouter);
  app.use("/api/fund", fundRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/file", uploadRouter);

  // 匹配所有剩余路径
  app.get("/{*splat}", async (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    const accept = req.headers.accept || "";
    if (!accept.includes("text/html")) return next();

    try {
      let template, render;
      if (!isProd) {
        template = fs.readFileSync(
          path.resolve(__dirname, "../fund-frontend/index.html"),
          "utf-8",
        );
        template = await vite.transformIndexHtml(req.url, template);

        const module = await vite.ssrLoadModule(
          path.resolve(__dirname, "../fund-frontend/src/entry-server.tsx"),
        );
        render = module.render;
      } else {
        template = fs.readFileSync(
          path.resolve(__dirname, "./dist/client/index.html"),
          "utf-8",
        );
        const module = require(
          path.resolve(__dirname, "./dist/server/entry-server"),
        );
        render = module.render;
      }
      const { html } = render(req.url);
      const finalHtml = template.replace("aaa", html);
      res.status(200).set({ "Content-Type": "text/html" }).send(finalHtml);
    } catch (e) {
      console.error("ssr渲染异常：", e);
      if (!isProd) {
        vite?.ssrFixStacktrace(e); // 开发环境修复错误的堆栈信息，方便排查
        res.status(500).end(e.message);
      } else {
        //   生产环境降级到csr
        res.sendFile(path.resolve(__dirname, "./dist/client/index.html"));
      }
    }
  });
  // 404 捕获：如果上面的路由都没匹配上，执行这里
  app.use((req, res, next) => {
    next(createError(404, "接口不存在"));
  });

  // 全局错误处理：接收所有 next(err) 传过来的错误
  app.use((err, req, res, next) => {
    console.error("❌ 全局捕获到错误:", req.path, err.message);
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
});
