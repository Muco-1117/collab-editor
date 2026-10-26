package com.bishe.server.auth;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class JwtUtilTest {

    private static final String SECRET = "test-only-jwt-secret-0123456789abcdef";
    private static final String OTHER_SECRET = "different-test-secret-0123456789abcdef";
    private static final Instant NOW = Instant.parse("2026-09-20T02:00:00Z");

    @Test
    void signsAndParsesClaims() {
        JwtUtil jwt = jwt(SECRET, NOW);

        JwtUtil.JwtClaims claims = jwt.parse(jwt.sign(42, "alice", "owner"));

        assertEquals(42, claims.uid());
        assertEquals("alice", claims.subject());
        assertEquals("owner", claims.role());
        assertEquals(NOW.getEpochSecond(), claims.issuedAt());
        assertEquals(NOW.plusSeconds(3600).getEpochSecond(), claims.expiresAt());
    }

    @Test
    void rejectsTamperedPayload() {
        JwtUtil jwt = jwt(SECRET, NOW);
        String[] parts = jwt.sign(42, "alice", "editor").split("\\.");
        char replacement = parts[1].charAt(0) == 'A' ? 'B' : 'A';
        parts[1] = replacement + parts[1].substring(1);

        assertThrows(IllegalArgumentException.class, () -> jwt.parse(String.join(".", parts)));
    }

    @Test
    void rejectsUnsupportedAlgorithm() {
        JwtUtil jwt = jwt(SECRET, NOW);
        String[] parts = jwt.sign(42, "alice", "editor").split("\\.");
        parts[0] = Base64.getUrlEncoder().withoutPadding().encodeToString(
                "{\"alg\":\"HS512\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));

        assertThrows(IllegalArgumentException.class, () -> jwt.parse(String.join(".", parts)));
    }

    @Test
    void rejectsExpiredToken() {
        String token = jwt(SECRET, NOW).sign(42, "alice", "editor");
        JwtUtil afterExpiry = jwt(SECRET, NOW.plusSeconds(3601));

        assertThrows(IllegalArgumentException.class, () -> afterExpiry.parse(token));
    }

    @Test
    void rejectsTokenSignedWithAnotherSecret() {
        String token = jwt(SECRET, NOW).sign(42, "alice", "editor");

        assertThrows(IllegalArgumentException.class, () -> jwt(OTHER_SECRET, NOW).parse(token));
    }

    private static JwtUtil jwt(String secret, Instant instant) {
        return new JwtUtil(secret, 1, Clock.fixed(instant, ZoneOffset.UTC));
    }
}
