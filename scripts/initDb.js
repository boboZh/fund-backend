const path = require("path");
const mysql = require("mysql2/promise");
const fs = require("fs");
const { MYSQL_CONF } = require("../conf/db");

async function initDatabase() {
  const { host, user, password } = MYSQL_CONF;
  let connection;

  try {
    console.log("开始执行数据库初始化脚本...");
    connection = await mysql.createConnection({
      host,
      user,
      password,
      multipleStatements: true, // 允许一次执行多条sql
    });
    const sqlPath = path.join(__dirname, "../init.sql");
    const sql = fs.readFileSync(sqlPath, "utf8");

    await connection.query(sql);

    console.log("数据库与数据表初始化/更新成功！");
  } catch (err) {
    console.error("初始化失败：", err.message);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

initDatabase();
