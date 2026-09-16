package com.bishe.server.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

/**
 * 文档元数据仓储（document 表）。
 * P0 阶段：单空间、无鉴权，doc_key 即 WS 房间键。
 */
@Repository
public class DocRepo {

    private final JdbcTemplate jdbc;

    public DocRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 创建文档，返回新 doc_key。 */
    public String create(String title) {
        String key = java.util.UUID.randomUUID().toString();
        jdbc.update("INSERT INTO document(doc_key, title) VALUES(?, ?)", key, title);
        return key;
    }

    /** 全部文档（按更新时间倒序）。 */
    public List<Map<String, Object>> list() {
        return jdbc.queryForList(
                "SELECT doc_key, title, created_at, updated_at FROM document ORDER BY updated_at DESC");
    }

    /** 查询单个文档元信息。 */
    public Map<String, Object> get(String docKey) {
        List<Map<String, Object>> r = jdbc.queryForList(
                "SELECT doc_key, title, created_at, updated_at FROM document WHERE doc_key=?", docKey);
        return r.isEmpty() ? null : r.get(0);
    }

    /** 物理删除文档及其协同数据（op 日志 + 快照）。 */
    public boolean delete(String docKey) {
        jdbc.update("DELETE FROM operation_log WHERE doc_id=?", docKey);
        jdbc.update("DELETE FROM element_snapshot WHERE doc_id=?", docKey);
        return jdbc.update("DELETE FROM document WHERE doc_key=?", docKey) > 0;
    }
}