const redis = require("redis");

const host = process.env.REDIS_HOST || "127.0.0.1";
const port = process.env.REDIS_PORT || 6379;
const client = redis.createClient({
  url: `redis://${host}:${port}`,
});

client.on("error", (err) => console.error("Redis error: ", err));
client.on("connect", () => console.log("正在尝试连接redis。。。"));
client.on("ready", () => console.log("redis已就绪可执行操作"));

(async () => {
  try {
    await client.connect();
    console.log("Redis 连接函数执行完毕");
  } catch (err) {
    console.error("redis error: 无法建立初始连接", err);
  }
})();

module.exports = client;
