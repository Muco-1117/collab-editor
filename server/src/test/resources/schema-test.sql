-- MySQL 8 integration-test schema. The JDBC URL creates/selects collab_editor_test.
DROP TABLE IF EXISTS `operation_log`;
DROP TABLE IF EXISTS `image_asset`;
DROP TABLE IF EXISTS `element_snapshot`;
DROP TABLE IF EXISTS `document`;
DROP TABLE IF EXISTS `space_member`;
DROP TABLE IF EXISTS `space`;
DROP TABLE IF EXISTS `user`;

CREATE TABLE IF NOT EXISTS `user` (
  `id`          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `username`    VARCHAR(64)  NOT NULL UNIQUE COMMENT '登录名',
  `password`    VARCHAR(128) NOT NULL COMMENT 'BCrypt 哈希',
  `nickname`    VARCHAR(64)  NOT NULL DEFAULT '',
  `avatar_data`  MEDIUMBLOB NULL,
  `avatar_version` VARCHAR(36) NULL,
  `role`        VARCHAR(16)  NOT NULL DEFAULT 'editor' COMMENT 'admin/editor/viewer',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='平台用户';

CREATE TABLE IF NOT EXISTS `space` (
  `id`         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `name`       VARCHAR(128) NOT NULL,
  `owner_id`   BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='空间（隔离单元）';

CREATE TABLE IF NOT EXISTS `space_member` (
  `space_id` BIGINT UNSIGNED NOT NULL,
  `user_id`  BIGINT UNSIGNED NOT NULL,
  `role`     VARCHAR(16) NOT NULL DEFAULT 'editor',
  PRIMARY KEY (`space_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='空间成员';

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

CREATE TABLE IF NOT EXISTS `element_snapshot` (
  `id`            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `doc_id`        VARCHAR(64) NOT NULL,
  `rev`           BIGINT UNSIGNED NOT NULL COMMENT '快照版本（= 该时刻服务端 seq）',
  `elements_json` MEDIUMTEXT NOT NULL COMMENT '元素集序列化（OpStore.encodeElements）',
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_doc_rev` (`doc_id`, `rev`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='元素快照';

CREATE TABLE IF NOT EXISTS `operation_log` (
  `id`           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `doc_id`       VARCHAR(64) NOT NULL,
  `operation_id` VARCHAR(96) NULL COMMENT '客户端操作幂等键；旧日志允许 NULL',
  `actor_id`     BIGINT UNSIGNED NULL COMMENT '提交操作的用户；系统操作为 NULL',
  `element_id`   VARCHAR(64) NOT NULL DEFAULT '',
  `element_type` VARCHAR(16) NULL COMMENT 'DOC/TEXT/IMAGE/CARD/TASK/COLUMN；NULL 表示旧日志',
  `field`        VARCHAR(64) NOT NULL DEFAULT '',
  `value_json`   MEDIUMTEXT,
  `clock`        VARCHAR(64) NOT NULL COMMENT 'OpType|Lamport 时钟 replicaId:counter',
  `seq`          BIGINT UNSIGNED NOT NULL COMMENT '服务端顺序号（每 doc 单调）',
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_doc_seq` (`doc_id`, `seq`),
  UNIQUE KEY `uk_doc_operation_id` (`doc_id`, `operation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志（append-only）';

CREATE TABLE IF NOT EXISTS `image_asset` (
  `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `asset_id` VARCHAR(64) NOT NULL UNIQUE,
  `doc_id` VARCHAR(64) NOT NULL,
  `original_name` VARCHAR(255) NOT NULL,
  `mime_type` VARCHAR(64) NOT NULL,
  `byte_size` BIGINT UNSIGNED NOT NULL,
  `width` INT UNSIGNED NOT NULL,
  `height` INT UNSIGNED NOT NULL,
  `storage_path` VARCHAR(512) NOT NULL,
  `created_by` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_image_asset_doc` (`doc_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='图片资源及访问权限元数据';
