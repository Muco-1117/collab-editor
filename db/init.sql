-- ============================================================
-- 多人实时协同编辑系统 —— 数据库初始化脚本（T0-1 版：库+空表骨架）
-- T0+4 持久化里程碑落全字段与索引
-- ============================================================
CREATE DATABASE IF NOT EXISTS collab_editor
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE collab_editor;

-- 用户
CREATE TABLE IF NOT EXISTS `user` (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username    VARCHAR(64)  NOT NULL UNIQUE COMMENT '登录名',
  password    VARCHAR(128) NOT NULL COMMENT 'BCrypt 哈希',
  nickname    VARCHAR(64)  NOT NULL DEFAULT '',
  role        VARCHAR(16)  NOT NULL DEFAULT 'editor' COMMENT 'admin/editor/viewer',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='平台用户';

-- 空间（文档群组隔离）
CREATE TABLE IF NOT EXISTS `space` (
  `id`         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `name`       VARCHAR(128) NOT NULL,
  `owner_id`   BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='空间（隔离单元）';

-- 空间成员
CREATE TABLE IF NOT EXISTS `space_member` (
  `space_id`   BIGINT UNSIGNED NOT NULL,
  `user_id`    BIGINT UNSIGNED NOT NULL,
  `role`       VARCHAR(16) NOT NULL DEFAULT 'editor',
  PRIMARY KEY (`space_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='空间成员';

-- 文档元信息（doc 类型元素属于某个 space）
CREATE TABLE IF NOT EXISTS `document` (
  `id`         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `space_id`   BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `doc_key`    VARCHAR(36)  NOT NULL UNIQUE COMMENT 'WS 房间键（元素集合归属）',
  `title`      VARCHAR(256) NOT NULL DEFAULT '',
  `created_by` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='文档/对象元数据';

-- 元素快照表（T0-4：定时快照 + op 日志回放恢复）
CREATE TABLE IF NOT EXISTS `element_snapshot` (
  `id`          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `doc_id`      VARCHAR(64)  NOT NULL,
  `rev`         BIGINT UNSIGNED NOT NULL COMMENT '快照版本（= 该时刻服务端 seq）',
  `elements_json` MEDIUMTEXT NOT NULL COMMENT '元素集序列化（OpStore.encodeElements）',
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_doc_rev` (`doc_id`, `rev`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='元素快照';

-- 操作日志（append-only，回放依据）
CREATE TABLE IF NOT EXISTS `operation_log` (
  `id`          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `doc_id`      VARCHAR(64)  NOT NULL,
  `element_id`  VARCHAR(64)  NOT NULL DEFAULT '',
  `field`       VARCHAR(64)  NOT NULL DEFAULT '',
  `value_json`  TEXT,
  `clock`       VARCHAR(64)  NOT NULL COMMENT 'OpType|Lamport 时钟 replicaId:counter',
  `seq`         BIGINT UNSIGNED NOT NULL COMMENT '服务端顺序号（每 doc 单调）',
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_doc_seq` (`doc_id`, `seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志（append-only）';