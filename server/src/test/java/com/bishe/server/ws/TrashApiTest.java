package com.bishe.server.ws;

import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.OpStore;
import com.bishe.server.store.SpaceRepo;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/** 仅由集成测试的数据库守卫允许在 collab_editor_test 运行。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class TrashApiTest {

    @LocalServerPort int port;
    @Autowired DocRepo documents;
    @Autowired SpaceRepo spaces;
    @Autowired OpStore store;
    @Autowired RoomRegistry rooms;
    @Autowired JdbcTemplate jdbc;

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();

    private record Account(long id, String username, String token) {}

    @Test
    void trashIsOwnerOnlyAndDoesNotRevealOtherSpacesOrDocumentExistence() throws Exception {
        Account owner = account("trash-owner"), editor = account("trash-edit"), viewer = account("trash-view"), outsider = account("trash-other");
        String key = create(owner, "board", null);
        long spaceId = spaceOf(key);
        assertEquals(200, call("POST", "/api/spaces/" + spaceId + "/members", owner,
                Map.of("username", editor.username(), "role", "editor")).statusCode());
        assertEquals(200, call("POST", "/api/spaces/" + spaceId + "/members", owner,
                Map.of("username", viewer.username(), "role", "viewer")).statusCode());
        assertEquals(403, call("DELETE", "/api/docs/" + key, editor, null).statusCode());
        assertEquals(200, call("DELETE", "/api/docs/" + key, owner, null).statusCode());
        String listPath = "/api/spaces/" + spaceId + "/trash", restorePath = restorePath(key);

        assertEquals(401, call("GET", listPath, null, null).statusCode());
        assertEquals(401, call("POST", restorePath, null, null).statusCode());
        for (Account member : List.of(editor, viewer)) {
            assertEquals(403, call("GET", listPath, member, null).statusCode());
            assertEquals(403, call("POST", restorePath, member, null).statusCode());
        }
        HttpResponse<String> hidden = call("POST", restorePath, outsider, null);
        HttpResponse<String> missing = call("POST", restorePath(UUID.randomUUID().toString()), outsider, null);
        assertEquals(404, hidden.statusCode());
        assertEquals(missing.statusCode(), hidden.statusCode());
        assertEquals(missing.body(), hidden.body());
        HttpResponse<String> hiddenSpace = call("GET", listPath, outsider, null);
        HttpResponse<String> missingSpace = call("GET", "/api/spaces/9223372036854775807/trash", outsider, null);
        assertEquals(404, hiddenSpace.statusCode());
        assertEquals(missingSpace.statusCode(), hiddenSpace.statusCode());
        assertEquals(missingSpace.body(), hiddenSpace.body());

        JsonNode rows = body(call("GET", listPath, owner, null)).path("documents");
        assertEquals(1, rows.size());
        assertEquals(key, rows.get(0).path("doc_key").asText());
        assertEquals("owner", rows.get(0).path("my_role").asText());
        assertEquals("board", rows.get(0).path("kind").asText());
        assertEquals(spaceId, rows.get(0).path("space_id").asLong());
        assertTrue(rows.get(0).hasNonNull("deleted_at"));
        assertTrue(rows.get(0).hasNonNull("updated_at"));
        assertFalse(rows.get(0).path("space_name").asText().isBlank());
        assertEquals(0, body(call("GET", "/api/docs?spaceId=" + spaceId, owner, null)).size());

        // A legacy space-admin is allowed; a platform-admin in an unrelated space still is not.
        spaces.addMember(spaceId, viewer.id(), "admin");
        assertEquals(200, call("GET", listPath, viewer, null).statusCode());
        assertEquals(200, call("POST", restorePath, viewer, null).statusCode());
        assertEquals(200, call("GET", "/api/docs/" + key, editor, null).statusCode());
        assertEquals(0, body(call("GET", listPath, owner, null)).path("documents").size());
    }

    @Test
    void documentBoardAndKanbanRestoreOriginalContentImagesSnapshotsHistoryAndEditing() throws Exception {
        Account owner = account("trash-content"), viewer = account("trash-read");
        Long sharedSpace = null;
        for (String kind : List.of("doc", "board", "kanban")) {
            String key = create(owner, kind, sharedSpace);
            long spaceId = spaceOf(key);
            if (sharedSpace == null) {
                sharedSpace = spaceId;
                assertEquals(200, call("POST", "/api/spaces/" + spaceId + "/members", owner,
                        Map.of("username", viewer.username(), "role", "viewer")).statusCode());
            }
            JsonNode asset = upload(key, owner);
            String clientId = "trash-write-" + kind;
            var writer = open(owner, key, clientId);
            var reader = open(viewer, key, "trash-read-" + kind);
            List<Op> content = content(kind, asset, clientId);
            for (Op operation : content) {
                writer.send(frame(operation));
                writer.nextOfType("applied", 5);
                reader.nextOfType("applied", 5);
            }
            CollabRoom original = rooms.get(key);
            assertNotNull(original);
            long revision = store.maxSeq(key);
            String canonical = original.state().canonicalHash();
            store.saveSnapshot(key, revision, OpStore.encodeElements(new ArrayList<>(original.state().elements().values())));
            JsonNode timeline = body(call("GET", "/api/docs/" + key + "/history?limit=100", owner, null));
            JsonNode replay = body(call("GET", "/api/docs/" + key + "/replay?rev=" + revision, owner, null));
            long logCount = count("operation_log", key), snapshotCount = count("element_snapshot", key), imageCount = count("image_asset", key);
            try {
                assertEquals(200, call("DELETE", "/api/docs/" + key, owner, null).statusCode());
                for (var socket : List.of(writer, reader)) {
                    JsonNode deleted = socket.nextOfType("error", 5);
                    assertEquals("DOCUMENT_DELETED", deleted.path("code").asText());
                    assertTrue(deleted.path("fatal").asBoolean());
                }
                assertNull(rooms.get(key));
                assertNull(documents.get(key));
                assertEquals(403, bytes("GET", asset.path("url").asText(), viewer, null, null).statusCode());
                assertEquals(logCount, count("operation_log", key));
                assertEquals(snapshotCount, count("element_snapshot", key));
                assertEquals(imageCount, count("image_asset", key));
                assertEquals(revision, store.maxSeq(key));

                JsonNode restored = body(call("POST", restorePath(key), owner, null));
                assertEquals(key, restored.path("docKey").asText());
                assertEquals(kind, restored.path("kind").asText());
                assertEquals(spaceId, restored.path("spaceId").asLong());
                assertEquals("回收站内容-" + kind, restored.path("title").asText());
                assertEquals(timeline, body(call("GET", "/api/docs/" + key + "/history?limit=100", owner, null)));
                assertEquals(replay, body(call("GET", "/api/docs/" + key + "/replay?rev=" + revision, owner, null)));
                assertArrayEquals(png(), bytes("GET", asset.path("url").asText(), viewer, null, null).body());
                assertEquals(snapshotCount, count("element_snapshot", key));
                assertEquals(imageCount, count("image_asset", key));

                var reopened = open(owner, key, "restored-" + kind);
                var readAgain = open(viewer, key, "read-restored-" + kind);
                try {
                    assertNotSame(original, rooms.get(key));
                    assertEquals(canonical, rooms.get(key).state().canonicalHash());
                    // Retrying restoration must preserve the current room, revision and recent-edit timestamp.
                    CollabRoom active = rooms.get(key);
                    jdbc.update("UPDATE document SET updated_at='2000-01-01 00:00:00' WHERE doc_key=?", key);
                    assertEquals(restored, body(call("POST", restorePath(key), owner, null)));
                    assertSame(active, rooms.get(key));
                    assertEquals(revision, store.maxSeq(key));
                    assertEquals(Timestamp.valueOf("2000-01-01 00:00:00"),
                            jdbc.queryForObject("SELECT updated_at FROM document WHERE doc_key=?", Timestamp.class, key));

                    Op continued = Op.state("after-restore", "doc".equals(kind) ? ElementType.TEXT : ElementType.CARD,
                            Map.of("text", "恢复后继续协作", "column", "column-1", "order", 4096),
                            "continued-" + kind, new LamportClock("restored-" + kind, 200));
                    reopened.send(frame(continued));
                    JsonNode acknowledged = reopened.nextOfType("applied", 5);
                    assertEquals(revision + 1, acknowledged.path("rev").asLong());
                    assertEquals("恢复后继续协作", readAgain.nextOfType("applied", 5).at("/op/value/text").asText());
                    assertTrue(jdbc.queryForObject("SELECT updated_at FROM document WHERE doc_key=?", Timestamp.class, key)
                            .after(Timestamp.valueOf("2000-01-01 00:00:00")));
                    assertThrows(CollabRoom.OperationRejected.class, () -> original.applyOp(continued));

                    // The existing history restore route remains distinct and functional after trash recovery.
                    assertEquals(200, call("POST", "/api/docs/" + key + "/restore", owner, Map.of("rev", revision)).statusCode());
                    assertTrue(active.state().element("after-restore").isTombstone());
                    assertEquals("回收站内容-" + kind, documents.get(key).get("title"));
                    assertArrayEquals(png(), bytes("GET", asset.path("url").asText(), viewer, null, null).body());
                } finally {
                    reopened.close();
                    readAgain.close();
                }
            } finally {
                writer.close();
                reader.close();
            }
        }
    }

    @Test
    void trashListsOnlyTheRequestedSpaceAndRestoresToItsOriginalSpace() throws Exception {
        Account owner = account("trash-spaces");
        long firstSpace = body(call("POST", "/api/spaces", owner, Map.of("name", "第一个空间"))).path("spaceId").asLong();
        long secondSpace = body(call("POST", "/api/spaces", owner, Map.of("name", "第二个空间"))).path("spaceId").asLong();
        String first = create(owner, "doc", firstSpace), second = create(owner, "kanban", secondSpace);
        for (String key : List.of(first, second)) assertEquals(200, call("DELETE", "/api/docs/" + key, owner, null).statusCode());
        JsonNode firstTrash = body(call("GET", "/api/spaces/" + firstSpace + "/trash", owner, null)).path("documents");
        JsonNode secondTrash = body(call("GET", "/api/spaces/" + secondSpace + "/trash", owner, null)).path("documents");
        assertEquals(1, firstTrash.size());
        assertEquals(first, firstTrash.get(0).path("doc_key").asText());
        assertEquals(1, secondTrash.size());
        assertEquals(second, secondTrash.get(0).path("doc_key").asText());
        assertEquals(firstSpace, body(call("POST", restorePath(first), owner, null)).path("spaceId").asLong());
        assertEquals(firstSpace, spaceOf(first));
        assertEquals(0, body(call("GET", "/api/spaces/" + firstSpace + "/trash", owner, null)).path("documents").size());
        assertEquals(1, body(call("GET", "/api/spaces/" + secondSpace + "/trash", owner, null)).path("documents").size());
        assertEquals(1, body(call("GET", "/api/docs?spaceId=" + firstSpace, owner, null)).size());
        assertEquals(0, body(call("GET", "/api/docs?spaceId=" + secondSpace, owner, null)).size());
    }

    private Account account(String prefix) throws Exception {
        String username = prefix + "-" + UUID.randomUUID().toString().substring(0, 7);
        JsonNode response = body(call("POST", "/api/auth/register", null,
                Map.of("username", username, "password", "test-pass-123")));
        return new Account(response.at("/user/id").asLong(), username, response.path("token").asText());
    }

    private String create(Account owner, String kind, Long spaceId) throws Exception {
        Map<String, Object> request = new LinkedHashMap<>(Map.of("kind", kind, "title", "回收站内容-" + kind));
        if (spaceId != null) request.put("spaceId", spaceId.toString());
        return body(call("POST", "/api/docs", owner, request)).path("docKey").asText();
    }

    private long spaceOf(String key) {
        return ((Number) documents.get(key).get("space_id")).longValue();
    }

    private long count(String table, String key) {
        if (!List.of("operation_log", "element_snapshot", "image_asset").contains(table)) throw new IllegalArgumentException(table);
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE doc_id=?", Long.class, key);
    }

    private String restorePath(String key) {
        return "/api/docs/" + key + "/restore-deleted";
    }

    private JsonNode body(HttpResponse<String> response) throws Exception {
        assertEquals(200, response.statusCode(), response.body());
        return json.readTree(response.body());
    }

    private HttpResponse<String> call(String method, String path, Account account, Object payload) throws Exception {
        HttpRequest.Builder request = request(method, path, account,
                payload == null ? null : json.writeValueAsBytes(payload), payload == null ? null : "application/json");
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<byte[]> bytes(String method, String path, Account account, byte[] payload, String mime) throws Exception {
        return http.send(request(method, path, account, payload, mime).build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private HttpRequest.Builder request(String method, String path, Account account, byte[] payload, String mime) {
        var request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).timeout(Duration.ofSeconds(15))
                .method(method, payload == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(payload));
        if (account != null) request.header("Authorization", "Bearer " + account.token());
        if (mime != null) request.header("Content-Type", mime);
        return request;
    }

    private JsonNode upload(String key, Account owner) throws Exception {
        String boundary = "trash-image-boundary";
        ByteArrayOutputStream payload = new ByteArrayOutputStream();
        payload.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"trash.png\"\r\n"
                + "Content-Type: image/png\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        payload.write(png());
        payload.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        var response = bytes("POST", "/api/docs/" + key + "/images", owner, payload.toByteArray(), "multipart/form-data; boundary=" + boundary);
        assertEquals(200, response.statusCode(), new String(response.body(), StandardCharsets.UTF_8));
        return json.readTree(response.body());
    }

    private static byte[] png() throws Exception {
        BufferedImage picture = new BufferedImage(24, 16, BufferedImage.TYPE_INT_RGB);
        picture.setRGB(4, 4, 0x4263eb);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(picture, "png", bytes);
        return bytes.toByteArray();
    }

    private List<Op> content(String kind, JsonNode asset, String clientId) {
        String assetId = asset.path("assetId").asText(), assetUrl = asset.path("url").asText();
        if ("kanban".equals(kind)) return List.of(
                Op.state("column-1", ElementType.COLUMN, Map.of("title", "待讨论", "order", 1024),
                        clientId + "-column", new LamportClock(clientId, 100)),
                Op.state("original-text", ElementType.CARD, Map.of("text", "恢复前的看板任务", "column", "column-1", "order", 1024,
                                "coverId", assetId, "coverUrl", assetUrl, "coverName", "恢复前封面"),
                        clientId + "-card", new LamportClock(clientId, 101)));
        return List.of(
                Op.state("original-text", "doc".equals(kind) ? ElementType.TEXT : ElementType.CARD,
                        Map.of("text", "恢复前的正文和便签", "order", 1024, "x", 60, "y", 80),
                        clientId + "-text", new LamportClock(clientId, 100)),
                Op.state("original-image", ElementType.IMAGE,
                        Map.of("assetId", assetId, "url", assetUrl, "name", "恢复前的图片", "mimeType", "image/png",
                                "width", 24, "height", 16, "order", 2048, "x", 300, "y", 80),
                        clientId + "-image", new LamportClock(clientId, 101)));
    }

    private String frame(Op operation) throws Exception {
        return json.writeValueAsString(Map.of("type", "op", "op", CollabMessage.opToJson(operation)));
    }

    private CollabWsIntegrationTest.TestClient open(Account member, String key, String clientId) throws Exception {
        var client = new CollabWsIntegrationTest.TestClient();
        client.tokenParam = member.token();
        client.connect(URI.create("ws://localhost:" + port + "/ws/collab"));
        client.send(json.writeValueAsString(Map.of("type", "hello", "docId", key, "clientId", clientId, "lastRev", 0)));
        client.nextOfType("welcome", 5);
        return client;
    }
}
