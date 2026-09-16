package com.bishe.server.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T0+5 验收：文档 CRUD REST + 段落级实时同步（双客户端）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class DocRestAndParagraphTest {

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    final ObjectMapper mapper = new ObjectMapper();
    final String testDoc = "doctest-" + java.util.UUID.randomUUID().toString().substring(0, 8);

    /** 每个测试先注册登录，给所有 REST 请求自动带 Bearer。 */
    @org.junit.jupiter.api.BeforeEach
    void auth() throws Exception {
        String token = AuthTestSupport.token(port, "doc-" + java.util.UUID.randomUUID().toString().substring(0, 8));
        rest.getRestTemplate().getInterceptors().add((req, body, exec) -> {
            req.getHeaders().setBearerAuth(token);
            return exec.execute(req, body);
        });
    }

    /* ---------------- REST：文档 CRUD ---------------- */

    @Test
    void docCrud() throws Exception {
        String url = "http://localhost:" + port + "/api/docs";
        // 先建空间（T0+9 文档归属空间）
        String spUrl = "http://localhost:" + port + "/api/spaces";
        org.springframework.http.HttpHeaders jh = new org.springframework.http.HttpHeaders();
        jh.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        ResponseEntity<String> sp = rest.postForEntity(spUrl,
                new org.springframework.http.HttpEntity<>("{\"name\":\"T0+5 测试空间\"}", jh), String.class);
        assertEquals(200, sp.getStatusCode().value());
        long spaceId = mapper.readTree(sp.getBody()).path("spaceId").asLong();
        // 创建
        ResponseEntity<String> created = rest.postForEntity(url,
                new org.springframework.http.HttpEntity<>(
                        "{\"title\":\"T0+5 验收文档\",\"spaceId\":" + spaceId + "}", jh), String.class);
        assertEquals(200, created.getStatusCode().value());
        JsonNode c = mapper.readTree(created.getBody());
        String key = c.path("docKey").asText();
        assertFalse(key.isBlank(), "返回 docKey");

        // 列表包含
        ResponseEntity<String> list = rest.getForEntity(url, String.class);
        assertTrue(list.getBody().contains(key), "列表包含新文档");

        // 单查
        ResponseEntity<String> one = rest.getForEntity(url + "/" + key, String.class);
        assertEquals(200, one.getStatusCode().value());
        assertTrue(one.getBody().contains("T0+5 验收文档"));

        // 删除
        ResponseEntity<String> del = rest.exchange(url + "/" + key, HttpMethod.DELETE, null, String.class);
        assertEquals(200, del.getStatusCode().value());
        ResponseEntity<String> gone = rest.getForEntity(url + "/" + key, String.class);
        assertEquals(404, gone.getStatusCode().value(), "删除后 404");
    }

    /* ---------------- WS：段落级实时协同 ---------------- */

    @Test
    void paragraphSyncAndDocumentSeed() throws Exception {
        URI wsUri = URI.create("ws://localhost:" + port + "/ws/collab");
        CollabWsIntegrationTest.TestClient a = new CollabWsIntegrationTest.TestClient();
        CollabWsIntegrationTest.TestClient b = new CollabWsIntegrationTest.TestClient();
        try {
            a.connect(wsUri);
            b.connect(wsUri);
            a.send(jsonHello(a, "client-a", 0));
            JsonNode wa = a.nextOfType("welcome", 5);
            // 空文档种子：doc-root + seg-root-01
            boolean hasRoot = false, hasSeg = false;
            for (JsonNode el : wa.path("snapshot")) {
                if (el.path("id").asText().equals("doc-root")) hasRoot = true;
                if (el.path("id").asText().equals("seg-root-01")) hasSeg = true;
            }
            assertTrue(hasRoot, "welcome 快照含 doc-root（种子）");
            assertTrue(hasSeg, "welcome 快照含首个段落（种子）");

            b.send(jsonHello(b, "client-b", 0));
            b.nextOfType("welcome", 5);

            // A 写标题（第 1 段文字）
            a.send(putOp("client-a", "seg-root-01", "TEXT", "text", "大家好，这是第一段。", 1));
            JsonNode appA = a.nextOfType("applied", 5);
            assertEquals("大家好，这是第一段。", appA.at("/op/value").asText());
            JsonNode appB = b.nextOfType("applied", 5);
            assertEquals("大家好，这是第一段。", appB.at("/op/value").asText(), "B 实时同步段落");

            // B 回车分段：ADD 新段 + PUT text + PUT order
            String newId = "seg-x1";
            b.send(addOp("client-b", newId, "TEXT", 2));
            JsonNode addB = b.nextOfType("applied", 5);
            assertEquals("ADD", addB.at("/op/type").asText());
            b.send(putOp("client-b", newId, "TEXT", "text", "第二段（B 创建）", 3));
            b.send(putOp("client-b", newId, "TEXT", "order", 2, 4));

            // A 收到 ADD 与两道 PUT（顺序可能互换，都收到即可）
            boolean gotAdd = false, gotOrder = false, gotText = false;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < deadline && !(gotAdd && gotOrder && gotText)) {
                JsonNode m = a.nextOfType("applied", 1);
                String eid = m.at("/op/elementId").asText();
                if (!eid.equals(newId)) continue;
                String f = m.at("/op/field").asText();
                if (m.at("/op/type").asText().equals("ADD")) gotAdd = true;
                if (f.equals("order") && m.at("/op/value").asInt() == 2) gotOrder = true;
                if (f.equals("text") && m.at("/op/value").asText().equals("第二段（B 创建）")) gotText = true;
            }
            assertTrue(gotAdd && gotOrder && gotText, "B 的段拆分操作全部到达 A");

            // 重连全量：新客户端 welcome 应含两段
            CollabWsIntegrationTest.TestClient c = new CollabWsIntegrationTest.TestClient();
            c.connect(wsUri);
            c.send(jsonHello(c, "client-c", 0));
            JsonNode wc = c.nextOfType("welcome", 5);
            assertEquals(2, wc.path("snapshot").size() - 1, "快照含 doc-root+2 段（扣除 root）");
        } finally {
            a.close();
            b.close();
        }
    }

    /* ---------- helpers ---------- */
    private String jsonHello(CollabWsIntegrationTest.TestClient who, String clientId, long lastRev) {
        return "{\"type\":\"hello\",\"docId\":\"" + testDoc + "\",\"clientId\":\"" + clientId
                + "\",\"hostname\":\"" + clientId + "\",\"lastRev\":" + lastRev + "}";
    }
    private String addOp(String clientId, String eid, String atype, long counter) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"ADD\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"" + atype + "\",\"clock\":\"" + clientId + ":" + counter + "\"}}";
    }
    private String putOp(String clientId, String eid, String atype, String field, Object value, long counter) {
        String v = value instanceof String ? "\"" + value + "\"" : String.valueOf(value);
        return "{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"" + atype + "\",\"field\":\"" + field + "\",\"value\":" + v
                + ",\"clock\":\"" + clientId + ":" + counter + "\"}}";
    }
}