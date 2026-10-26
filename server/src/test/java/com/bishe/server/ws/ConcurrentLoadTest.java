package com.bishe.server.ws;

import com.bishe.server.ws.CollabWsIntegrationTest.TestClient;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.websocket.ContainerProvider;
import jakarta.websocket.WebSocketContainer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 单房间并发质量门：10/50/100 个客户端各发送 20 条操作，每个客户端保持一条
 * 未确认操作，收到自身 applied 后立即发送下一条。
 *
 * <p>每档使用独立真实文档，并同时校验发送者确认、每个订阅者的完整广播、数据库
 * 行数/唯一键/连续 seq。50 并发场景的发送到 applied P95 必须严格小于 200 ms。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class ConcurrentLoadTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int OPS_PER_CLIENT = 20;
    private static final int[] CLIENT_MATRIX = {10, 50, 100};
    private static final double FIFTY_CLIENT_P95_LIMIT_MS = 200.0;
    private static final long SCENARIO_TIMEOUT_SECONDS = 120;

    @LocalServerPort
    int port;

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void concurrentMatrixHasBoundedLatencyAndNoLossOrDuplicates() throws Exception {
        List<ScenarioResult> results = new ArrayList<>();
        for (int clientCount : CLIENT_MATRIX) {
            results.add(runScenario(clientCount, OPS_PER_CLIENT));
        }

        System.out.println("[负载矩阵] clients ops P50(ms) P95(ms) P99(ms) MAX(ms) throughput(ops/s) lost duplicate rev");
        for (ScenarioResult result : results) {
            System.out.printf("[负载矩阵] %7d %4d %8.2f %8.2f %8.2f %8.2f %17.0f %4d %9d %d->%d%n",
                    result.clients(), result.totalOps(), result.p50Millis(), result.p95Millis(),
                    result.p99Millis(), result.maxMillis(), result.throughput(), result.lost(),
                    result.duplicates(), result.initialRev(), result.finalRev());
        }

        ScenarioResult fifty = results.stream()
                .filter(result -> result.clients() == 50)
                .findFirst()
                .orElseThrow();
        assertTrue(fifty.p95Millis() < FIFTY_CLIENT_P95_LIMIT_MS,
                () -> "50 并发 P95 必须 < 200ms，实测 "
                        + String.format("%.2fms", fifty.p95Millis()));
    }

    private ScenarioResult runScenario(int clientCount, int opsPerClient) throws Exception {
        AuthTestSupport.TestDocument document = AuthTestSupport.document(
                port, "load-" + clientCount, "doc");
        URI wsUri = URI.create("ws://localhost:" + port + "/ws/collab");
        TestClient[] clients = new TestClient[clientCount];
        ExecutorService connectors = Executors.newFixedThreadPool(Math.min(clientCount, 16));
        ExecutorService workers = null;
        try {
            List<Future<Long>> joined = new ArrayList<>(clientCount);
            for (int index = 0; index < clientCount; index++) {
                final int clientIndex = index;
                joined.add(connectors.submit(() -> connectClient(
                        clients, clientIndex, clientCount, document, wsUri)));
            }

            long initialRev = -1;
            for (Future<Long> future : joined) {
                long welcomeRev = future.get(30, TimeUnit.SECONDS);
                if (initialRev < 0) {
                    initialRev = welcomeRev;
                } else {
                    assertEquals(initialRev, welcomeRev,
                            "开始压测前所有客户端必须处于同一 rev");
                }
            }
            connectors.shutdown();
            assertTrue(connectors.awaitTermination(10, TimeUnit.SECONDS), "连接线程未按时结束");

            for (TestClient client : clients) {
                awaitFullPresence(client, clientCount);
                client.inbox.clear();
            }

            int totalOps = Math.multiplyExact(clientCount, opsPerClient);
            long finalRev = Math.addExact(initialRev, totalOps);
            CountDownLatch start = new CountDownLatch(1);
            workers = Executors.newFixedThreadPool(clientCount);
            List<Future<ClientObservation>> observations = new ArrayList<>(clientCount);
            for (int index = 0; index < clientCount; index++) {
                final int clientIndex = index;
                final long scenarioInitialRev = initialRev;
                observations.add(workers.submit(() -> exerciseClient(
                        clients[clientIndex], clientId(clientCount, clientIndex),
                        clientCount, clientIndex, opsPerClient, totalOps,
                        scenarioInitialRev, finalRev, start)));
            }

            long startedAt = System.nanoTime();
            start.countDown();
            List<Long> latencies = new ArrayList<>(totalOps);
            int acknowledgementDuplicates = 0;
            for (Future<ClientObservation> future : observations) {
                ClientObservation observation = future.get(SCENARIO_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                assertEquals(totalOps, observation.appliedFrames(),
                        "每个客户端都应收到每条 applied 广播一次");
                assertEquals(totalOps, observation.uniqueClocks(),
                        "广播 clock 集合不完整");
                assertEquals(totalOps, observation.uniqueRevisions(),
                        "广播 rev 集合不完整");
                assertEquals(opsPerClient, observation.ownAcknowledgements(),
                        "发送者未收到全部自身确认");
                acknowledgementDuplicates += observation.ownDuplicateAcknowledgements();
                latencies.addAll(observation.ownLatencies());
            }
            long elapsedNanos = System.nanoTime() - startedAt;
            workers.shutdown();
            assertTrue(workers.awaitTermination(10, TimeUnit.SECONDS), "负载线程未按时结束");

            assertEquals(totalOps, latencies.size(), "延迟样本数必须等于发送操作数");
            PersistenceStats persisted = persistenceStats(document.docKey(), initialRev);
            int databaseLost = Math.max(0, totalOps - persisted.rows());
            int databaseDuplicates = Math.max(0, persisted.rows() - persisted.uniqueOperationIds());
            int lost = databaseLost + Math.max(0, totalOps - latencies.size());
            int duplicates = databaseDuplicates + acknowledgementDuplicates;

            assertEquals(totalOps, persisted.rows(), "数据库操作数与发送数不符");
            assertEquals(totalOps, persisted.uniqueOperationIds(), "数据库 operation_id 非唯一");
            assertEquals(initialRev + 1, persisted.minSeq(), "数据库 seq 起点不连续");
            assertEquals(finalRev, persisted.maxSeq(), "数据库 seq 终点不连续");
            assertEquals(0, lost, "负载场景存在操作丢失");
            assertEquals(0, duplicates, "负载场景存在重复确认或重复持久化");

            latencies.sort(Long::compareTo);
            ScenarioResult result = new ScenarioResult(clientCount, totalOps, initialRev, finalRev,
                    percentile(latencies, 0.50), percentile(latencies, 0.95),
                    percentile(latencies, 0.99), latencies.get(latencies.size() - 1),
                    elapsedNanos, lost, duplicates);
            System.out.printf("[负载] clients=%d ops=%d ack=%d/%d db=%d/%d lost=%d duplicate=%d "
                            + "P50=%.2fms P95=%.2fms P99=%.2fms MAX=%.2fms throughput=%.0fops/s%n",
                    clientCount, totalOps, latencies.size(), totalOps, persisted.rows(), totalOps,
                    lost, duplicates, result.p50Millis(), result.p95Millis(), result.p99Millis(),
                    result.maxMillis(), result.throughput());
            return result;
        } finally {
            connectors.shutdownNow();
            if (workers != null) {
                workers.shutdownNow();
            }
            closeAll(clients);
        }
    }

    private long connectClient(TestClient[] clients, int index, int clientCount,
                               AuthTestSupport.TestDocument document, URI wsUri) throws Exception {
        TestClient client = new LoadClient();
        clients[index] = client;
        client.tokenParam = document.token();
        try {
            client.connect(wsUri);
            String id = clientId(clientCount, index);
            ObjectNode hello = MAPPER.createObjectNode();
            hello.put("type", "hello");
            hello.put("docId", document.docKey());
            hello.put("clientId", id);
            hello.put("hostname", "load-test");
            hello.put("lastRev", 0);
            client.send(hello.toString());
            JsonNode welcome = client.nextOfType("welcome", 20);
            return welcome.path("rev").asLong();
        } catch (Exception | AssertionError e) {
            closeQuietly(client);
            throw e;
        }
    }

    private ClientObservation exerciseClient(TestClient client, String id, int clientCount,
                                             int clientIndex, int opsPerClient, int totalOps,
                                             long initialRev, long finalRev,
                                             CountDownLatch start) throws Exception {
        assertTrue(start.await(30, TimeUnit.SECONDS), "负载启动栅栏超时");
        ObservationAccumulator accumulator = new ObservationAccumulator(
                opsPerClient, totalOps, initialRev, finalRev);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(SCENARIO_TIMEOUT_SECONDS);
        for (int counter = 1; counter <= opsPerClient; counter++) {
            String clock = id + ":" + counter;
            ObjectNode frame = MAPPER.createObjectNode();
            frame.put("type", "op");
            frame.put("opId", clock);
            frame.put("baseRev", initialRev);
            ObjectNode op = frame.putObject("op");
            op.put("type", "STATE");
            op.put("elementId", "load-element-" + clientIndex);
            op.put("elementType", "TEXT");
            op.putObject("value").put("text", "x".repeat(256)).put("order", clientIndex);
            op.put("clock", clock);
            accumulator.sentAt.put(clock, System.nanoTime());
            client.send(frame.toString());
            while (!accumulator.ownClocks.contains(clock)) {
                accumulator.record(nextApplied(client, deadline));
            }
        }

        while (accumulator.highestRev < finalRev) {
            accumulator.record(nextApplied(client, deadline));
        }
        return accumulator.toObservation();
    }

    private static JsonNode nextApplied(TestClient client, long deadline) throws Exception {
        while (System.nanoTime() < deadline) {
            String payload = client.inbox.poll(200, TimeUnit.MILLISECONDS);
            if (payload == null) {
                continue;
            }
            JsonNode frame = MAPPER.readTree(payload);
            String type = frame.path("type").asText();
            if ("error".equals(type)) {
                throw new AssertionError("负载期间服务端错误 " + frame.path("code").asText()
                        + ": " + frame.path("message").asText());
            }
            if (!"applied".equals(type)) {
                continue;
            }
            return frame;
        }
        throw new AssertionError("等待 applied 超时");
    }

    private static void awaitFullPresence(TestClient client, int expectedClients) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            String payload = client.inbox.poll(200, TimeUnit.MILLISECONDS);
            if (payload == null) {
                continue;
            }
            JsonNode frame = MAPPER.readTree(payload);
            if ("error".equals(frame.path("type").asText())) {
                throw new AssertionError("等待 presence 时服务端错误: " + payload);
            }
            if ("presence".equals(frame.path("type").asText())
                    && frame.path("clients").size() == expectedClients) {
                return;
            }
        }
        throw new AssertionError("等待 " + expectedClients + " 人 presence 超时");
    }

    private PersistenceStats persistenceStats(String docId, long afterRev) {
        return jdbc.queryForObject("""
                        SELECT COUNT(*) AS row_count,
                               COUNT(DISTINCT operation_id) AS unique_count,
                               COALESCE(MIN(seq), 0) AS min_seq,
                               COALESCE(MAX(seq), 0) AS max_seq
                        FROM operation_log
                        WHERE doc_id=? AND seq>?
                        """,
                (rs, rowNum) -> new PersistenceStats(
                        rs.getInt("row_count"), rs.getInt("unique_count"),
                        rs.getLong("min_seq"), rs.getLong("max_seq")),
                docId, afterRev);
    }

    private static long percentile(List<Long> sorted, double quantile) {
        int index = Math.max(0, (int) Math.ceil(sorted.size() * quantile) - 1);
        return sorted.get(index);
    }

    private static String clientId(int clientCount, int index) {
        return "load" + clientCount + "c" + index;
    }

    private static void closeAll(TestClient[] clients) {
        for (TestClient client : clients) {
            if (client != null) {
                closeQuietly(client);
            }
        }
    }

    private static void closeQuietly(TestClient client) {
        try {
            client.close();
        } catch (Exception ignored) {
            // Test cleanup is best-effort.
        }
    }

    private record ClientObservation(int appliedFrames, int uniqueClocks, int uniqueRevisions,
                                     int ownAcknowledgements, int ownDuplicateAcknowledgements,
                                     List<Long> ownLatencies) {
    }

    private static final class ObservationAccumulator {
        private final long initialRev;
        private final long finalRev;
        private final Map<String, Long> sentAt;
        private final Set<String> seenClocks;
        private final Set<Long> seenRevisions;
        private final Set<String> ownClocks;
        private final List<Long> ownLatencies;
        private int appliedFrames;
        private int ownDuplicates;
        private long highestRev;

        private ObservationAccumulator(int ownOperations, int totalOperations,
                                       long initialRev, long finalRev) {
            this.initialRev = initialRev;
            this.finalRev = finalRev;
            this.sentAt = new HashMap<>(ownOperations);
            this.seenClocks = new HashSet<>(totalOperations);
            this.seenRevisions = new HashSet<>(totalOperations);
            this.ownClocks = new HashSet<>(ownOperations);
            this.ownLatencies = new ArrayList<>(ownOperations);
            this.highestRev = initialRev;
        }

        private void record(JsonNode frame) {
            long rev = frame.path("rev").asLong(-1);
            if (rev <= initialRev || rev > finalRev) {
                throw new AssertionError("applied.rev 超出场景范围: " + rev);
            }
            appliedFrames++;
            seenRevisions.add(rev);
            String clock = frame.path("op").path("clock").asText();
            seenClocks.add(clock);
            Long operationSentAt = sentAt.get(clock);
            if (operationSentAt != null) {
                if (ownClocks.add(clock)) {
                    ownLatencies.add(System.nanoTime() - operationSentAt);
                } else {
                    ownDuplicates++;
                }
            }
            highestRev = Math.max(highestRev, rev);
        }

        private ClientObservation toObservation() {
            return new ClientObservation(appliedFrames, seenClocks.size(), seenRevisions.size(),
                    ownClocks.size(), ownDuplicates, ownLatencies);
        }
    }

    /** The Jakarta client defaults to 8 KiB, smaller than a 100-member presence frame. */
    private static final class LoadClient extends TestClient {
        @Override
        void connect(URI uri) throws Exception {
            String token = tokenParam;
            if (token == null) {
                token = AuthTestSupport.token(uri.getPort(),
                        "load-auto-" + java.util.UUID.randomUUID().toString().substring(0, 8));
            }
            URI authenticated = URI.create(uri + "?token="
                    + URLEncoder.encode(token, StandardCharsets.UTF_8));
            WebSocketContainer container = ContainerProvider.getWebSocketContainer();
            container.setDefaultMaxTextMessageBufferSize(256 * 1024);
            StandardWebSocketClient webSocketClient = new StandardWebSocketClient(container);
            session = webSocketClient.execute(new TextWebSocketHandler() {
                @Override
                protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
                    inbox.offer(message.getPayload());
                }
            }, new WebSocketHttpHeaders(new HttpHeaders()), authenticated).get(20, TimeUnit.SECONDS);
        }
    }

    private record PersistenceStats(int rows, int uniqueOperationIds, long minSeq, long maxSeq) {
    }

    private record ScenarioResult(int clients, int totalOps, long initialRev, long finalRev,
                                  long p50Nanos, long p95Nanos, long p99Nanos, long maxNanos,
                                  long elapsedNanos, int lost, int duplicates) {
        double p50Millis() {
            return p50Nanos / 1_000_000.0;
        }

        double p95Millis() {
            return p95Nanos / 1_000_000.0;
        }

        double p99Millis() {
            return p99Nanos / 1_000_000.0;
        }

        double maxMillis() {
            return maxNanos / 1_000_000.0;
        }

        double throughput() {
            return totalOps / (elapsedNanos / 1_000_000_000.0);
        }
    }
}
