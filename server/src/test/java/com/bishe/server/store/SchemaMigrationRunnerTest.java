package com.bishe.server.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.util.concurrent.ThreadLocalRandom;

import static org.junit.jupiter.api.Assertions.assertEquals;

@SpringBootTest
@ActiveProfiles("test")
class SchemaMigrationRunnerTest {

    @Autowired
    SchemaMigrationRunner migration;

    @Autowired
    JdbcTemplate jdbc;

    private final long spaceId = ThreadLocalRandom.current().nextLong(1_000_000_000L, Long.MAX_VALUE);
    private final long userId = ThreadLocalRandom.current().nextLong(1_000_000_000L, Long.MAX_VALUE);

    @AfterEach
    void clean() {
        jdbc.update("DELETE FROM space_member WHERE space_id = ? AND user_id = ?", spaceId, userId);
    }

    @Test
    void schemaAndRoleMigrationAreIdempotent() throws Exception {
        assertEquals(1, schemaObjectCount("user", "columns", "column_name", "avatar_data"));
        assertEquals(1, schemaObjectCount("user", "columns", "column_name", "avatar_version"));
        assertEquals(1, schemaObjectCount("document", "columns", "column_name", "deleted_at"));
        assertEquals(1, schemaObjectCount("document", "statistics", "index_name", "idx_document_space_active"));
        assertEquals(1, schemaObjectCount("operation_log", "columns", "column_name", "operation_id"));
        assertEquals(1, schemaObjectCount("operation_log", "columns", "column_name", "actor_id"));
        assertEquals("mediumtext", jdbc.queryForObject("""
                SELECT DATA_TYPE FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = 'operation_log'
                  AND column_name = 'value_json'
                """, String.class));
        assertEquals(1, schemaObjectCount(
                "operation_log", "statistics", "index_name", "uk_doc_operation_id"));

        jdbc.update("INSERT INTO space_member(space_id, user_id, role) VALUES (?, ?, 'admin')", spaceId, userId);
        DefaultApplicationArguments noArgs = new DefaultApplicationArguments(new String[0]);
        migration.run(noArgs);
        migration.run(noArgs);

        assertEquals("owner", jdbc.queryForObject(
                "SELECT role FROM space_member WHERE space_id = ? AND user_id = ?",
                String.class, spaceId, userId));
    }

    private int schemaObjectCount(String table, String informationSchemaTable,
                                  String nameColumn, String name) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(DISTINCT " + nameColumn + ") FROM information_schema." + informationSchemaTable
                        + " WHERE table_schema = DATABASE() AND table_name = ? AND " + nameColumn + " = ?",
                Integer.class, table, name);
        return count == null ? 0 : count;
    }
}
