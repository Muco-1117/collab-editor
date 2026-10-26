package com.bishe.server.ws;

import com.bishe.server.store.OpStore;
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
import java.sql.Timestamp;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/** Real HTTP/WebSocket/MySQL coverage; run only in the guarded collab_editor_test database. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class ContentLifecycleApiTest {

    @LocalServerPort int port;
    @Autowired JdbcTemplate jdbc;
    @Autowired OpStore store;
    @Autowired RoomRegistry rooms;

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();

    private record Account(long id, String username, String token) {}

    @Test
    void roleChangeAndRemovalApplyImmediatelyToBothOpenTabsAndNewConnections() throws Exception {
        Account owner = account("member-owner"), member = account("member-edit"), outsider = account("member-out");
        String docKey = createDoc(owner, "board");
        long spaceId = json.readTree(call("GET", "/api/docs/" + docKey, owner, null).body()).path("space_id").asLong();
        String memberPath = "/api/spaces/" + spaceId + "/members/" + member.id();
        assertEquals(200, call("POST", "/api/spaces/" + spaceId + "/members", owner,
                Map.of("username", member.username(), "role", "editor")).statusCode());

        var first = open(member, docKey, "member-first");
        var second = open(member, docKey, "member-second");
        var ownerSocket = open(owner, docKey, "member-owner");
        try {
            assertEquals(403, call("PUT", memberPath, member, Map.of("role", "viewer")).statusCode());
            assertEquals(403, call("DELETE", memberPath, outsider, null).statusCode());
            assertEquals(400, call("PUT", "/api/spaces/" + spaceId + "/members/" + owner.id(), owner,
                    Map.of("role", "viewer")).statusCode());
            assertEquals(400, call("DELETE", "/api/spaces/" + spaceId + "/members/" + owner.id(), owner, null).statusCode());
            assertEquals(404, call("DELETE", "/api/spaces/" + spaceId + "/members/" + outsider.id(), owner, null).statusCode());
            assertEquals(400, call("PUT", memberPath, owner, Map.of("role", "owner")).statusCode());

            assertEquals(200, call("PUT", memberPath, owner, Map.of("role", "viewer")).statusCode());
            for (var socket : List.of(first, second)) {
                JsonNode access = socket.nextOfType("access", 5);
                assertEquals("viewer", access.path("role").asText());
                assertFalse(access.path("canWrite").asBoolean());
            }
            first.send(operation("member-first", 1, "denied", "未授权输入"));
            assertEquals("READ_ONLY", first.nextOfType("error", 5).path("code").asText());
            assertEquals(0, store.maxSeq(docKey));

            assertEquals(200, call("PUT", memberPath, owner, Map.of("role", "editor")).statusCode());
            for (var socket : List.of(first, second)) {
                assertTrue(socket.nextOfType("access", 5).path("canWrite").asBoolean());
            }
            first.send(operation("member-first", 1, "allowed", "可编辑内容"));
            assertEquals("applied", first.nextOfType("applied", 5).path("type").asText());
            assertEquals("可编辑内容", second.nextOfType("applied", 5).at("/op/value/text").asText());

            assertEquals(200, call("DELETE", memberPath, owner, null).statusCode());
            for (var socket : List.of(first, second)) {
                JsonNode error = socket.nextOfType("error", 5);
                assertEquals("MEMBERSHIP_REVOKED", error.path("code").asText());
                assertTrue(error.path("fatal").asBoolean());
            }
            assertEquals(403, call("GET", "/api/docs/" + docKey, member, null).statusCode());
            assertEquals(403, call("GET", "/api/docs/" + docKey + "/history", member, null).statusCode());
            assertEquals(404, call("DELETE", memberPath, owner, null).statusCode());
            var denied = new CollabWsIntegrationTest.TestClient();
            denied.tokenParam = member.token();
            try {
                denied.connect(wsUri());
                denied.send(hello(docKey, "removed-member"));
                assertEquals("DOC_ACCESS_DENIED", denied.nextOfType("error", 5).path("code").asText());
            } finally {
                denied.close();
            }
            ownerSocket.send(operation("member-owner", 2, "owner-still-here", "所有者继续编辑"));
            JsonNode applied = ownerSocket.nextOfType("applied", 5);
            if (!"owner-still-here".equals(applied.at("/op/elementId").asText())) {
                applied = ownerSocket.nextOfType("applied", 5);
            }
            assertEquals("owner-still-here", applied.at("/op/elementId").asText());
        } finally {
            first.close();
            second.close();
            ownerSocket.close();
        }
    }

    @Test
    void deleteNotifiesReadersImmediatelyAndRetainsAppendOnlyHistory() throws Exception {
        Account owner = account("delete-owner"), viewer = account("delete-view");
        String docKey = createDoc(owner, "board");
        long spaceId = json.readTree(call("GET", "/api/docs/" + docKey, owner, null).body()).path("space_id").asLong();
        assertEquals(200, call("POST", "/api/spaces/" + spaceId + "/members", owner,
                Map.of("username", viewer.username(), "role", "viewer")).statusCode());
        var writer = open(owner, docKey, "delete-writer");
        var reader = open(viewer, docKey, "delete-reader");
        try {
            writer.send(operation("delete-writer", 1, "persisted", "删除前内容"));
            writer.nextOfType("applied", 5);
            reader.nextOfType("applied", 5);
            long revision = store.maxSeq(docKey);
            assertEquals(403, call("DELETE", "/api/docs/" + docKey, viewer, null).statusCode());
            assertEquals(200, call("DELETE", "/api/docs/" + docKey, owner, null).statusCode());
            for (var socket : List.of(writer, reader)) {
                JsonNode error = socket.nextOfType("error", 5);
                assertEquals("DOCUMENT_DELETED", error.path("code").asText());
                assertTrue(error.path("fatal").asBoolean());
            }
            assertNull(rooms.get(docKey));
            assertEquals(404, call("GET", "/api/docs/" + docKey, owner, null).statusCode());
            assertEquals(404, call("DELETE", "/api/docs/" + docKey, owner, null).statusCode());
            assertEquals(revision, store.maxSeq(docKey), "删除必须保留日志且不能追加旧操作");
        } finally {
            writer.close();
            reader.close();
        }
    }

    @Test
    void durableEditsUpdateListOrderWhileDuplicateAcknowledgementsDoNotRetouchMetadata() throws Exception {
        Account owner = account("recent-edit");
        String edited = createDoc(owner, "board");
        String untouched = createDoc(owner, "board");
        jdbc.update("UPDATE document SET updated_at='2000-01-01 00:00:00' WHERE doc_key=?", edited);
        jdbc.update("UPDATE document SET updated_at='2001-01-01 00:00:00' WHERE doc_key=?", untouched);
        var client = open(owner, edited, "recent-writer");
        try {
            String operation = operation("recent-writer", 1, "recent-card", "最近编辑");
            client.send(operation);
            client.nextOfType("applied", 5);
            assertEquals(edited, json.readTree(call("GET", "/api/docs", owner, null).body()).get(0).path("doc_key").asText());
            Timestamp actual = jdbc.queryForObject("SELECT updated_at FROM document WHERE doc_key=?", Timestamp.class, edited);
            assertNotNull(actual);
            assertTrue(actual.after(Timestamp.valueOf("2001-01-01 00:00:00")));
            jdbc.update("UPDATE document SET updated_at='2002-01-01 00:00:00' WHERE doc_key=?", edited);
            client.send(operation);
            assertTrue(client.nextOfType("applied", 5).path("duplicate").asBoolean());
            assertEquals(Timestamp.valueOf("2002-01-01 00:00:00"),
                    jdbc.queryForObject("SELECT updated_at FROM document WHERE doc_key=?", Timestamp.class, edited));
        } finally {
            client.close();
        }
    }

    @Test
    void renamingAnyContentUpdatesOpenPeersAndReconnectedMetadata() throws Exception {
        Account owner = account("metadata-owner");
        for (String kind : List.of("doc", "board", "kanban")) {
            String docKey = createDoc(owner, kind);
            String firstId = "metadata-" + kind;
            var client = open(owner, docKey, firstId);
            try {
                if (!"doc".equals(kind)) {
                    client.send(operation(firstId, 1, "existing-card", "已有内容"));
                    client.nextOfType("applied", 5);
                }
                long before = store.maxSeq(docKey);
                String title = "实时更新标题-" + kind;
                assertEquals(200, call("PUT", "/api/docs/" + docKey, owner, Map.of("title", title)).statusCode());
                JsonNode metadata = client.nextOfType("metadata", 5);
                assertEquals(docKey, metadata.path("docId").asText());
                assertEquals(kind, metadata.path("kind").asText());
                assertEquals(title, metadata.path("title").asText());
                long after = store.maxSeq(docKey);
                assertEquals(before + ("doc".equals(kind) ? 1 : 0), after);

                var reconnect = new CollabWsIntegrationTest.TestClient();
                reconnect.tokenParam = owner.token();
                try {
                    reconnect.connect(wsUri());
                    reconnect.send(json.writeValueAsString(Map.of("type", "hello", "docId", docKey,
                            "clientId", "resume-" + kind, "lastRev", after)));
                    JsonNode incremental = reconnect.nextOfType("incremental", 5);
                    assertEquals(docKey, incremental.path("docId").asText());
                    assertEquals(kind, incremental.path("kind").asText());
                    assertEquals(title, incremental.path("title").asText());
                    assertEquals(0, incremental.path("ops").size());
                } finally {
                    reconnect.close();
                }
                assertEquals(200, call("POST", "/api/docs/" + docKey + "/restore", owner,
                        Map.of("rev", before)).statusCode());
                assertEquals(title, json.readTree(call("GET", "/api/docs/" + docKey, owner, null).body()).path("title").asText());
                assertEquals(title, rooms.get(docKey).metadataTitle());
                if ("doc".equals(kind)) assertEquals(title, rooms.get(docKey).currentTitle());
            } finally {
                client.close();
            }
        }
    }

    private Account account(String prefix) throws Exception {
        String username = prefix + "-" + UUID.randomUUID().toString().substring(0, 6);
        HttpResponse<String> response = call("POST", "/api/auth/register", null,
                Map.of("username", username, "password", "test-pass-123"));
        assertEquals(200, response.statusCode(), response.body());
        JsonNode body = json.readTree(response.body());
        return new Account(body.at("/user/id").asLong(), username, body.path("token").asText());
    }

    private String createDoc(Account owner, String kind) throws Exception {
        HttpResponse<String> response = call("POST", "/api/docs", owner, Map.of("title", "生命周期测试", "kind", kind));
        assertEquals(200, response.statusCode(), response.body());
        return json.readTree(response.body()).path("docKey").asText();
    }

    private HttpResponse<String> call(String method, String path, Account account, Object body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .timeout(Duration.ofSeconds(10));
        if (account != null) request.header("Authorization", "Bearer " + account.token());
        if (body == null) request.method(method, HttpRequest.BodyPublishers.noBody());
        else request.header("Content-Type", "application/json")
                .method(method, HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private URI wsUri() {
        return URI.create("ws://localhost:" + port + "/ws/collab");
    }

    private CollabWsIntegrationTest.TestClient open(Account member, String docKey, String clientId) throws Exception {
        var client = new CollabWsIntegrationTest.TestClient();
        client.tokenParam = member.token();
        client.connect(wsUri());
        client.send(hello(docKey, clientId));
        client.nextOfType("welcome", 5);
        return client;
    }

    private String hello(String docKey, String clientId) throws Exception {
        return json.writeValueAsString(Map.of("type", "hello", "docId", docKey, "clientId", clientId, "lastRev", 0));
    }

    private String operation(String clientId, long counter, String id, String text) throws Exception {
        return json.writeValueAsString(Map.of("type", "op", "op", Map.of(
                "type", "STATE", "elementId", id, "elementType", "CARD", "opId", clientId + "-" + counter,
                "clock", clientId + ":" + counter, "value", Map.of("text", text, "x", 50, "y", 50))));
    }
}
