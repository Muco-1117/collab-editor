package com.bishe.server.ws;

import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.auth.AccessService;
import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.CurrentUser;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.OpStore;
import com.bishe.server.store.SpaceRepo;
import com.bishe.server.web.DocController;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class LiveMetadataTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @ParameterizedTest
    @ValueSource(strings = {"doc", "board", "kanban"})
    void successfulRestRenameBroadcastsAuthorityAndReconnectIncludesItWithoutRedundantLogs(String kind) throws Exception {
        OpStore store = emptyStore();
        DocRepo docs = mock(DocRepo.class);
        AtomicReference<String> persistedTitle = new AtomicReference<>("原始标题");
        when(docs.get("content")).thenAnswer(ignored -> metadata(kind, persistedTitle.get()));
        when(docs.spaceIdOf("content")).thenReturn(9L);
        when(docs.updateTitle(eq("content"), anyString())).thenAnswer(invocation -> {
            persistedTitle.set(invocation.getArgument(1));
            return true;
        });
        RoomRegistry registry = new RoomRegistry(docs);
        try {
            CollabRoom room = registry.roomFor("content", kind, "过期调用方标题", store);
            List<String> frames = new CopyOnWriteArrayList<>();
            CollabSession session = member("client", frames);
            room.joinAndSync(session, 0);
            JsonNode welcome = awaitFrame(frames, frame -> "welcome".equals(frame.path("type").asText()));
            assertMetadata(welcome, kind, "原始标题");
            long before = room.currentRev();
            clearInvocations(store);
            DocController controller = controller(docs, registry, "editor");

            assertEquals(200, controller.update("content", Map.of("title", "团队最新标题")).getStatusCode().value());
            JsonNode changed = awaitFrame(frames, frame -> "metadata".equals(frame.path("type").asText()));
            assertMetadata(changed, kind, "团队最新标题");
            assertEquals("团队最新标题", persistedTitle.get());
            assertEquals("团队最新标题", room.metadataTitle());
            if ("doc".equals(kind)) {
                assertEquals(before + 1, room.currentRev());
                assertEquals("团队最新标题", room.currentTitle());
                verify(store, times(1)).appendBatch(eq("content"), any());
            } else {
                assertEquals(before, room.currentRev());
                assertEquals(0, room.state().size());
                verify(store, never()).appendBatch(anyString(), any());
            }
            assertEquals(200, controller.update("content", Map.of("title", "团队最新标题")).getStatusCode().value());
            if (!"doc".equals(kind)) {
                room.applyOp(Op.add("revision-for-resume", ElementType.CARD, new LamportClock("server-seed", 1)));
            }
            List<String> resumedFrames = new CopyOnWriteArrayList<>();
            room.joinAndSync(member("resumed", resumedFrames), room.currentRev());
            JsonNode incremental = awaitFrame(resumedFrames, frame -> "incremental".equals(frame.path("type").asText()));
            assertMetadata(incremental, kind, "团队最新标题");
            // This barrier is enqueued after both rename calls on the same session.
            session.send("{\"type\":\"test-barrier\"}");
            awaitFrame(frames, frame -> "test-barrier".equals(frame.path("type").asText()));
            assertEquals(1, frames.stream().map(LiveMetadataTest::read)
                    .filter(frame -> "metadata".equals(frame.path("type").asText())).count());
        } finally {
            registry.shutdown();
        }
    }

    @Test
    void rejectedRestRenamesDoNotChangeOrBroadcastMetadata() throws Exception {
        DocRepo docs = mock(DocRepo.class);
        when(docs.get("content")).thenReturn(metadata("board", "保留标题"));
        when(docs.spaceIdOf("content")).thenReturn(9L);
        RoomRegistry registry = new RoomRegistry(docs);
        try {
            CollabRoom room = registry.roomFor("content", "board", "保留标题", emptyStore());
            List<String> frames = new CopyOnWriteArrayList<>();
            CollabSession session = member("client", frames);
            room.joinAndSync(session, 0);
            var controller = controller(docs, registry, "editor");
            assertEquals(400, controller.update("content", Map.of("title", " ")).getStatusCode().value());
            assertEquals(400, controller.update("content", Map.of("title", "x".repeat(257))).getStatusCode().value());
            assertEquals(400, controller.update("content", Map.of("title", "a\u0001b")).getStatusCode().value());
            assertEquals(403, controller(docs, registry, "viewer").update("content", Map.of("title", "无权改名")).getStatusCode().value());
            verify(docs, never()).updateTitle(anyString(), anyString());
            when(docs.updateTitle("content", "同时被删")).thenReturn(false);
            assertEquals(404, controller.update("content", Map.of("title", "同时被删")).getStatusCode().value());
            session.send("{\"type\":\"test-barrier\"}");
            awaitFrame(frames, frame -> "test-barrier".equals(frame.path("type").asText()));
            assertEquals("保留标题", room.metadataTitle());
            assertFalse(frames.stream().map(LiveMetadataTest::read)
                    .anyMatch(frame -> "metadata".equals(frame.path("type").asText())));
        } finally {
            registry.shutdown();
        }
    }

    @Test
    void renameWaitsForFirstRoomCreationAndCannotLeaveItsStaleTitleBehind() throws Exception {
        DocRepo docs = mock(DocRepo.class);
        AtomicReference<String> persisted = new AtomicReference<>("先读旧标题");
        CountDownLatch creationReading = new CountDownLatch(1);
        CountDownLatch releaseCreation = new CountDownLatch(1);
        when(docs.get("content")).thenAnswer(ignored -> {
            String oldTitle = persisted.get();
            creationReading.countDown();
            assertTrue(releaseCreation.await(5, TimeUnit.SECONDS));
            return metadata("board", oldTitle);
        });
        RoomRegistry registry = new RoomRegistry(docs);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var creating = executor.submit(() -> registry.roomFor("content", "board", "旧请求参数", emptyStore()));
            assertTrue(creationReading.await(5, TimeUnit.SECONDS));
            var renaming = executor.submit(() -> registry.renameDocument("content", "最新标题", () -> {
                persisted.set("最新标题");
                return true;
            }));
            assertThrows(TimeoutException.class, () -> renaming.get(50, TimeUnit.MILLISECONDS));
            releaseCreation.countDown();
            CollabRoom room = creating.get(5, TimeUnit.SECONDS);
            assertTrue(renaming.get(5, TimeUnit.SECONDS));
            assertEquals("最新标题", room.metadataTitle());
            List<String> frames = new CopyOnWriteArrayList<>();
            room.joinAndSync(member("joining", frames), 0);
            assertMetadata(awaitFrame(frames, frame -> "welcome".equals(frame.path("type").asText())), "board", "最新标题");
        } finally {
            releaseCreation.countDown();
            executor.shutdownNow();
            registry.shutdown();
        }
    }

    @Test
    void newRoomRechecksAuthorityAfterRenameCompletedWithoutAnOpenRoom() {
        DocRepo docs = mock(DocRepo.class);
        AtomicReference<String> persisted = new AtomicReference<>("原来标题");
        when(docs.get("content")).thenAnswer(ignored -> metadata("board", persisted.get()));
        RoomRegistry registry = new RoomRegistry(docs);
        try {
            assertTrue(registry.renameDocument("content", "已提交标题", () -> {
                persisted.set("已提交标题");
                return true;
            }));
            CollabRoom room = registry.roomFor("content", "doc", "调用者旧标题", emptyStore());
            assertEquals("board", room.kind());
            assertEquals("已提交标题", room.metadataTitle());
            assertEquals(0, room.currentRev());
        } finally {
            registry.shutdown();
        }
    }

    @Test
    void historyTitleProjectionRepairPreservesLatestMetadata() {
        CollabRoom room = new CollabRoom("content", "doc", "最初标题", emptyStore());
        try {
            room.synchronizeTitle("重命名后的标题");
            room.applyExternal(List.of(Op.put(CollabRoom.ROOT_ID, ElementType.DOC, "title", "历史旧标题",
                    new LamportClock("server-restore", 100))));
            assertEquals("历史旧标题", room.currentTitle());
            room.synchronizeTitleProjection();
            assertEquals("重命名后的标题", room.currentTitle());
            assertEquals("重命名后的标题", room.metadataTitle());
        } finally {
            room.closeNow();
        }
    }

    @Test
    void websocketCannotBypassRestBySubmittingTitleOrMetadataFrames() throws Exception {
        OpStore store = emptyStore();
        DocRepo docs = mock(DocRepo.class);
        SpaceRepo spaces = mock(SpaceRepo.class);
        RoomRegistry registry = mock(RoomRegistry.class);
        CollabRoom room = new CollabRoom("content", "doc", "原标题", store);
        when(docs.spaceIdOf("content")).thenReturn(9L);
        when(spaces.roleOf(9, 7)).thenReturn("editor");
        when(registry.roomFor("content", store)).thenReturn(room);
        CollabSocketHandler handler = new CollabSocketHandler(store, docs, spaces, registry);
        List<String> frames = new CopyOnWriteArrayList<>();
        WebSocketSession socket = socket(frames);
        socket.getAttributes().put(TokenHandshakeInterceptor.ATTR_USER,
                new AuthService.UserPub(7, "alice", "Alice", "editor"));
        try {
            handler.handleTextMessage(socket, new TextMessage("""
                    {"type":"hello","docId":"content","clientId":"client","lastRev":0}
                    """));
            long revision = room.currentRev();
            handler.handleTextMessage(socket, new TextMessage("""
                    {"type":"op","op":{"type":"PUT","elementId":"doc-root","elementType":"DOC",
                    "field":"title","value":"绕过REST","clock":"client:20"}}
                    """));
            assertEquals("INVALID_OP", awaitFrame(frames, frame -> "error".equals(frame.path("type").asText())).path("code").asText());
            handler.handleTextMessage(socket, new TextMessage("""
                    {"type":"metadata","docId":"content","kind":"doc","title":"伪造元数据"}
                    """));
            awaitFrame(frames, frame -> "UNKNOWN_TYPE".equals(frame.path("code").asText()));
            assertEquals("原标题", room.currentTitle());
            assertEquals("原标题", room.metadataTitle());
            assertEquals(revision, room.currentRev());
            verify(docs, never()).updateTitle(anyString(), anyString());
        } finally {
            room.closeNow();
        }
    }

    private static Map<String, Object> metadata(String kind, String title) {
        return Map.of("doc_key", "content", "kind", kind, "title", title, "space_id", 9L);
    }

    private static DocController controller(DocRepo docs, RoomRegistry registry, String role) {
        CurrentUser current = mock(CurrentUser.class);
        AccessService access = mock(AccessService.class);
        AuthService.UserPub user = new AuthService.UserPub(7, "alice", "Alice", "editor");
        when(current.get()).thenReturn(user);
        when(access.document("content", user)).thenReturn(new AccessService.DocumentAccess(9, role));
        return new DocController(docs, mock(SpaceRepo.class), access, current, registry);
    }

    private static OpStore emptyStore() {
        OpStore store = mock(OpStore.class);
        when(store.latestSnapshot(anyString())).thenAnswer(invocation ->
                new OpStore.Snapshot(invocation.getArgument(0), 0, null, false));
        when(store.loadOpsAfterWithSeq(anyString(), eq(0L))).thenReturn(List.of());
        return store;
    }

    private static CollabSession member(String id, List<String> frames) throws Exception {
        return new CollabSession(id, "test", socket(frames), 7, "Alice", "editor");
    }

    private static WebSocketSession socket(List<String> frames) throws Exception {
        WebSocketSession socket = mock(WebSocketSession.class);
        AtomicBoolean open = new AtomicBoolean(true);
        when(socket.isOpen()).thenAnswer(ignored -> open.get());
        when(socket.getAttributes()).thenReturn(new HashMap<>());
        doAnswer(invocation -> {
            frames.add(((TextMessage) invocation.getArgument(0)).getPayload());
            return null;
        }).when(socket).sendMessage(any(TextMessage.class));
        doAnswer(ignored -> { open.set(false); return null; }).when(socket).close(any(CloseStatus.class));
        return socket;
    }

    private static JsonNode read(String value) {
        try {
            return JSON.readTree(value);
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private static JsonNode awaitFrame(List<String> frames, Predicate<JsonNode> matches) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            for (int i = frames.size() - 1; i >= 0; i--) {
                JsonNode frame = read(frames.get(i));
                if (matches.test(frame)) return frame;
            }
            Thread.sleep(2);
        }
        throw new AssertionError("Expected frame missing: " + frames);
    }

    private static void assertMetadata(JsonNode frame, String kind, String title) {
        assertEquals("content", frame.path("docId").asText());
        assertEquals(kind, frame.path("kind").asText());
        assertEquals(title, frame.path("title").asText());
    }
}
