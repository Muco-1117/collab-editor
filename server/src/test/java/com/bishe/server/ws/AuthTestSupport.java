package com.bishe.server.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * 测试辅助：注册并登录一个随机用户，拿 JWT；或直接解析登录响应。
 */
public final class AuthTestSupport {

    private static final ObjectMapper M = new ObjectMapper();

    private AuthTestSupport() {}

    /** 注册（不存在则注册）并返回登录 token。 */
    public static String token(int port, String username) throws Exception {
        String base = "http://localhost:" + port;
        // 尝试注册（409 已存在 → 忽略）
        HttpRequest reg = HttpRequest.newBuilder()
                .uri(URI.create(base + "/api/auth/register"))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(5))
                .POST(HttpRequest.BodyPublishers.ofString(
                        "{\"username\":\"" + username + "\",\"password\":\"pass1234\",\"nickname\":\"" + username + "\"}"))
                .build();
        HttpClient client = HttpClient.newHttpClient();
        try {
            client.send(reg, HttpResponse.BodyHandlers.ofString());
        } catch (Exception ignored) {}

        HttpRequest login = HttpRequest.newBuilder()
                .uri(URI.create(base + "/api/auth/login"))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(5))
                .POST(HttpRequest.BodyPublishers.ofString(
                        "{\"username\":\"" + username + "\",\"password\":\"pass1234\"}"))
                .build();
        HttpResponse<String> resp = client.send(login, HttpResponse.BodyHandlers.ofString());
        JsonNode body = M.readTree(resp.body());
        if (resp.statusCode() != 200 || !body.has("token")) {
            throw new IllegalStateException("登录失败(" + resp.statusCode() + "): " + resp.body());
        }
        return body.get("token").asText();
    }

    /** 登录响应解析出 token。 */
    public static String tokenFromLogin(String json) throws Exception {
        return M.readTree(json).get("token").asText();
    }
}