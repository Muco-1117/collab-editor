package com.bishe.server.ws;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T0+6 验收：白板卡片实时协同（创建/几何/文字/移动/删除 + 重连快照）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class BoardSyncTest {

    @LocalServerPort
    int port;

    final String testDoc = "boardtest-" + java.util.UUID.randomUUID().toString().substring(0, 8);

    @Test
    void cardSyncAndRejoin() throws Exception {
        URI wsUri = URI.create("ws://localhost:" + port + "/ws/collab");
        CollabWsIntegrationTest.TestClient a = new CollabWsIntegrationTest.TestClient();
        CollabWsIntegrationTest.TestClient b = new CollabWsIntegrationTest.TestClient();
        try {
            a.connect(wsUri);
            b.connect(wsUri);
            a.send(hello("client-a", 0));
            a.nextOfType("welcome", 5);
            b.send(hello("client-b", 0));
            b.nextOfType("welcome", 5);

            /* 1) A 创建卡片 + 几何（ADD + x/y/w/h） */
            String card = "card-t6";
            a.send(addOp(card));
            a.nextOfType("applied", 5);
            a.send(putNumEarly(card, "x", 12));
            a.nextOfType("applied", 5);
            a.send(putNum(card, "y", 80));
            a.nextOfType("applied", 5);
            a.send(putNum(card, "w", 240));
            a.nextOfType("applied", 5);
            a.send(putNum(card, "h", 150));
            a.nextOfType("applied", 5);

            // B 应收到 5 条（ADD + x/y/w/h）
            boolean gotAdd = false, gotX = false, gotY = false, gotW = false, gotH = false;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(6);
            while (System.nanoTime() < deadline && !(gotAdd && gotX && gotY && gotW && gotH)) {
                JsonNode m = b.nextOfType("applied", 2);
                if (!m.at("/op/elementId").asText().equals(card)) continue;
                String t = m.at("/op/type").asText(), f = m.at("/op/field").asText("");
                if (t.equals("ADD")) gotAdd = true;
                if (f.equals("x") && m.at("/op/value").asInt() == 12) gotX = true;
                if (f.equals("y") && m.at("/op/value").asInt() == 80) gotY = true;
                if (f.equals("w") && m.at("/op/value").asInt() == 240) gotW = true;
                if (f.equals("h") && m.at("/op/value").asInt() == 150) gotH = true;
            }
            assertTrue(gotAdd && gotX && gotY && gotW && gotH, "B 完整收到卡片创建 + 几何");

            /* 2) B 拖拽卡片：x=300 → A 实时收到 */
            b.send(putNum(card, "x", 300));
            b.nextOfType("applied", 5);
            JsonNode ma = a.nextOfType("applied", 5);
            assertEquals(300, ma.at("/op/value").asInt(), "A 实时收到 B 的移动");

            /* 3) B 写文字 */
            b.send(putText(card, "text", "拖拽同步文字"));
            b.nextOfType("applied", 5);
            a.nextOfType("applied", 5);

            /* 4) 新客户端 C：welcome 快照应含完整卡片（LWW 后 x=300） */
            CollabWsIntegrationTest.TestClient c = new CollabWsIntegrationTest.TestClient();
            c.connect(wsUri);
            c.send(hello("client-c", 0));
            JsonNode wc = c.nextOfType("welcome", 5);
            JsonNode el = null;
            for (JsonNode e : wc.path("snapshot")) {
                if (e.path("id").asText().equals(card)) el = e;
            }
            assertNotNull(el, "快照含卡片");
            assertEquals("CARD", el.path("type").asText());
            JsonNode f = el.path("fields");
            assertEquals(300, f.path("x").path("value").asInt(), "x 恢复（B 的拖拽胜出）");
            assertEquals(80, f.path("y").path("value").asInt(), "y 恢复");
            assertEquals(240, f.path("w").path("value").asInt(), "w 恢复");
            assertEquals(150, f.path("h").path("value").asInt(), "h 恢复");
            assertEquals("拖拽同步文字", f.path("text").path("value").asText(), "text 恢复");

            /* 5) A 删除卡片 → B 收到 DELETE */
            a.send(delOp(card));
            a.nextOfType("applied", 5);
            JsonNode delB = b.nextOfType("applied", 5);
            assertEquals("DELETE", delB.at("/op/type").asText(), "B 收到删除");
            c.close();
        } finally {
            a.close();
            b.close();
        }
    }

    private String hello(String clientId, long lastRev) {
        return "{\"type\":\"hello\",\"docId\":\"" + testDoc + "\",\"clientId\":\"" + clientId
                + "\",\"hostname\":\"" + clientId + "\",\"lastRev\":" + lastRev + "}";
    }
    private String addOp(String eid) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"ADD\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"CARD\",\"clock\":\"c-a:1\"}}";
    }
    private String putNum(String eid, String field, Object value) {
            return "{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"" + eid
                    + "\",\"elementType\":\"CARD\",\"field\":\"" + field + "\",\"value\":" + value
                    + ",\"clock\":\"c-b:10\"}}";
        }
    /** A 创建阶段的几何（早时钟，保证被 B 的晚写覆盖）。 */
    private String putNumEarly(String eid, String field, Object value) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"CARD\",\"field\":\"" + field + "\",\"value\":" + value
                + ",\"clock\":\"c-a:2\"}}";
    }
        private String putText(String eid, String field, String value) {
            return "{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"" + eid
                    + "\",\"elementType\":\"CARD\",\"field\":\"" + field + "\",\"value\":\"" + value
                    + "\",\"clock\":\"c-b:11\"}}";
        }
    private String delOp(String eid) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"DELETE\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"CARD\",\"clock\":\"c-a:4\"}}";
    }
}