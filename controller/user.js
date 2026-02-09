const { exec } = require("../db/mysql");
const { genPassword } = require("../services/cryp");
const { v4: uuidv4 } = require("uuid");
const redisClient = require("../db/redis");

// 查询手机号和密码是否匹配，并返回用户信息（不含密码）
const login = async (phone, password) => {
  const sql = `SELECT 
    u.user_id, 
    u.nickname, 
    u.phone, 
    u.role_id, 
    r.role_name, 
    r.permissions 
FROM users AS u
INNER JOIN roles AS r ON u.role_id = r.role_id
WHERE u.phone = ? AND u.password = ?;`;

  password = genPassword(password);
  const rows = await exec(sql, [phone, password]);
  const user = rows[0];
  console.log("user: ", user);
  if (user) {
    const sessionId = uuidv4();
    await redisClient.set(`session:${user.userId}`, sessionId, {
      EX: 24 * 60 * 60,
    });
    user.sessionId = sessionId;
  }
  if (user && user.permissions) {
    user.permissions =
      user.permissions === "*" ? ["*"] : user.permissions.split(",");
  }
  return user;
};

// 退出登录
const logout = async (userId) => {
  await redisClient.del(`session:${userId}`);
};

// 用户注册
const register = async (phone, password, nickName, roleId) => {
  password = genPassword(password);
  const sql = `INSERT INTO users (phone, password, nickname, role_id) VALUES
( ? , ? , ? , ?);
`;
  const rows = await exec(sql, [phone, password, nickName, roleId]);
  return rows;
};

// 获取用户列表
const getUserList = async () => {
  const sql = `SELECT u.user_id, u.phone, u.nickname, r.role_name, r.permissions 
FROM users u 
JOIN roles r ON u.role_id = r.role_id;`;
  const rows = await exec(sql);
  return rows;
};

module.exports = {
  login,
  register,
  getUserList,
  logout,
};
