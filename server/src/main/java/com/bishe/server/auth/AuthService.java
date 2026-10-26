package com.bishe.server.auth;

import com.bishe.server.validation.TextRules;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 注册 / 登录 / 会话主体。BCrypt 存密；JWT 无状态会话。
 */
@Service
public class AuthService {

    private static final Pattern USERNAME = Pattern.compile("[A-Za-z0-9_-]{3,32}");

    public record UserPub(long id, String username, String nickname, String role, String avatarUrl) {
        public UserPub(long id, String username, String nickname, String role) {
            this(id, username, nickname, role, "");
        }
    }

    public static String avatarUrl(long uid, String version) {
        return version == null || version.isBlank() ? "" : "/api/users/" + uid + "/avatar?v=" + version;
    }

    private final JdbcTemplate jdbc;
    private final JwtUtil jwt;
    private final com.bishe.server.store.SpaceRepo spaceRepo;

    public AuthService(JdbcTemplate jdbc, JwtUtil jwt, com.bishe.server.store.SpaceRepo spaceRepo) {
        this.jdbc = jdbc;
        this.jwt = jwt;
        this.spaceRepo = spaceRepo;
    }

    /** 注册。用户名已存在 → 抛 IllegalArgumentException("用户名已存在")。 */
    @Transactional
    public UserPub register(String username, String password, String nickname) {
        String normalized = username == null ? "" : username.trim();
        if (!USERNAME.matcher(normalized).matches()) {
            throw new IllegalArgumentException("用户名需为 3-32 位字母、数字、下划线或连字符");
        }
        if (password == null || password.length() < 6 || exceedsPasswordBytes(password)) {
            throw new IllegalArgumentException("密码至少 6 位，UTF-8 编码不能超过 72 字节（汉字通常占 3 字节）");
        }
        Integer dup = jdbc.queryForObject(
                "SELECT COUNT(*) FROM `user` WHERE username = ?", Integer.class, normalized);
        if (dup != null && dup > 0) throw new IllegalArgumentException("用户名已存在");

        String displayName = nickname == null || nickname.isBlank() ? normalized : nickname.trim();
        if (displayName.length() > 32 || TextRules.containsControl(displayName)) {
            throw new IllegalArgumentException("昵称最长 32 字且不能包含控制字符");
        }

        KeyHolder kh = new GeneratedKeyHolder();
        try {
            jdbc.update(con -> {
                PreparedStatement ps = con.prepareStatement(
                        "INSERT INTO `user`(username, password, nickname, role) VALUES (?,?,?,?)",
                        Statement.RETURN_GENERATED_KEYS);
                ps.setString(1, normalized);
                ps.setString(2, org.mindrot.jbcrypt.BCrypt.hashpw(
                        password, org.mindrot.jbcrypt.BCrypt.gensalt(12)));
                ps.setString(3, displayName);
                ps.setString(4, "editor");
                return ps;
            }, kh);
        } catch (org.springframework.dao.DuplicateKeyException e) {
            throw new IllegalArgumentException("用户名已存在", e);
        }
        Number id = kh.getKey();
        if (id == null) {
            throw new IllegalStateException("创建用户后未返回主键");
        }
        long uid = id.longValue();
        spaceRepo.create("我的空间", uid);
        return new UserPub(uid, normalized, displayName, "editor");
    }

    /** 登录校验。失败 → IllegalArgumentException("用户名或密码错误")。 */
    public String login(String username, String password) {
        if (username == null || password == null || exceedsPasswordBytes(password)) {
            throw new IllegalArgumentException("用户名或密码错误");
        }
        Map<String, Object> row;
        try {
            row = jdbc.queryForMap(
                    "SELECT id, username, nickname, password, role FROM `user` WHERE username = ?", username.trim());
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            throw new IllegalArgumentException("用户名或密码错误");
        }
        try {
            if (!org.mindrot.jbcrypt.BCrypt.checkpw(password, (String) row.get("password"))) {
                throw new IllegalArgumentException("用户名或密码错误");
            }
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("用户名或密码错误");
        }
        long uid = ((Number) row.get("id")).longValue();
        String role = (String) row.get("role");
        return jwt.sign(uid, (String) row.get("username"), role == null ? "editor" : role);
    }

    public String issueToken(UserPub user) {
        return jwt.sign(user.id(), user.username(), user.role());
    }

    public UserPub byId(long uid) {
        return jdbc.queryForObject(
                "SELECT id, username, nickname, role, avatar_version FROM `user` WHERE id = ?",
                (rs, n) -> new UserPub(rs.getLong("id"), rs.getString("username"),
                        rs.getString("nickname"), rs.getString("role"), avatarUrl(rs.getLong("id"), rs.getString("avatar_version"))), uid);
    }

    /** byId 的判空版；用户被删/不存在返回 null。 */
    public UserPub byIdOrNull(long uid) {
        try {
            return byId(uid);
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            return null;
        }
    }

    /** 按用户名查用户；不存在返回 null。 */
    public UserPub byUsername(String username) {
        try {
            return jdbc.queryForObject(
                    "SELECT id, username, nickname, role, avatar_version FROM `user` WHERE username = ?",
                    (rs, n) -> new UserPub(rs.getLong("id"), rs.getString("username"),
                            rs.getString("nickname"), rs.getString("role"), avatarUrl(rs.getLong("id"), rs.getString("avatar_version"))), username);
        } catch (org.springframework.dao.EmptyResultDataAccessException e) {
            return null;
        }
    }

    public UserPub updateNickname(long uid, String nickname) {
        String name = nickname == null ? "" : nickname.trim();
        if (name.isBlank() || name.length() > 32 || TextRules.containsControl(name)) {
            throw new IllegalArgumentException("昵称需为 1-32 字且不能包含控制字符");
        }
        jdbc.update("UPDATE `user` SET nickname = ? WHERE id = ?", name, uid);
        return byId(uid);
    }

    private static boolean exceedsPasswordBytes(String password) {
        return password.length() > 72 || password.getBytes(StandardCharsets.UTF_8).length > 72;
    }
}
