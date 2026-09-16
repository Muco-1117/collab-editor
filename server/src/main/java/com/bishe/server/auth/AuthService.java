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

    public AuthService(JdbcTemplate jdbc, JwtUtil jwt) {
        this.jdbc = jdbc;
        this.jwt = jwt;
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
        return new UserPub(id == null ? -1 : id.longValue(), username,
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
}