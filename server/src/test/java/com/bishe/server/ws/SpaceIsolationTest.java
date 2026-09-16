package com.bishe.server.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
 * T0+9 验收：空间隔离 + 成员邀请。
 * A/B 各自空间互不可见、跨空间读 403；非成员 WS 被拒；
 * 邀请后 B 可读可进；仅 admin 可邀请。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class SpaceIsolationTest {

    @LocalServerPort
    int port;

    final ObjectMapper mapper = new ObjectMapper();
    final HttpClient http = HttpClient.newHttpClient();

    private record UserInfo(String name, String token) {}

    private UserInfo user(String tag) throws Exception {
        String name = tag + "-" + java.util.UUID.randomUUID().toString().substring(0, 6);
        call("POST", "/api/auth/register", null,
                "{\"username\":\"" + name + "\",\"password\":\"pass1234\",\"nickname\":\"" + tag + "\"}");
        HttpResponse<String> l = call("POST", "/api/auth/login", null,
                "{\"username\":\"" + name + "\",\"password\":\"pass1234\"}");
        return new UserInfo(name, mapper.readTree(l.body()).get("token").asText());
    }

    private HttpResponse<String> call(String method, String path, String token, String json) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + path))
                .timeout(Duration.ofSeconds(5));
        if (json != null) {
            b.method(method, HttpRequest.BodyPublishers.ofString(json));
            b.header("Content-Type", "application/json");
        } else {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        }
        if (token != null) b.header("Authorization", "Bearer " + token);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private long space(UserInfo u, String name) throws Exception {
        HttpResponse<String> r = call("POST", "/api/spaces", u.token(), "{\"name\":\"" + name + "\"}");
        assertEquals(200, r.statusCode(), "建空间: " + r.body());
        return mapper.readTree(r.body()).get("spaceId").asLong();
    }

    private String doc(UserInfo u, long spaceId, String title) throws Exception {
        HttpResponse<String> r = call("POST", "/api/docs", u.token(),
                "{\"title\":\"" + title + "\",\"spaceId\":" + spaceId + "}");
        assertEquals(200, r.statusCode(), "建文档: " + r.body());
        return mapper.readTree(r.body()).get("docKey").asText();
    }

    /** 连接 WS 并 hello，取第一帧。用给定用户的 token。 */
    private JsonNode helloTag(UserInfo u, String docId, String clientId) throws Exception {
        CollabWsIntegrationTest.TestClient c = new CollabWsIntegrationTest.TestClient();
        c.tokenParam = u.token();
        c.connect(URI.create("ws://localhost:" + port + "/ws/collab"));
        c.send("{\"type\":\"hello\",\"docId\":\"" + docId + "\",\"clientId\":\"" + clientId
                + "\",\"hostname\":\"t\",\"lastRev\":0}");
        JsonNode m = c.nextOfType("welcome", 5);
        c.close();
        return m;
    }

    @Test
    void isolationAndInvite() throws Exception {
        UserInfo alice = user("alice"), bob = user("bob"), eve = user("eve");
        long sA = space(alice, "A 的工作区");
        long sB = space(bob, "B 的工作区");
        String docA = doc(alice, sA, "A 的文档");
        String docB = doc(bob, sB, "B 的文档");

        /* 1) 文档列表：A/B 互不见 */
        String listA = call("GET", "/api/docs", alice.token(), null).body();
        String listB = call("GET", "/api/docs", bob.token(), null).body();
        assertTrue(listA.contains(docA) && !listA.contains(docB), "A 只见自己的文档");
        assertTrue(listB.contains(docB) && !listB.contains(docA), "B 只见自己的文档");

        /* 2) 跨空间读 → 403 */
        assertEquals(403, call("GET", "/api/docs/" + docB, alice.token(), null).statusCode(), "B 文档 A 读 403");
        assertEquals(403, call("GET", "/api/docs/" + docA, bob.token(), null).statusCode(), "A 文档 B 读 403");

        /* 3) 非成员 WS 连 A 文档 → 收 error 帧（而非 welcome） */
        CollabWsIntegrationTest.TestClient noc = new CollabWsIntegrationTest.TestClient();
        noc.connect(URI.create("ws://localhost:" + port + "/ws/collab"));
        noc.send("{\"type\":\"hello\",\"docId\":\"" + docA + "\",\"clientId\":\"x1\",\"hostname\":\"t\",\"lastRev\":0}");
        JsonNode err = noc.nextOfType("error", 5);
        assertEquals("error", err.path("type").asText(), "非成员应收 error");
        assertTrue(err.path("message").asText().contains("无权"), "错误含“无权”: " + err.path("message").asText());
        noc.close();

        /* 4) 仅空间 admin 可邀请 */
        assertEquals(403, call("POST", "/api/spaces/" + sA + "/members", bob.token(),
                "{\"username\":\"" + eve.name() + "\"}").statusCode(), "非 admin 邀请 403");
        HttpResponse<String> inv = call("POST", "/api/spaces/" + sA + "/members", alice.token(),
                "{\"username\":\"" + bob.name() + "\",\"role\":\"editor\"}");
        assertEquals(200, inv.statusCode(), "邀请成员: " + inv.body());

        /* 5) 邀请后 B 可读 + 可进 WS */
        assertEquals(200, call("GET", "/api/docs/" + docA, bob.token(), null).statusCode(), "邀请后可读");
        JsonNode w = helloTag(bob, docA, "b2");
        assertEquals("welcome", w.path("type").asText(), "邀请后 B 可进房间");

        /* 6) 成员列表含两人 */
        String members = call("GET", "/api/spaces/" + sA + "/members", alice.token(), null).body();
        assertTrue(members.contains(alice.name()) && members.contains(bob.name()), "成员列表: " + members);
    }
}