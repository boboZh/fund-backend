const mysql = require("mysql2/promise");
const { MYSQL_CONF } = require("../conf/db");

/**
 * mysql不能用单一的一个连接，因为mysql会自动断开不活跃的链接
 * 使用连接池，能自动管理连接的创建、释放和断线重连
 */

const pool = mysql.createPool({
  ...MYSQL_CONF,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// 通用执行函数，使用execute自动处理参数转移，防止sql注入
const exec = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};

module.exports = {
  exec,
};
