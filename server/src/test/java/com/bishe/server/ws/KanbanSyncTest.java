package com.bishe.server.ws;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * T0+7 验收：看板协同（建列/建卡/写文字/跨列移动/重连快照）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class KanbanSyncTest {

    @LocalServerPort
    int port;

    final String testDoc = "kanbantest-" + java.util.UUID.randomUUID().toString().substring(0, 8);

    @Test
    void columnAndCardSync() throws Exception {
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

            /* 1) A 建两列：6 条 op（ADD+title+order）×2 */
            String c1 = "col-todo", c2 = "col-done";
            a.send(addOp(c1, "COLUMN"));
            a.nextOfType("applied", 5);
            a.send(putOp(c1, "COLUMN", "title", "待办", "c-a:1"));
            a.nextOfType("applied", 5);
            a.send(putOp(c1, "COLUMN", "order", 1, "c-a:2"));
            a.nextOfType("applied", 5);
            a.send(addOp(c2, "COLUMN"));
            a.nextOfType("applied", 5);
            a.send(putOp(c2, "COLUMN", "title", "已完成", "c-a:3"));
            a.nextOfType("applied", 5);
            a.send(putOp(c2, "COLUMN", "order", 3, "c-a:4"));
            a.nextOfType("applied", 5);

            List<JsonNode> gotB = collect(b, m ->
                    m.at("/op/elementId").asText().equals(c1) || m.at("/op/elementId").asText().equals(c2), 6);
            assertEquals(6, gotB.size(), "B 收到两列的全部 op");

            /* 2) B 在 c1 建卡片并写文字（4 op） */
            String card = "card-kb";
            b.send(addOp(card, "CARD"));
            b.nextOfType("applied", 5);
            b.send(putOp(card, "CARD", "column", c1, "c-b:1"));
            b.nextOfType("applied", 5);
            b.send(putOp(card, "CARD", "order", 1, "c-b:2"));
            b.nextOfType("applied", 5);
            b.send(putOp(card, "CARD", "text", "写论文", "c-b:3"));
            b.nextOfType("applied", 5);
            JsonNode textA = null;
            long dl = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(6);
            while (textA == null && System.nanoTime() < dl) {
                JsonNode m = a.nextOfType("applied", 2);
                if (m.at("/op/value").asText().equals("写论文")) textA = m;
            }
            assertNotNull(textA, "A 收到卡片文字");

            /* 3) A 把卡片拖到 c2（跨列） */
            a.send(putOp(card, "CARD", "column", c2, "c-a:9"));
            a.send(putOp(card, "CARD", "order", 2.5, "c-a:10"));
            a.nextOfType("applied", 5);
            a.nextOfType("applied", 5);
            JsonNode moveB = b.nextOfType("applied", 5);
            assertEquals("column", moveB.at("/op/field").asText());
            assertEquals(c2, moveB.at("/op/value").asText(), "B 收到换列到已完成");
            b.nextOfType("applied", 5);   // order

            /* 4) 新客户端 C：快照 = 两列 + 卡片落在 c2 */
            CollabWsIntegrationTest.TestClient c = new CollabWsIntegrationTest.TestClient();
            c.connect(wsUri);
            c.send(hello("client-c", 0));
            JsonNode wc = c.nextOfType("welcome", 5);
            int cols = 0;
            String colOf = null;
            for (JsonNode el : wc.path("snapshot")) {
                if (el.path("type").asText().equals("COLUMN")) cols++;
                if (el.path("id").asText().equals(card)) {
                    colOf = el.path("fields").path("column").path("value").asText();
                }
            }
            assertEquals(2, cols, "两列在快照中");
            assertEquals(c2, colOf, "卡片已落入「已完成」列");
            c.close();
        } finally {
            a.close();
            b.close();
        }
    }

    private List<JsonNode> collect(CollabWsIntegrationTest.TestClient c,
                               java.util.function.Predicate<JsonNode> pred, int expect) throws Exception {
        List<JsonNode> out = new ArrayList<>();
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(6);
        while (out.size() < expect && System.nanoTime() < deadline) {
            JsonNode m = c.nextOfType("applied", 2);
            if (pred.test(m)) out.add(m);
        }
        return out;
    }

    private String hello(String clientId, long lastRev) {
        return "{\"type\":\"hello\",\"docId\":\"" + testDoc + "\",\"clientId\":\"" + clientId
                + "\",\"hostname\":\"" + clientId + "\",\"lastRev\":" + lastRev + "}";
    }
    private String addOp(String eid, String etype) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"ADD\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"" + etype + "\",\"clock\":\"c-k:1\"}}";
    }
    private String putOp(String eid, String etype, String field, Object value, String clock) {
        String v = value instanceof String ? "\"" + value + "\"" : String.valueOf(value);
        return "{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"" + eid
                + "\",\"elementType\":\"" + etype + "\",\"field\":\"" + field + "\",\"value\":" + v
                + ",\"clock\":\"" + clock + "\"}}";
    }
}