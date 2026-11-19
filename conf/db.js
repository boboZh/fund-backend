const path = require("path");
const dotenv = require("dotenv");

// 获取当前环境，写在package.json的scripts中的
const env = process.env.NODE_ENV || "dev";

// 根据环境变量拼凑中文名，获取绝对路径
const envPath = path.resolve(process.cwd(), `.env.${env}`);

// 加载配置
const result = dotenv.config({
  path: envPath,
});

// Docker injects environment variables without creating an .env file.
if (result.error && result.error.code !== "ENOENT") {
  throw new Error(`无法加载配置文件：${envPath}`);
}

const required = ["DB_HOST", "DB_USER", "DB_PASS", "DB_PORT", "DB_Name"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`缺少数据库环境变量：${missing.join(", ")}`);
}

// 加载完配置文件，就可以拿到process.env中的变量了

const MYSQL_CONF = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT,
  database: process.env.DB_Name,
};
const REDIS_CONF = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
};

module.exports = {
  MYSQL_CONF,
  REDIS_CONF,
};
