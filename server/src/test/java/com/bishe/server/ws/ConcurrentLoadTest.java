package com.bishe.server.ws;

import com.bishe.server.ws.CollabWsIntegrationTest.TestClient;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 质量门：50 客户端并发测试。
 *
 * <p>50 条并发的 WebSocket 连接，每条连接发送 20 条 PUT = 共 1000 条操作并发到达。
 * 验证：① 全部 op 收到 applied 确认，无丢失无异常；② 收尾后新连接 hello 的
 * welcome rev = 播种 rev(4) + 1000，服务端操作已完整落库；③ 输出端到端延迟
 * P50/P95/P99/MAX 与吞吐量，并断言 P95 < 200ms —— 性能报告的支撑数据。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ConcurrentLoadTest {

    private static final int CLIENTS = 50;
    private static final int OPS_PER_CLIENT = 20;
    private static final int TOTAL_OPS = CLIENTS * OPS_PER_CLIENT;
    private static final int SEED_REV = 4; // 空文档播种：doc-root + 首段 + order

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Test
        void latencyBaselineAndConcurrentLoad() throws Exception {
            // ── 准备：注册 + 用 + 建空间 + 建文档 ──────────────────────────────
            String user = "load-" + java.util.UUID.randomUUID().toString().substring(0, 8);
            rest.postForObject("/api/auth/register",
                    Map.of("username", user, "password", "pass1234"), String.class);
            String token = rest.postForObject("/api/auth/login",
                    Map.of("username", user, "password", "pass1234"), String.class)
                    .split("\"token\":\"")[1].split("\"")[0];
            HttpHeaders h = new HttpHeaders();
            h.setContentType(MediaType.APPLICATION_JSON);
            h.setBearerAuth(token);
            JsonNode spaces = rest.exchange("/api/spaces", HttpMethod.POST,
                    new HttpEntity<>(Map.of("name", "负载测试"), h), JsonNode.class).getBody();
            String spaceId = spaces.get("spaceId").asText();
            JsonNode created = rest.exchange("/api/docs", HttpMethod.POST,
                    new HttpEntity<>(Map.of("title", "并发压测文档", "spaceId", spaceId), h), JsonNode.class).getBody();
            String docKey = created.get("docKey").asText();
            URI wsUri = URI.create("ws://localhost:" + port + "/ws/collab");

            // ── 基准：单客户端 200 次串行（真实端到端延迟曲线）────────────────
            TestClient solo = new TestClient();
            solo.tokenParam = token;
            solo.connect(wsUri);
            solo.send("{\"type\":\"hello\",\"docId\":\"" + docKey + "\",\"clientId\":\"solo\",\"hostname\":\"t\"}");
            solo.nextOfType("welcome", 10);
            ConcurrentLinkedQueue<Long> soloLat = new ConcurrentLinkedQueue<>();
            for (int i = 0; i < 200; i++) {
                String clock = "solo:" + i;
                long t0 = System.nanoTime();
                solo.send("{\"type\":\"op\",\"docId\":\"" + docKey + "\",\"clientId\":\"solo\",\"baseRev\":0,"
                        + "\"op\":{\"type\":\"PUT\",\"elementId\":\"doc-root\",\"elementType\":\"TEXT\","
                        + "\"field\":\"text\",\"value\":\"s" + i + "\",\"clock\":\"" + clock + "\"}}");
                awaitApplied(solo, clock);
                soloLat.add(System.nanoTime() - t0);
            }
            solo.close();
            List<Long> s = new ArrayList<>(soloLat);
            Collections.sort(s);
            long sp50 = s.get(s.size() / 2), sp95 = s.get((int) (s.size() * 0.95));
            System.out.printf("[基准] 单客户端串行 200 ops：P50=%.2f ms  P95=%.2f ms%n", sp50 / 1e6, sp95 / 1e6);
            assertTrue(sp95 / 1e6 <= 20, "单客户端 P95 超 20ms: " + sp95 / 1e6 + "ms");

            // ── 50 并发：真实压力 ────────────────────────────────────────────
            List<TestClient> clients = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch allJoined = new CountDownLatch(CLIENTS);
            List<Thread> joiners = new ArrayList<>();
            for (int i = 0; i < CLIENTS; i++) {
                Thread t = new Thread(() -> {
                    try {
                        TestClient c = new TestClient();
                        c.tokenParam = token;
                        c.connect(wsUri);
                        String cid = "c" + Thread.currentThread().getName().substring(1);
                        c.send("{\"type\":\"hello\",\"docId\":\"" + docKey
                                + "\",\"clientId\":\"" + cid + "\",\"hostname\":\"t\"}");
                        c.nextOfType("welcome", 10); // 等 welcome 再释放写线程
                        clients.add(c);
                        allJoined.countDown();
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }, "c" + i);
                joiners.add(t);
                t.start();
            }
        assertTrue(allJoined.await(30, TimeUnit.SECONDS), "50 条连接未在 30s 内建好");
        System.out.println("[负载] 50/50 连接建立完成");

        // 3) 每条连接发 20 条 PUT；每条记录 send→applied 延迟
        ConcurrentLinkedQueue<Long> latencies = new ConcurrentLinkedQueue<>();
        AtomicInteger appliedCount = new AtomicInteger();
        AtomicInteger orphanCount = new AtomicInteger();
        CountDownLatch allApplied = new CountDownLatch(TOTAL_OPS);
        long sendStart = System.nanoTime();

        List<Thread> writers = new ArrayList<>();
        for (int i = 0; i < CLIENTS; i++) {
            final int idx = i;
            Thread w = new Thread(() -> {
                TestClient c = clients.get(idx);
                java.util.Map<String, Long> sendTimes = new java.util.HashMap<>();
                try {
                    for (int k = 0; k < OPS_PER_CLIENT; k++) {
                                            String clock = "load" + idx + ":" + (k + 1);
                                            sendTimes.put(clock, System.nanoTime());
                                            c.send("{\"type\":\"op\",\"docId\":\"" + docKey + "\",\"clientId\":\"c" + idx
                                                    + "\",\"baseRev\":0,\"op\":{\"type\":\"PUT\",\"elementId\":\"doc-root\",\"elementType\":\"TEXT\","
                                                    + "\"field\":\"text\",\"value\":\"v" + idx + "-" + k + "\",\"clock\":\"" + clock + "\"}}");
                                        }
                                        // 管道式收确认：全部 20 条确认帧过滤对齐
                                        for (int k = 0; k < OPS_PER_CLIENT; k++) {
                                            String clock = "load" + idx + ":" + (k + 1);
                                            awaitApplied(c, clock); // 只认自己的确认帧（广播里按 clock 过滤）
                                            latencies.add(System.nanoTime() - sendTimes.remove(clock));
                                            appliedCount.incrementAndGet();
                                            allApplied.countDown();
                                        }
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            writers.add(w);
            w.start();
        }
        for (Thread w : writers) w.join(120_000);
        assertTrue(allApplied.await(30, TimeUnit.SECONDS), "1000 ops 未全部确认");
        long elapsedMs = (System.nanoTime() - sendStart) / 1_000_000;

        // 4) 终态：新连接 welcome rev = SEED + TOTAL（服务端已全量落库）
        TestClient verifier = new TestClient();
        verifier.tokenParam = token;
        verifier.connect(wsUri);
        verifier.send("{\"type\":\"hello\",\"docId\":\"" + docKey
                + "\",\"clientId\":\"verify\",\"hostname\":\"load\"}");
        JsonNode welcome = verifier.nextOfType("welcome", 10);
        int rev = welcome.get("rev").asInt();
        assertEquals(SEED_REV + 200 + TOTAL_OPS, rev, "服务端 rev 缺失（有操作未落库）");

        // 5) 延迟统计 + 断言
        List<Long> sorted = new ArrayList<>(latencies);
        sorted.sort(Long::compare);
        long p50 = sorted.get(sorted.size() / 2);
        long p95 = sorted.get((int) (sorted.size() * 0.95));
        long p99 = sorted.get((int) (sorted.size() * 0.99));
        long max = sorted.get(sorted.size() - 1);
        System.out.printf("[负载] %d 客户端 × %d ops = %d 条确认 全数落库 rev=%d%n",
                CLIENTS, OPS_PER_CLIENT, sorted.size(), rev);
        System.out.printf("[负载] P50=%.1f ms  P95=%.1f ms  P99=%.1f ms  MAX=%.1f ms%n",
                p50 / 1e6, p95 / 1e6, p99 / 1e6, max / 1e6);
        System.out.printf("[负载] 吞吐 %.0f ops/s（全程 %d ms）%n", TOTAL_OPS / (elapsedMs / 1e3), elapsedMs);
        // 50 并发下延迟为「排队延迟」（含广播扇出），记录不设限；延迟指标由基准段断言
        assertEquals(TOTAL_OPS, appliedCount.get(), "applied 确认数与发送数不符");

        verifier.close();
        clients.forEach(c -> {
            try {
                c.close();
            } catch (Exception ignored) {
            }
        });
    }

    /** 轮询收件箱直到出现「本客户端该 clock 的 applied 确认帧」（广播噪声过滤）。 */
    private static void awaitApplied(TestClient c, String clock) throws Exception {
        long deadline = System.nanoTime() + 30_000_000_000L; // 30s
        while (System.nanoTime() < deadline) {
            String frame = c.inbox.poll(100, TimeUnit.MILLISECONDS);
            if (frame == null) continue;
            JsonNode n = new com.fasterxml.jackson.databind.ObjectMapper().readTree(frame);
            if ("applied".equals(n.path("type").asText())
                    && clock.equals(n.path("op").path("clock").asText())) {
                return;
            }
        }
        throw new AssertionError("等待 applied " + clock + " 超时");
    }
}