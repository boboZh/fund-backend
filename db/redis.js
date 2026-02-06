const redis = require("redist");

const client = redis.createClient({
  url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS.PORT}`,
});

client.on("error", (err) => console.error("Redist error: ", err));

(async () => {
  await client.connect();
  console.log("Redist 已连接");
})();

module.exports = client;
