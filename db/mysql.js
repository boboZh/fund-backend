const mysql = require("mysql2/promise");
const { MYSQL_CONF } = require("../conf/db");
const humps = require("humps");
const { signalContext } = require("../utils/context");

/**
 * mysql不能用单一的一个连接，因为mysql会自动断开不活跃的链接
 * 使用连接池，能自动管理连接的创建、释放和断线重连
 */

const pool = mysql.createPool({
  ...MYSQL_CONF,
  waitForConnections: true,
  connectionLimit: 10, // group of connections, adjust as needed
  queueLimit: 0,
});

// 通用执行函数，使用execute自动处理参数转移，防止sql注入
const exec = async (sql, params = []) => {
  const signal = signalContext.getStore(); // retrieve the signal from the current context
  try {
    const [rows] = await pool.execute({
      sql,
      values: params,
      signal, // when mysql2 receive a abort signal, it destroys the connection, then the pool will automatically handle creating a fresh connection the next time one is needed.
    }); // one specific execution use one specific connection from the pool, and release it immediately after execution
    return humps.camelizeKeys(rows); // 将数据库的fund_code字段转为驼峰
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn(`Query is aborted: ${sql}`);
    }
  }
};

module.exports = {
  exec,
};
