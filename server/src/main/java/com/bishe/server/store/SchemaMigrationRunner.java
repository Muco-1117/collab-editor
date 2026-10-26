package com.bishe.server.store;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 对早期开发数据库执行幂等、非破坏的补列迁移。
 * 新部署仍以 db/init.sql 为准；这里保证已有数据无需删库重建。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class SchemaMigrationRunner implements ApplicationRunner {

    private final JdbcTemplate jdbc;

    public SchemaMigrationRunner(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void run(ApplicationArguments args) {
        addColumnIfMissing("user", "avatar_data", "ALTER TABLE `user` ADD COLUMN avatar_data MEDIUMBLOB NULL");
        addColumnIfMissing("user", "avatar_version", "ALTER TABLE `user` ADD COLUMN avatar_version VARCHAR(36) NULL");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS image_asset (
                  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                  asset_id VARCHAR(64) NOT NULL UNIQUE,
                  doc_id VARCHAR(64) NOT NULL,
                  original_name VARCHAR(255) NOT NULL,
                  mime_type VARCHAR(64) NOT NULL,
                  byte_size BIGINT UNSIGNED NOT NULL,
                  width INT UNSIGNED NOT NULL,
                  height INT UNSIGNED NOT NULL,
                  storage_path VARCHAR(512) NOT NULL,
                  created_by BIGINT UNSIGNED NOT NULL,
                  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  KEY idx_image_asset_doc (doc_id, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """);
        addColumnIfMissing("document", "kind",
                "ALTER TABLE document ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'doc' AFTER title");
        addColumnIfMissing("document", "deleted_at",
                "ALTER TABLE document ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL AFTER updated_at");
        addIndexIfMissing("document", "idx_document_space_active",
                "ALTER TABLE document ADD INDEX idx_document_space_active (space_id, deleted_at, updated_at)");
        addColumnIfMissing("operation_log", "element_type",
                "ALTER TABLE operation_log ADD COLUMN element_type VARCHAR(16) NULL AFTER element_id");
        addColumnIfMissing("operation_log", "operation_id",
                "ALTER TABLE operation_log ADD COLUMN operation_id VARCHAR(96) NULL AFTER doc_id");
        addColumnIfMissing("operation_log", "actor_id",
                "ALTER TABLE operation_log ADD COLUMN actor_id BIGINT UNSIGNED NULL AFTER operation_id");
        widenOperationValueColumn();
        addIndexIfMissing("operation_log", "uk_doc_operation_id",
                "ALTER TABLE operation_log ADD UNIQUE INDEX uk_doc_operation_id (doc_id, operation_id)");
        backfillLegacyElementTypes();
        jdbc.update("UPDATE space_member SET role = 'owner' WHERE role = 'admin'");
    }

    private void addColumnIfMissing(String table, String column, String ddl) {
        Integer count = jdbc.queryForObject("""
                SELECT COUNT(*) FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
                """, Integer.class, table, column);
        if (count != null && count == 0) {
            jdbc.execute(ddl);
        }
    }

    private void addIndexIfMissing(String table, String index, String ddl) {
        Integer count = jdbc.queryForObject("""
                SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
                """, Integer.class, table, index);
        if (count != null && count == 0) {
            jdbc.execute(ddl);
        }
    }

    private void widenOperationValueColumn() {
        String type = jdbc.queryForObject("""
                SELECT DATA_TYPE FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'operation_log'
                  AND column_name = 'value_json'
                """, String.class);
        if (type != null && !"mediumtext".equalsIgnoreCase(type)) {
            jdbc.execute("ALTER TABLE operation_log MODIFY COLUMN value_json MEDIUMTEXT NULL");
        }
    }

    private void backfillLegacyElementTypes() {
        jdbc.update("""
                UPDATE operation_log o
                JOIN document d ON d.doc_key = o.doc_id
                LEFT JOIN (
                    SELECT doc_id, element_id,
                           MAX(CASE WHEN field = 'column' THEN 1 ELSE 0 END) AS is_card
                    FROM operation_log GROUP BY doc_id, element_id
                ) shape ON shape.doc_id = o.doc_id AND shape.element_id = o.element_id
                SET o.element_type = CASE
                    WHEN o.element_id = 'doc-root' THEN 'DOC'
                    WHEN o.element_id = 'seg-root-01' THEN 'TEXT'
                    WHEN d.kind = 'doc' THEN 'TEXT'
                    WHEN d.kind = 'board' THEN 'CARD'
                    WHEN d.kind = 'kanban' AND shape.is_card = 1 THEN 'CARD'
                    WHEN d.kind = 'kanban' THEN 'COLUMN'
                    ELSE 'TEXT'
                END
                WHERE o.element_type IS NULL
                """);
    }
}
