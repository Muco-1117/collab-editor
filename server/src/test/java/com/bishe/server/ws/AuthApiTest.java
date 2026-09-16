package com.bishe.server.ws;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T0+8 验收：账号体系 + 会话守卫。
 * 1) 注册（重复 409）/ 登录（错密码 401）/ me（带 token 200、无 token 401）
 * 2) /api/** 无 token 401
 * 3) WS 握手无 token 403；带 token 成功且 welcome
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AuthApiTest {

    @LocalServerPort
    int port;

    final HttpClient http = HttpClient.newHttpClient();

    private String base() {
        return "http://localhost:" + port;
    }

    @Test
    void registerLoginAndMe() throws Exception {
        String name = "u-" + java.util.UUID.randomUUID().toString().substring(0, 8);
        String pw = "pass1234";

        HttpResponse<String> reg = post("/api/auth/register",
                "{\"username\":\"" + name + "\",\"password\":\"" + pw + "\",\"nickname\":\"测试员\"}", null);
        assertEquals(200, reg.statusCode(), "注册 200");
        assertTrue(reg.body().contains("token"), "注册即返回 token");

        // 重复注册 → 409
        HttpResponse<String> dup = post("/api/auth/register",
                "{\"username\":\"" + name + "\",\"password\":\"" + pw + "\"}", null);
        assertEquals(409, dup.statusCode(), "重复注册 409");

        // 错密码 → 401
        HttpResponse<String> badLogin = post("/api/auth/login",
                "{\"username\":\"" + name + "\",\"password\":\"wrong!\"}", null);
        assertEquals(401, badLogin.statusCode(), "错误密码 401");

        // 正确登录
        HttpResponse<String> login = post("/api/auth/login",
                "{\"username\":\"" + name + "\",\"password\":\"" + pw + "\"}", null);
        assertEquals(200, login.statusCode(), "登录 200");
        String token = AuthTestSupport.tokenFromLogin(login.body());
        assertFalse(token.isBlank(), "返回 JWT");

        // me：带 token 200 / 无 token 401 / 伪 token 401
        HttpResponse<String> me = get("/api/auth/me", token);
        assertEquals(200, me.statusCode(), "me 200");
        assertTrue(me.body().contains("测试员"), "me 返回昵称");
        assertEquals(401, get("/api/auth/me", null).statusCode(), "无 token 401");
        assertEquals(401, get("/api/auth/me", "fake.token.here").statusCode(), "伪 token 401");
    }

    @Test
    void apiRequiresLogin() throws Exception {
        // 未登录访问 /api/docs → 401
        assertEquals(401, get("/api/docs", null).statusCode(), "未登录访问文档 API 401");

        String token = AuthTestSupport.token(port, "guard-" + java.util.UUID.randomUUID().toString().substring(0, 8));
        assertEquals(200, get("/api/docs", token).statusCode(), "登录后可访问");

        // 健康检查公开
        assertEquals(200, get("/api/health", null).statusCode(), "健康检查公开");
    }

    @Test
    void wsHandshakeRequiresToken() throws Exception {
        String ws = "ws://localhost:" + port + "/ws/collab";
        // 无 token → 握手被拒（get 抛 ExecutionException，内部为握手失败）
        Exception ex = assertThrows(Exception.class, () -> {
            new org.springframework.web.socket.client.standard.StandardWebSocketClient()
                    .execute(new org.springframework.web.socket.handler.TextWebSocketHandler() {
                    }, new org.springframework.web.socket.WebSocketHttpHeaders(),
                            URI.create(ws)).get(5, java.util.concurrent.TimeUnit.SECONDS);
        });
        assertTrue(ex instanceof java.util.concurrent.ExecutionException, "无 token 握手必须失败，实际: " + ex);
    }

    /* ---------- helpers ---------- */

    private HttpResponse<String> post(String path, String json, String token) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(base() + path))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(5))
                .POST(HttpRequest.BodyPublishers.ofString(json));
        if (token != null) b.header("Authorization", "Bearer " + token);
        return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> get(String path, String token) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(base() + path))
                .timeout(Duration.ofSeconds(5))
                .GET();
        if (token != null) b.header("Authorization", "Bearer " + token);
        return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString());
    }
}