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
 * T0+10 验收：历史时间线 / 回放 / 恢复 / Markdown 导出 / 搜索 / 统计。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class ProductFeatureTest {

    @LocalServerPort
    int port;

    final ObjectMapper mapper = new ObjectMapper();
    final HttpClient http = HttpClient.newHttpClient();

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

    private String user(String tag) throws Exception {
        String name = tag + java.util.UUID.randomUUID().toString().substring(0, 6);
        call("POST", "/api/auth/register", null,
                "{\"username\":\"" + name + "\",\"password\":\"pass1234\",\"nickname\":\"" + tag + "\"}");
        HttpResponse<String> l = call("POST", "/api/auth/login", null,
                "{\"username\":\"" + name + "\",\"password\":\"pass1234\"}");
        return mapper.readTree(l.body()).get("token").asText();
    }

    private long space(String token, String name) throws Exception {
        return mapper.readTree(call("POST", "/api/spaces", token, "{\"name\":\"" + name + "\"}").body())
                .get("spaceId").asLong();
    }

    private String doc(String token, long spaceId, String title) throws Exception {
        return mapper.readTree(call("POST", "/api/docs", token,
                "{\"title\":\"" + title + "\",\"spaceId\":" + spaceId + "}").body())
                .get("docKey").asText();
    }

    private int write(String token, String docKey, String text, String clock) throws Exception {
        String clientId = clock.substring(0, clock.lastIndexOf(':'));
        CollabWsIntegrationTest.TestClient c = new CollabWsIntegrationTest.TestClient();
        c.tokenParam = token;
        c.connect(URI.create("ws://localhost:" + port + "/ws/collab"));
        c.send("{\"type\":\"hello\",\"docId\":\"" + docKey + "\",\"clientId\":\""
                + clientId + "\",\"hostname\":\"t\",\"lastRev\":0}");
        c.nextOfType("welcome", 5);
        c.send("{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"doc-root\",\"elementType\":\"DOC\","
                + "\"field\":\"text\",\"value\":\"" + text + "\",\"clock\":\"" + clock + "\"}}");
        JsonNode a = c.nextOfType("applied", 5);
        c.close();
        return a.path("rev").asInt();
    }

    @Test
    void historyReplayRestoreExportSearchStats() throws Exception {
        String token = user("prod");
        long sid = space(token, "产品验收");
        String key = doc(token, sid, "历史文档");

        int rev1 = write(token, key, "第一版内容", "h-a:1");
        int rev2 = write(token, key, "第二版内容", "h-a:2");
        assertTrue(rev2 > rev1, "rev 递增");

        /* 1) 历史时间线 ≥2 条 */
        JsonNode hist = mapper.readTree(call("GET", "/api/docs/" + key + "/history", token, null).body());
        assertTrue(hist.path("ops").size() >= 2, "时间线含最近 op: " + hist);
        assertEquals(rev2, hist.path("rev").asInt());

        /* 2) 回放 rev1：内容应为第一版 */
        JsonNode rp = mapper.readTree(call("GET", "/api/docs/" + key + "/replay?rev=" + rev1, token, null).body());
        String v1 = rp.path("elements").findValuesAsText("value").stream()
                .filter(v -> v.contains("第一版")).findFirst().orElse("");
        assertEquals("第一版内容", v1, "回放到 rev1 是第一版");

        /* 3) 回放 rev2：第二版 */
        JsonNode rp2 = mapper.readTree(call("GET", "/api/docs/" + key + "/replay?rev=" + rev2, token, null).body());
        assertTrue(rp2.toString().contains("第二版内容"), "回放到 rev2 是第二版");

        /* 4) 恢复 rev1：当前状态回到第一版 */
        HttpResponse<String> rs = call("POST", "/api/docs/" + key + "/restore", token,
                "{\"rev\":" + rev1 + "}");
        assertEquals(200, rs.statusCode(), "恢复: " + rs.body());
        JsonNode cur = mapper.readTree(call("GET", "/api/docs/" + key + "/replay?rev="
                + mapper.readTree(rs.body()).get("rev").asInt(), token, null).body());
        assertTrue(cur.toString().contains("第一版内容") && !cur.toString().contains("第二版内容"),
                "恢复后回到第一版: " + cur);

        /* 5) Markdown 导出 */
        HttpResponse<String> md = call("GET", "/api/docs/" + key + "/export", token, null);
        assertEquals(200, md.statusCode());
        String body = md.body();
        assertTrue(body.contains("# 历史文档"), "导出含标题: " + body.lines().findFirst().orElse(""));
        assertTrue(body.contains("第一版"), "导出含正文");

        /* 6) 搜索：标题命中 + 正文命中 */
        JsonNode s1 = mapper.readTree(call("GET", "/api/docs/search?q=" + "历史文档", token, null).body());
        assertTrue(findHit(s1, "title"), "标题搜索命中: " + s1);
        JsonNode s2 = mapper.readTree(call("GET", "/api/docs/search?q=" + "第一版", token, null).body());
        assertTrue(findHit(s2, "body"), "正文搜索命中");
        JsonNode stale = mapper.readTree(call("GET", "/api/docs/search?q=" + "第二版", token, null).body());
        assertFalse(findHit(stale, "body"), "被恢复覆盖的旧正文不能继续命中");

        /* 7) 基于操作日志的统计 */
        JsonNode stt = mapper.readTree(call("GET", "/api/stats", token, null).body());
        assertTrue(stt.path("spaces").asInt() >= 1, "我的空间数");
        assertTrue(stt.path("documents").asInt() >= 1, "可见文档数");
        assertTrue(stt.path("operations").asLong() >= 2, "统计来自操作日志");
        assertTrue(stt.path("byOperation").isArray(), "包含操作类型聚合");
    }

    private boolean findHit(JsonNode arr, String kind) {
        for (JsonNode n : arr) {
            if (kind.equals(n.path("hit").asText())) return true;
        }
        return false;
    }
}
