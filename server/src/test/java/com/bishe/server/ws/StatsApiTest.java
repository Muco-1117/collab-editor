package com.bishe.server.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Date;
import java.time.Duration;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/** 统计按数据库当前自然日补零，同名成员用稳定账号 ID 区分，权限过滤不能丢失。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class StatsApiTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();
    private record Account(long id, String username, String token) {}

    @Test
    void newAccountHasAllSevenDaysInOrderWithZeroActivity() throws Exception {
        Account account = account("stats-empty", "刚加入的同学");
        JsonNode response = call("GET", "/api/stats", account, null);
        JsonNode recent = response.path("recentActivity");
        assertSevenDates(recent);
        for (JsonNode day : recent) assertEquals(0, day.path("operation_count").asLong());
        assertEquals(0, response.path("contributors").size());
        assertEquals(0, response.path("operations").asLong());
    }

    @Test
    void equalNicknamesStaySeparateAndActivityExcludesDeletedOrForeignContent() throws Exception {
        Account owner = account("stats-owner", "同名同学"), editor = account("stats-edit", "同名同学"), outsider = account("stats-out", "空间外成员");
        JsonNode created = call("POST", "/api/docs", owner, Map.of("kind", "board", "title", "可见协作"));
        String doc = created.path("docKey").asText();
        long space = created.path("spaceId").asLong();
        call("POST", "/api/spaces/" + space + "/members", owner, Map.of("username", editor.username(), "role", "editor"));
        var first = open(owner, doc, "stats-owner");
        var second = open(editor, doc, "stats-editor");
        try {
            first.send(operation("stats-owner", 100));
            first.nextOfType("applied", 5);
            second.nextOfType("applied", 5);
            second.send(operation("stats-editor", 101));
            second.nextOfType("applied", 5);
            first.nextOfType("applied", 5);
        } finally {
            first.close();
            second.close();
        }
        jdbc.update("UPDATE operation_log SET created_at=CURRENT_DATE - INTERVAL 2 DAY WHERE doc_id=? AND actor_id=?", doc, owner.id());
        jdbc.update("UPDATE operation_log SET created_at=CURRENT_DATE - INTERVAL 6 DAY WHERE doc_id=? AND actor_id=?", doc, editor.id());

        // Both excluded documents really contain durable operations, so a missing filter changes the result.
        String deleted = call("POST", "/api/docs", owner, Map.of("kind", "board", "title", "已删除协作")).path("docKey").asText();
        String hidden = call("POST", "/api/docs", outsider, Map.of("kind", "board", "title", "私有协作")).path("docKey").asText();
        write(owner, deleted, "stats-deleted");
        write(outsider, hidden, "stats-hidden");
        call("DELETE", "/api/docs/" + deleted, owner, null);

        JsonNode response = call("GET", "/api/stats", owner, null);
        assertEquals(2, response.path("operations").asLong());
        assertEquals(1, response.path("ownOperations").asLong());
        JsonNode recent = response.path("recentActivity");
        assertSevenDates(recent);
        List<Long> counts = new ArrayList<>();
        for (JsonNode day : recent) counts.add(day.path("operation_count").asLong());
        assertEquals(List.of(1L, 0L, 0L, 0L, 1L, 0L, 0L), counts);

        JsonNode contributors = response.path("contributors");
        assertEquals(2, contributors.size());
        var ids = new HashSet<Long>();
        for (JsonNode contributor : contributors) {
            ids.add(contributor.path("actor_id").asLong());
            assertEquals("同名同学", contributor.path("actor_name").asText());
            assertEquals(1, contributor.path("operation_count").asLong());
        }
        assertEquals(java.util.Set.of(owner.id(), editor.id()), ids);
        assertEquals(Math.min(owner.id(), editor.id()), contributors.get(0).path("actor_id").asLong());
        assertEquals(Math.max(owner.id(), editor.id()), contributors.get(1).path("actor_id").asLong());

        // Historical dates outside the window remain in totals, but not in the seven-day chart.
        jdbc.update("UPDATE operation_log SET created_at=CURRENT_DATE - INTERVAL 7 DAY WHERE doc_id=? AND actor_id=?", doc, editor.id());
        JsonNode shifted = call("GET", "/api/stats", owner, null);
        assertEquals(0, shifted.path("recentActivity").get(0).path("operation_count").asLong());
        assertEquals(2, shifted.path("operations").asLong());
    }

    private void assertSevenDates(JsonNode recent) {
        LocalDate today = jdbc.queryForObject("SELECT CURRENT_DATE", Date.class).toLocalDate();
        assertEquals(7, recent.size());
        for (int index = 0; index < 7; index++) {
            assertEquals(today.minusDays(6 - index).toString(), recent.get(index).path("activity_date").asText());
        }
    }

    private Account account(String prefix, String nickname) throws Exception {
        String username = prefix + "-" + UUID.randomUUID().toString().substring(0, 7);
        JsonNode response = call("POST", "/api/auth/register", null,
                Map.of("username", username, "password", "test-pass-123", "nickname", nickname));
        return new Account(response.at("/user/id").asLong(), username, response.path("token").asText());
    }

    private JsonNode call(String method, String path, Account account, Object payload) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).timeout(Duration.ofSeconds(15));
        if (account != null) request.header("Authorization", "Bearer " + account.token());
        if (payload == null) request.method(method, HttpRequest.BodyPublishers.noBody());
        else request.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(json.writeValueAsString(payload)));
        var response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode(), response.body());
        return json.readTree(response.body());
    }

    private CollabWsIntegrationTest.TestClient open(Account account, String key, String clientId) throws Exception {
        var client = new CollabWsIntegrationTest.TestClient();
        client.tokenParam = account.token();
        client.connect(URI.create("ws://localhost:" + port + "/ws/collab"));
        client.send(json.writeValueAsString(Map.of("type", "hello", "docId", key, "clientId", clientId, "lastRev", 0)));
        client.nextOfType("welcome", 5);
        return client;
    }

    private String operation(String clientId, long counter) throws Exception {
        return json.writeValueAsString(Map.of("type", "op", "op", Map.of(
                "type", "STATE", "elementId", clientId + "-card", "elementType", "CARD", "opId", clientId + "-" + counter,
                "clock", clientId + ":" + counter, "value", Map.of("text", "真实协作统计", "x", 80, "y", 80))));
    }

    private void write(Account account, String key, String clientId) throws Exception {
        var socket = open(account, key, clientId);
        try {
            socket.send(operation(clientId, 100));
            socket.nextOfType("applied", 5);
        } finally {
            socket.close();
        }
    }
}
