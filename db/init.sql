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
  avatar_data MEDIUMBLOB NULL COMMENT '规范化的 PNG 头像',
  avatar_version VARCHAR(36) NULL COMMENT '头像更新版本',
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

-- 兼容早期数据：空间创建者角色统一为 owner。
UPDATE `space_member` SET `role` = 'owner' WHERE `role` = 'admin';

-- 文档元信息（doc 类型元素属于某个 space）
CREATE TABLE IF NOT EXISTS `document` (
  `id`         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `space_id`   BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `doc_key`    VARCHAR(36)  NOT NULL UNIQUE COMMENT 'WS 房间键（元素集合归属）',
  `title`      VARCHAR(256) NOT NULL DEFAULT '',
  `kind`       VARCHAR(16)  NOT NULL DEFAULT 'doc' COMMENT 'doc/board/kanban',
  `created_by` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at` DATETIME NULL DEFAULT NULL COMMENT '软删除时间；NULL 表示有效',
  KEY `idx_document_space_active` (`space_id`, `deleted_at`, `updated_at`)
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
  `operation_id` VARCHAR(96) NULL COMMENT '客户端 opId；缺省使用 Lamport clock',
  `actor_id`     BIGINT UNSIGNED NULL COMMENT '提交操作的用户；系统恢复操作为 NULL',
  `element_id`  VARCHAR(64)  NOT NULL DEFAULT '',
  `element_type` VARCHAR(16) NULL COMMENT 'DOC/TEXT/IMAGE/CARD/TASK/COLUMN；NULL 表示旧日志',
  `field`       VARCHAR(64)  NOT NULL DEFAULT '',
  `value_json`  MEDIUMTEXT,
  `clock`       VARCHAR(64)  NOT NULL COMMENT 'OpType|Lamport 时钟 replicaId:counter',
  `seq`         BIGINT UNSIGNED NOT NULL COMMENT '服务端顺序号（每 doc 单调）',
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_doc_seq` (`doc_id`, `seq`),
  UNIQUE KEY `uk_doc_operation_id` (`doc_id`, `operation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志（append-only）';

-- 图片资源元数据；二进制保存于 app.upload-dir，协同消息只传 IMAGE 元素字段
CREATE TABLE IF NOT EXISTS `image_asset` (
  `id`             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `asset_id`       VARCHAR(64) NOT NULL UNIQUE,
  `doc_id`         VARCHAR(64) NOT NULL,
  `original_name`  VARCHAR(255) NOT NULL,
  `mime_type`      VARCHAR(64) NOT NULL,
  `byte_size`      BIGINT UNSIGNED NOT NULL,
  `width`          INT UNSIGNED NOT NULL,
  `height`         INT UNSIGNED NOT NULL,
  `storage_path`   VARCHAR(512) NOT NULL,
  `created_by`     BIGINT UNSIGNED NOT NULL,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_image_asset_doc` (`doc_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='图片资源及访问权限元数据';
