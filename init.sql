CREATE DATABASE IF NOT EXISTS frontend_system CHARACTER SET utf8mb4;
USE frontend_system;

-- 重新定义角色表
DROP TABLE IF EXISTS roles;
CREATE TABLE roles (
    role_id INT PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE,
    -- 存储权限列表，建议用逗号分隔的字符串或 JSON 格式
    -- 例如: "fund:view,fund:edit,user:manage"
    permissions TEXT COMMENT '权限标识列表',
    description VARCHAR(255)
) ENGINE=InnoDB;

-- 初始化角色及其权限
INSERT INTO roles (role_id, role_name, permissions, description) VALUES 
(1, '超级管理员', '*', '拥有所有权限'),
(2, '普通用户', 'fund:view,fund:edit,profile:edit', '仅能操作自己的持仓和资料'),
(3, 'VIP用户', 'fund:view,fund:edit,profile:edit,analysis:view', '可以使用高级分析功能');

-- 用户表 (父表)
CREATE TABLE IF NOT EXISTS users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(20) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    nickname VARCHAR(50) DEFAULT '新用户' COMMENT '用户显示的名称',
    role_id INT DEFAULT 2 COMMENT '角色ID',

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

     -- 关联角色表
    CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES roles(role_id)
) ENGINE=InnoDB;

-- 持仓数据表 (子表)
CREATE TABLE IF NOT EXISTS portfolios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,           -- 关联用户的唯一ID
    fund_code VARCHAR(10) NOT NULL, -- 基金代码
    amount DECIMAL(15, 2) NOT NULL, -- 持仓金额
    target_profit_rate DECIMAL(5,2) DEFAULT NULL COMMENT '止盈触发涨幅（%）',
    stop_loss_rate DECIMAL(5,2) DEFAULT NULL COMMENT '止损触发跌幅（%）',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- 核心：关联外键。当用户表里的 user_id 被删除时，该用户的所有持仓也会自动删除 (CASCADE)
    CONSTRAINT fk_user_id FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    
    -- 索引优化：确保同一个用户对同一个基金只有一条记录
    UNIQUE KEY `unique_user_fund` (`user_id`, `fund_code`)
) ENGINE=InnoDB;

-- 会话表：记录用户开启了多少个对话
CREATE TABLE IF NOT EXISTS chat_sessions (
    id VARCHAR(36) PRIMARY KEY, -- 使用 UUID
    user_id INT NOT NULL,
    title VARCHAR(255) DEFAULT '新对话', -- 例如“分析广发纳斯达克”
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;