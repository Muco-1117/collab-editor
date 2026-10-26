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
@ActiveProfiles("test")
class BoardSyncTest {

    @LocalServerPort
    int port;

    @Test
    void cardSyncAndRejoin() throws Exception {
        AuthTestSupport.TestDocument document = AuthTestSupport.document(port, "board", "board");
        String testDoc = document.docKey();
        URI wsUri = URI.create("ws://localhost:" + port + "/ws/collab");
        CollabWsIntegrationTest.TestClient a = new CollabWsIntegrationTest.TestClient();
        CollabWsIntegrationTest.TestClient b = new CollabWsIntegrationTest.TestClient();
        a.tokenParam = document.token();
        b.tokenParam = document.token();
        try {
            a.connect(wsUri);
            b.connect(wsUri);
            a.send(hello(testDoc, "c-a", 0));
            a.nextOfType("welcome", 5);
            b.send(hello(testDoc, "c-b", 0));
            b.nextOfType("welcome", 5);

            /* 1) A 创建卡片 + 几何与层级（ADD + x/y/w/h/z） */
            String card = "card-t6";
            a.send(addOp("c-a", card, 1));
            a.nextOfType("applied", 5);
            a.send(putNum("c-a", card, "x", 12, 2));
            a.nextOfType("applied", 5);
            a.send(putNum("c-a", card, "y", 80, 3));
            a.nextOfType("applied", 5);
            a.send(putNum("c-a", card, "w", 240, 4));
            a.nextOfType("applied", 5);
            a.send(putNum("c-a", card, "h", 150, 5));
            a.nextOfType("applied", 5);
            a.send(putNum("c-a", card, "z", 7, 6));
            a.nextOfType("applied", 5);

            // B 应收到 6 条（ADD + x/y/w/h/z）
            boolean gotAdd = false, gotX = false, gotY = false, gotW = false, gotH = false, gotZ = false;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(6);
            while (System.nanoTime() < deadline && !(gotAdd && gotX && gotY && gotW && gotH && gotZ)) {
                JsonNode m = b.nextOfType("applied", 2);
                if (!m.at("/op/elementId").asText().equals(card)) continue;
                String t = m.at("/op/type").asText(), f = m.at("/op/field").asText("");
                if (t.equals("ADD")) gotAdd = true;
                if (f.equals("x") && m.at("/op/value").asInt() == 12) gotX = true;
                if (f.equals("y") && m.at("/op/value").asInt() == 80) gotY = true;
                if (f.equals("w") && m.at("/op/value").asInt() == 240) gotW = true;
                if (f.equals("h") && m.at("/op/value").asInt() == 150) gotH = true;
                if (f.equals("z") && m.at("/op/value").asInt() == 7) gotZ = true;
            }
            assertTrue(gotAdd && gotX && gotY && gotW && gotH && gotZ, "B 完整收到卡片创建、几何与层级");

            /* 2) B 拖拽卡片：x=300 → A 实时收到 */
            b.send(putNum("c-b", card, "x", 300, 10));
            b.nextOfType("applied", 5);
            JsonNode ma = a.nextOfType("applied", 5);
            assertEquals(300, ma.at("/op/value").asInt(), "A 实时收到 B 的移动");

            /* 3) B 写文字 */
            b.send(putText("c-b", card, "text", "拖拽同步文字", 11));
            b.nextOfType("applied", 5);
            a.nextOfType("applied", 5);

            /* 4) 新客户端 C：welcome 快照应含完整卡片（LWW 后 x=300） */
            CollabWsIntegrationTest.TestClient c = new CollabWsIntegrationTest.TestClient();
            c.tokenParam = document.token();
            c.connect(wsUri);
            c.send(hello(testDoc, "c-c", 0));
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
            assertEquals(7, f.path("z").path("value").asInt(), "层级恢复");
            assertEquals("拖拽同步文字", f.path("text").path("value").asText(), "text 恢复");

            /* 5) A 删除卡片 → B 收到 DELETE */
            a.send(delOp("c-a", card, 7));
            a.nextOfType("applied", 5);
            JsonNode delB = b.nextOfType("applied", 5);
            assertEquals("DELETE", delB.at("/op/type").asText(), "B 收到删除");
            c.close();
        } finally {
            a.close();
            b.close();
        }
    }

    private String hello(String docId, String clientId, long lastRev) {
        return "{\"type\":\"hello\",\"docId\":\"" + docId + "\",\"clientId\":\"" + clientId
                + "\",\"hostname\":\"" + clientId + "\",\"lastRev\":" + lastRev + "}";
    }
    private String addOp(String clientId, String eid, long counter) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"ADD\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"CARD\",\"clock\":\"" + clientId + ":" + counter + "\"}}";
    }
    private String putNum(String clientId, String eid, String field, Object value, long counter) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"CARD\",\"field\":\"" + field + "\",\"value\":" + value
                + ",\"clock\":\"" + clientId + ":" + counter + "\"}}";
    }
    private String putText(String clientId, String eid, String field, String value, long counter) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"CARD\",\"field\":\"" + field + "\",\"value\":\"" + value
                + "\",\"clock\":\"" + clientId + ":" + counter + "\"}}";
    }
    private String delOp(String clientId, String eid, long counter) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"DELETE\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"CARD\",\"clock\":\"" + clientId + ":" + counter + "\"}}";
    }
}
