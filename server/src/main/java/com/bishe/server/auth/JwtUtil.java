package com.bishe.server.auth;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import com.auth0.jwt.interfaces.DecodedJWT;
import java.nio.charset.StandardCharsets;
import java.time.Clock;

/**
 * 使用 Auth0 java-jwt 执行标准 JWT 编解码与签名校验；本类约束业务载荷和有效期。
 */
@Component
public class JwtUtil {

    private final byte[] secret;
    private final long expireSeconds;
    private final Clock clock;
    private final com.auth0.jwt.interfaces.JWTVerifier verifier;

    public record JwtClaims(long uid, String subject, String role, long issuedAt, long expiresAt) {
    }

    @Autowired
    public JwtUtil(@Value("${app.jwt.secret}") String secret,
                   @Value("${app.jwt.expire-hours:168}") long expireHours) {
        this(secret, expireHours, Clock.systemUTC());
    }

    JwtUtil(String secret, long expireHours, Clock clock) {
        byte[] raw = secret == null ? new byte[0] : secret.getBytes(StandardCharsets.UTF_8);
        if (raw.length < 32) {
            throw new IllegalStateException("JWT_SECRET 至少需要 32 字节");
        }
        if (expireHours <= 0 || expireHours > 24 * 30L) {
            throw new IllegalStateException("app.jwt.expire-hours 必须在 1 到 720 之间");
        }
        this.secret = raw.clone();
        this.expireSeconds = expireHours * 3600L;
        this.clock = clock;
        this.verifier = ((com.auth0.jwt.JWTVerifier.BaseVerification) JWT.require(Algorithm.HMAC256(this.secret))
                .acceptIssuedAt(60).withClaimPresence("uid").withClaimPresence("sub")
                .withClaimPresence("iat").withClaimPresence("exp")).build(clock);
    }

    /** 标准 JWT 库签发 HS256；业务时钟可注入用于到期测试。 */
    public String sign(long uid, String username, String role) {
        long now = clock.instant().getEpochSecond();
        return JWT.create().withSubject(username).withClaim("uid", uid)
                .withClaim("role", role == null ? "editor" : role)
                .withIssuedAt(java.time.Instant.ofEpochSecond(now))
                .withExpiresAt(java.time.Instant.ofEpochSecond(now + expireSeconds))
                .sign(Algorithm.HMAC256(secret));
    }

    public JwtClaims parse(String token) {
        try {
            if (token == null || token.length() > 8192) throw new IllegalArgumentException("JWT 格式错误");
            DecodedJWT decoded = JWT.decode(token);
            if (!"HS256".equals(decoded.getAlgorithm()) || !"JWT".equals(decoded.getType())) {
                throw new IllegalArgumentException("JWT 算法不受支持");
            }
            decoded = verifier.verify(decoded); // 签名、算法、exp/nbf/iat 由标准库校验。
            Long uid = decoded.getClaim("uid").asLong();
            String subject = decoded.getSubject();
            String role = decoded.getClaim("role").asString();
            long iat = decoded.getIssuedAtAsInstant() == null ? 0 : decoded.getIssuedAtAsInstant().getEpochSecond();
            long exp = decoded.getExpiresAtAsInstant() == null ? 0 : decoded.getExpiresAtAsInstant().getEpochSecond();
            long now = clock.instant().getEpochSecond();
            if (uid == null || uid <= 0 || subject == null || subject.isBlank() || subject.length() > 64
                    || iat <= 0 || exp <= now || iat > now + 60 || exp <= iat || exp - iat > expireSeconds) {
                throw new IllegalArgumentException("JWT 载荷无效或已过期");
            }
            return new JwtClaims(uid, subject, role == null ? "editor" : role, iat, exp);
        } catch (Exception e) {
            throw new IllegalArgumentException("JWT 无效或已过期", e);
        }
    }
}
