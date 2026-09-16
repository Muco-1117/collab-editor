package com.bishe.server.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;
import java.util.Map;

/**
 * 空间与成员（space / space_member 表）。空间 = 文档隔离单元。
 */
@Repository
public class SpaceRepo {

    private final JdbcTemplate jdbc;

    public SpaceRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 创建空间并让创建者成为 admin。返回空间 id。 */
    public long create(String name, long ownerId) {
        KeyHolder kh = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(
                    "INSERT INTO space(name, owner_id) VALUES(?, ?)", Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, name);
            ps.setLong(2, ownerId);
            return ps;
        }, kh);
        long sid = kh.getKey().longValue();
        jdbc.update("INSERT INTO space_member(space_id, user_id, role) VALUES(?, ?, 'admin')", sid, ownerId);
        return sid;
    }

    /** 我加入的空间列表（含文档数与成员数）。 */
    public List<Map<String, Object>> listForUser(long uid) {
        return jdbc.queryForList("""
                SELECT s.id, s.name, s.owner_id, m.role AS my_role,
                       (SELECT COUNT(*) FROM document d WHERE d.space_id = s.id) AS doc_count,
                       (SELECT COUNT(*) FROM space_member sm WHERE sm.space_id = s.id) AS member_count
                FROM space s JOIN space_member m ON m.space_id = s.id
                WHERE m.user_id = ? ORDER BY s.id DESC""", uid);
    }

    /** 空间成员列表。 */
    public List<Map<String, Object>> members(long spaceId) {
        return jdbc.queryForList("""
                SELECT u.id, u.username, u.nickname, sm.role
                FROM space_member sm JOIN `user` u ON u.id = sm.user_id
                WHERE sm.space_id = ? ORDER BY sm.role DESC, u.id""", spaceId);
    }

    /** 成员角色；非成员返回 null。 */
    public String roleOf(long spaceId, long uid) {
        List<String> r = jdbc.queryForList(
                "SELECT role FROM space_member WHERE space_id = ? AND user_id = ?", String.class, spaceId, uid);
        return r.isEmpty() ? null : r.get(0);
    }

    /** 邀请成员（覆盖角色），返回是否成功（uid 存在的成员行 upsert）。 */
    public void addMember(long spaceId, long uid, String role) {
        jdbc.update("""
                INSERT INTO space_member(space_id, user_id, role) VALUES(?, ?, ?)
                ON DUPLICATE KEY UPDATE role = VALUES(role)""", spaceId, uid, role);
    }
}