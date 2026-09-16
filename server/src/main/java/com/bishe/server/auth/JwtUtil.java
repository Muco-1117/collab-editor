package com.bishe.server.auth;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;

/**
 * JWT 签发与解析（HS256，无状态会话）。
 */
@Component
public class JwtUtil {

    private final SecretKey key;
    private final long expireMillis;

    public JwtUtil(@Value("${app.jwt.secret}") String secret,
                   @Value("${app.jwt.expire-hours:168}") long expireHours) {
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.expireMillis = expireHours * 3600_000L;
    }

    /** 签发：subject=username，附 uid/role。 */
    public String sign(long uid, String username, String role) {
        Date now = new Date();
        return Jwts.builder()
                .subject(username)
                .claim("uid", uid)
                .claim("role", role)
                .issuedAt(now)
                .expiration(new Date(now.getTime() + expireMillis))
                .signWith(key)
                .compact();
    }

    /**
     * 解析并校验签名/过期。失败抛 RuntimeException（由 filter 转 401）。
     */
    public Claims parse(String token) {
        return Jwts.parser().verifyWith(key).build()
                .parseSignedClaims(token).getPayload();
    }

    /** 尝试取 uid，失败返回 -1（等价于未登录）。 */
    public long uidOr(Claims claims) {
        Object v = claims.get("uid");
        if (v instanceof Number n) return n.longValue();
        return -1L;
    }
}