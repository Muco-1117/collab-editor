package com.bishe.server.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.net.URI;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 实时层端到端验证 —— 两名客户端互操作：
 * 1) hello → welcome（全量快照）
 * 2) A 发 op → B 实时收到 applied 且字段收敛
 * 3) B 断开期间 A 再发 op → B 重连(lastRev) → 增量补发 incremental
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class CollabWsIntegrationTest {

    @LocalServerPort
    int port;

    final ObjectMapper mapper = new ObjectMapper();

    /** 一个测试 WS 客户端：入站消息进 queue。 */
    static class TestClient {
        final LinkedBlockingQueue<String> inbox = new LinkedBlockingQueue<>();
        WebSocketSession session;

        void connect(URI uri) throws Exception {
            StandardWebSocketClient client = new StandardWebSocketClient();
            session = client.execute(new TextWebSocketHandler() {
                @Override
                protected void handleTextMessage(WebSocketSession s, TextMessage m) {
                    inbox.offer(m.getPayload());
                }
            }, new WebSocketHttpHeaders(), uri).get(10, TimeUnit.SECONDS);
        }

        void send(String json) throws Exception {
            session.sendMessage(new TextMessage(json));
        }

        JsonNode next(long seconds) throws Exception {
            String msg = inbox.poll(seconds, TimeUnit.SECONDS);
            assertNotNull(msg, "等待消息超时");
            return new ObjectMapper().readTree(msg);
        }

        /** 轮询直到出现指定 type 的帧（跳过 presence 等噪声）。 */
        JsonNode nextOfType(String type, long seconds) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
            while (System.nanoTime() < deadline) {
                String msg = inbox.poll(200, TimeUnit.MILLISECONDS);
                if (msg == null) {
                    continue;
                }
                JsonNode n = new ObjectMapper().readTree(msg);
                if (type.equals(n.path("type").asText())) {
                    return n;
                }
            }
            throw new AssertionError("等待 " + type + " 超时");
        }

        void close() throws Exception {
            if (session != null && session.isOpen()) {
                session.close();
            }
        }
    }

    private URI wsUri() {
        return URI.create("ws://localhost:" + port + "/ws/collab");
    }

    @Test
    void twoClientsRealtimeAndIncrementalRestore() throws Exception {
        TestClient a = new TestClient();
        TestClient b = new TestClient();
        try {
            a.connect(wsUri());
            b.connect(wsUri());
            a.send(jsonHello("client-a", 0));
            JsonNode wa = a.nextOfType("welcome", 5);
            assertEquals("welcome", wa.path("type").asText());
            assertTrue(wa.path("snapshot").isArray(), "welcome 带快照");

            b.send(jsonHello("client-b", 0));
            JsonNode wb = b.nextOfType("welcome", 5);
            assertEquals("welcome", wb.path("type").asText());

            // A 提交一个操作
            a.send("{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"doc-1\","
                    + "\"elementType\":\"TEXT\",\"field\":\"text\",\"value\":\"你好，协同编辑\",\"clock\":\"client-a:1\"}}");
            JsonNode appA = a.nextOfType("applied", 5);
            assertEquals("applied", appA.path("type").asText());
            assertEquals("你好，协同编辑", appA.at("/op/value").asText());
            JsonNode appB = b.nextOfType("applied", 5);
            assertEquals("applied", appB.path("type").asText());
            assertEquals("你好，协同编辑", appB.at("/op/value").asText(), "B 实时收到同一 op");

            // --- 模拟断线：A 断开，B 继续写 ---
            a.close();
            b.send("{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"doc-1\","
                    + "\"elementType\":\"TEXT\",\"field\":\"text\",\"value\":\"第二版\",\"clock\":\"client-b:2\"}}");
            JsonNode appB2 = b.nextOfType("applied", 5);
            assertEquals("applied", appB2.path("type").asText());
            assertEquals("第二版", appB2.at("/op/value").asText());

            // --- A 重连：带 lastRev=0+其已知 rev → 增量补发 ---
            int revA = appA.path("rev").asInt();   // A 断开时已知 rev
            TestClient a2 = new TestClient();
            a2.connect(wsUri());
            a2.send(jsonHello("client-a", revA));
            JsonNode restore = a2.nextOfType("incremental", 5);
            assertNotNull(restore, "重连应收到补发");
            assertEquals("incremental", restore.path("type").asText(), "重连走增量");
            assertEquals(1, restore.path("ops").size(), "应补回断线期间错过 op");
            assertEquals("第二版", restore.at("/ops/0/value").asText());

            a2.close();
        } finally {
            a.close();
            b.close();
        }
    }

    private String jsonHello(String clientId, long lastRev) {
        return "{\"type\":\"hello\",\"docId\":\"demo-doc-1\",\"clientId\":\"" + clientId
                + "\",\"hostname\":\"" + clientId + "\",\"lastRev\":" + lastRev + "}";
    }
}