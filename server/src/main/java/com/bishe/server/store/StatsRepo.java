package com.bishe.server.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 基于当前用户可见文档及 append-only 操作日志生成协同统计。 */
@Repository
public class StatsRepo {

    private final JdbcTemplate jdbc;

    public StatsRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Map<String, Object> forUser(long userId) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("spaces", count("SELECT COUNT(*) FROM space_member WHERE user_id=?", userId));
        result.put("documents", count("""
                SELECT COUNT(*) FROM document d
                JOIN space_member sm ON sm.space_id=d.space_id AND sm.user_id=?
                WHERE d.deleted_at IS NULL
                """, userId));
        result.put("operations", count("""
                SELECT COUNT(*) FROM operation_log o
                JOIN document d ON d.doc_key=o.doc_id
                JOIN space_member sm ON sm.space_id=d.space_id AND sm.user_id=?
                WHERE d.deleted_at IS NULL
                """, userId));
        Long ownOperations = jdbc.queryForObject("""
                SELECT COUNT(*) FROM operation_log o
                JOIN document d ON d.doc_key=o.doc_id
                JOIN space_member sm ON sm.space_id=d.space_id AND sm.user_id=?
                WHERE d.deleted_at IS NULL AND o.actor_id=?
                """, Long.class, userId, userId);
        result.put("ownOperations", ownOperations == null ? 0 : ownOperations);
        result.put("byApplication", jdbc.queryForList("""
                SELECT d.kind, COUNT(o.id) AS operation_count
                FROM document d
                JOIN space_member sm ON sm.space_id=d.space_id AND sm.user_id=?
                LEFT JOIN operation_log o ON o.doc_id=d.doc_key
                WHERE d.deleted_at IS NULL
                GROUP BY d.kind ORDER BY d.kind
                """, userId));
        result.put("byOperation", jdbc.queryForList("""
                SELECT SUBSTRING_INDEX(o.clock, '|', 1) AS operation_type,
                       COUNT(*) AS operation_count
                FROM operation_log o
                JOIN document d ON d.doc_key=o.doc_id
                JOIN space_member sm ON sm.space_id=d.space_id AND sm.user_id=?
                WHERE d.deleted_at IS NULL
                GROUP BY SUBSTRING_INDEX(o.clock, '|', 1)
                ORDER BY operation_type
                """, userId));
        result.put("recentActivity", jdbc.queryForList("""
                SELECT DATE_FORMAT(days.activity_date, '%Y-%m-%d') AS activity_date,
                       COALESCE(activity.operation_count, 0) AS operation_count
                FROM (
                    SELECT CURRENT_DATE - INTERVAL offsets.day_offset DAY AS activity_date
                    FROM (SELECT 0 AS day_offset UNION ALL SELECT 1 UNION ALL SELECT 2
                          UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) offsets
                ) days
                LEFT JOIN (
                    SELECT DATE(o.created_at) AS activity_date, COUNT(*) AS operation_count
                    FROM operation_log o
                    JOIN document d ON d.doc_key=o.doc_id
                    JOIN space_member sm ON sm.space_id=d.space_id AND sm.user_id=?
                    WHERE d.deleted_at IS NULL
                      AND o.created_at >= CURRENT_DATE - INTERVAL 6 DAY
                      AND o.created_at < CURRENT_DATE + INTERVAL 1 DAY
                    GROUP BY DATE(o.created_at)
                ) activity ON activity.activity_date = days.activity_date
                ORDER BY days.activity_date
                """, userId));
        result.put("contributors", jdbc.queryForList("""
                SELECT COALESCE(o.actor_id, 0) AS actor_id,
                       COALESCE(NULLIF(u.nickname, ''), u.username, '系统') AS actor_name,
                       COUNT(*) AS operation_count
                FROM operation_log o
                JOIN document d ON d.doc_key=o.doc_id
                JOIN space_member sm ON sm.space_id=d.space_id AND sm.user_id=?
                LEFT JOIN `user` u ON u.id=o.actor_id
                WHERE d.deleted_at IS NULL
                GROUP BY o.actor_id, u.nickname, u.username
                ORDER BY operation_count DESC, actor_name, actor_id LIMIT 10
                """, userId));
        return result;
    }

    private long count(String sql, long userId) {
        Long value = jdbc.queryForObject(sql, Long.class, userId);
        return value == null ? 0 : value;
    }
}
