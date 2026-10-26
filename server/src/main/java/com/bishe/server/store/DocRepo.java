package com.bishe.server.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

/**
 * 文档元数据仓储（document 表）。T0+9：文档归属空间，读写按空间校验。
 */
@Repository
public class DocRepo {

    private final JdbcTemplate jdbc;

    public DocRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 创建文档，返回新 doc_key。kind: doc|board|kanban */
    public String create(String title, long spaceId, String kind, long createdBy) {
        String key = java.util.UUID.randomUUID().toString();
        jdbc.update("INSERT INTO document(doc_key, title, kind, space_id, created_by) VALUES(?, ?, ?, ?, ?)",
                key, title, kind == null ? "doc" : kind, spaceId, createdBy);
        return key;
    }

    /** 指定空间内的文档列表（按更新时间倒序）；kind 为空则全部。 */
    public List<Map<String, Object>> listBySpace(long spaceId, long uid, String kind) {
        String where = "d.space_id = ? AND d.deleted_at IS NULL"
                + (kind == null ? "" : " AND d.kind = ?");
        Object[] args = kind == null
                ? new Object[]{uid, spaceId}
                : new Object[]{uid, spaceId, kind};
        return jdbc.queryForList("""
                SELECT d.doc_key, d.title, d.kind, d.created_at, d.updated_at, d.space_id,
                       s.name AS space_name, sm.role AS my_role
                FROM document d
                JOIN space s ON s.id = d.space_id
                JOIN space_member sm ON sm.space_id = d.space_id AND sm.user_id = ?
                WHERE %s ORDER BY d.updated_at DESC""".formatted(where), args);
    }

    /** 我能看到的所有空间的文档；kind 为空时全部。 */
    public List<Map<String, Object>> listVisible(long uid, String kind) {
        String where = kind == null ? "d.deleted_at IS NULL" : "d.deleted_at IS NULL AND d.kind = ?";
        Object[] params = kind == null ? new Object[]{uid} : new Object[]{uid, kind};
        return jdbc.queryForList("""
                SELECT d.doc_key, d.title, d.kind, d.created_at, d.updated_at, d.space_id,
                       s.name AS space_name, sm.role AS my_role
                FROM document d
                JOIN space s ON s.id = d.space_id
                JOIN space_member sm ON sm.space_id = d.space_id AND sm.user_id = ?
                WHERE %s ORDER BY d.updated_at DESC""".formatted(where), params);
    }

    /** 查询单个文档元信息（含空间归属）；不存在返回 null。 */
    public Map<String, Object> get(String docKey) {
        List<Map<String, Object>> r = jdbc.queryForList("""
                SELECT d.doc_key, d.title, d.kind, d.created_by, d.created_at, d.updated_at,
                       d.space_id, s.name AS space_name
                FROM document d JOIN space s ON s.id = d.space_id
                WHERE d.doc_key = ? AND d.deleted_at IS NULL""", docKey);
        return r.isEmpty() ? null : r.get(0);
    }

    /** 回收站只在空间管理员仍有成员资格时返回已删除内容。 */
    public List<Map<String, Object>> listDeletedBySpace(long spaceId, long uid) {
        return jdbc.queryForList("""
                SELECT d.doc_key, d.title, d.kind, d.space_id, s.name AS space_name,
                       d.deleted_at, d.updated_at, sm.role AS my_role
                FROM document d
                JOIN space s ON s.id = d.space_id
                JOIN space_member sm ON sm.space_id = d.space_id AND sm.user_id = ?
                WHERE d.space_id = ? AND d.deleted_at IS NOT NULL AND sm.role IN ('owner', 'admin')
                ORDER BY d.deleted_at DESC, d.doc_key
                """, uid, spaceId);
    }

    /** 用于恢复校验；包含软删除元数据，但不允许通过 doc_key 探测其他空间。 */
    public Map<String, Object> getVisibleIncludingDeleted(String docKey, long uid) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT d.doc_key, d.title, d.kind, d.space_id, d.deleted_at, sm.role AS my_role
                FROM document d
                JOIN space s ON s.id = d.space_id
                JOIN space_member sm ON sm.space_id = d.space_id AND sm.user_id = ?
                WHERE d.doc_key = ?
                """, uid, docKey);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** 仅恢复所属空间管理员可见的软删除记录；不改动正文、图片、历史或原类型。 */
    public boolean restoreDeleted(String docKey, long uid) {
        return jdbc.update("""
                UPDATE document d
                JOIN space_member sm ON sm.space_id = d.space_id AND sm.user_id = ?
                SET d.deleted_at = NULL, d.updated_at = CURRENT_TIMESTAMP
                WHERE d.doc_key = ? AND d.deleted_at IS NOT NULL AND sm.role IN ('owner', 'admin')
                """, uid, docKey) > 0;
    }

    /** 只查归属空间（WS 守卫用）；不存在返回 -1。 */
    public long spaceIdOf(String docKey) {
        List<Long> r = jdbc.queryForList(
                "SELECT space_id FROM document WHERE doc_key = ? AND deleted_at IS NULL", Long.class, docKey);
        return r.isEmpty() ? -1L : r.get(0);
    }

    /** 标题命中（我的空间内）。 */
    public List<Map<String, Object>> searchTitle(long uid, String like) {
        return jdbc.queryForList("""
                SELECT d.doc_key, d.title, s.name AS space_name, 'title' AS hit
                FROM document d
                JOIN space s ON s.id = d.space_id
                JOIN space_member sm ON sm.space_id = d.space_id AND sm.user_id = ?
                WHERE d.deleted_at IS NULL AND d.title LIKE ? ORDER BY d.updated_at DESC LIMIT 20""", uid, like);
    }

    /** 正文命中（op 存储值命中，我的空间内，去重）。 */
    public List<Map<String, Object>> searchBody(long uid, String like) {
        return jdbc.queryForList("""
                SELECT DISTINCT d.doc_key, d.title, d.kind, s.name AS space_name,
                                'body' AS hit, d.updated_at
                FROM operation_log o
                JOIN document d ON d.doc_key = o.doc_id
                JOIN space s ON s.id = d.space_id
                JOIN space_member sm ON sm.space_id = d.space_id AND sm.user_id = ?
                WHERE d.deleted_at IS NULL AND o.value_json LIKE ?
                ORDER BY d.updated_at DESC LIMIT 20""", uid, like);
    }

    /** 平台级统计（总用户/空间/文档/操作数）。 */
    public Map<String, Long> platformCounts() {
        Map<String, Long> out = new java.util.LinkedHashMap<>();
        out.put("users", jdbc.queryForObject("SELECT COUNT(*) FROM `user`", Long.class));
        out.put("spaces", jdbc.queryForObject("SELECT COUNT(*) FROM space", Long.class));
        out.put("docs", jdbc.queryForObject("SELECT COUNT(*) FROM document WHERE deleted_at IS NULL", Long.class));
        out.put("ops", jdbc.queryForObject("SELECT COUNT(*) FROM operation_log", Long.class));
        return out;
    }

    /** 软删除文档；操作日志与快照保留，满足 append-only 历史审计。 */
    public boolean delete(String docKey) {
        return jdbc.update("UPDATE document SET deleted_at=NOW() WHERE doc_key=? AND deleted_at IS NULL", docKey) > 0;
    }

    /** 更新当前有效文档的标题。 */
    public boolean updateTitle(String docKey, String title) {
        return jdbc.update("UPDATE document SET title=?, updated_at=NOW()"
                + " WHERE doc_key=? AND deleted_at IS NULL", title, docKey) > 0;
    }
}
