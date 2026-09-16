package com.bishe.server.auth;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.Map;

/**
 * 注册 / 登录 / 会话主体。BCrypt 存密；JWT 无状态会话。
 */
@Service
public class AuthService {

    public record UserPub(long id, String username, String nickname, String role) {}

    private final JdbcTemplate jdbc;
    private final JwtUtil jwt;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();
    private final com.bishe.server.store.SpaceRepo spaceRepo;

    public AuthService(JdbcTemplate jdbc, JwtUtil jwt, com.bishe.server.store.SpaceRepo spaceRepo) {
        this.jdbc = jdbc;
        this.jwt = jwt;
        this.spaceRepo = spaceRepo;
    }

    /** 注册。用户名已存在 → 抛 IllegalArgumentException("用户名已存在")。 */
    public UserPub register(String username, String password, String nickname) {
        if (username == null || username.isBlank() || password == null || password.length() < 6) {
            throw new IllegalArgumentException("用户名不能为空且密码至少 6 位");
        }
        Integer dup = jdbc.queryForObject(
                "SELECT COUNT(*) FROM `user` WHERE username = ?", Integer.class, username);
        if (dup != null && dup > 0) throw new IllegalArgumentException("用户名已存在");

        KeyHolder kh = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(
                    "INSERT INTO `user`(username, password, nickname, role) VALUES (?,?,?,?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, username);
            ps.setString(2, encoder.encode(password));
            ps.setString(3, nickname == null || nickname.isBlank() ? username : nickname);
            ps.setString(4, "editor");
            return ps;
        }, kh);
        Number id = kh.getKey();
        long uid = id == null ? -1 : id.longValue();
        // 注册即建默认空间（新用户落地即可建文档/看板，不必先手动建空间）
        if (uid > 0) {
            try {
                spaceRepo.create("我的空间", uid); // create 内部已插入 owner/admin 成员行
            } catch (Exception ignore) {
                // 默认空间创建失败不阻断注册
            }
        }
        return new UserPub(uid, username,
                nickname == null || nickname.isBlank() ? username : nickname, "editor");
    }

    /** 登录校验。失败 → IllegalArgumentException("用户名或密码错误")。 */
    public String login(String username, String password) {
        Map<String, Object> row;
        try {
            row = jdbc.queryForMap(
                    "SELECT id, username, nickname, password, role FROM `user` WHERE username = ?", username);
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            throw new IllegalArgumentException("用户名或密码错误");
        }
        if (!encoder.matches(password, (String) row.get("password"))) {
            throw new IllegalArgumentException("用户名或密码错误");
        }
        long uid = ((Number) row.get("id")).longValue();
        String role = (String) row.get("role");
        return jwt.sign(uid, username, role == null ? "editor" : role);
    }

    public UserPub byId(long uid) {
        return jdbc.queryForObject(
                "SELECT id, username, nickname, role FROM `user` WHERE id = ?",
                (rs, n) -> new UserPub(rs.getLong("id"), rs.getString("username"),
                        rs.getString("nickname"), rs.getString("role")), uid);
    }

    /** byId 的判空版；用户被删/不存在返回 null。 */
    public UserPub byIdOrNull(long uid) {
        try {
            return byId(uid);
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            return null;
        }
    }

    /** 个人中心聚合：基本信息 + 注册时间 + 我的空间/文档/操作统计。 */
    public Map<String, Object> profile(long uid) {
        Map<String, Object> row = jdbc.queryForMap(
                "SELECT username, nickname, role, created_at FROM `user` WHERE id = ?", uid);
        long spaces = jdbc.queryForObject(
                "SELECT COUNT(*) FROM space_member WHERE user_id = ?", Long.class, uid);
        long docs = jdbc.queryForObject(
                "SELECT COUNT(*) FROM document d JOIN space_member sm ON sm.space_id = d.space_id WHERE sm.user_id = ?",
                Long.class, uid);
        long ops = jdbc.queryForObject(
                "SELECT COUNT(*) FROM operation_log o JOIN document d ON d.doc_key = o.doc_id " +
                        "JOIN space_member sm ON sm.space_id = d.space_id WHERE sm.user_id = ?",
                Long.class, uid);
        row.put("spaces", spaces);
        row.put("docs", docs);
        row.put("ops", ops);
        return row;
    }

    /** 修改昵称（1–16 字符，可含中文/字母/数字）。 */
    public Map<String, Object> updateNickname(long uid, String nickname) {
        if (nickname == null || nickname.isBlank()) throw new IllegalArgumentException("昵称不能为空");
        String n = nickname.trim();
        if (n.length() > 16) throw new IllegalArgumentException("昵称最长 16 字");
        jdbc.update("UPDATE `user` SET nickname = ? WHERE id = ?", n, uid);
        return profile(uid);
    }

    /** 按用户名查用户；不存在返回 null。 */
    public UserPub byUsername(String username) {
        try {
            return jdbc.queryForObject(
                    "SELECT id, username, nickname, role FROM `user` WHERE username = ?",
                    (rs, n) -> new UserPub(rs.getLong("id"), rs.getString("username"),
                            rs.getString("nickname"), rs.getString("role")), username);
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            return null;
        }
    }
}