package com.bishe.server.ws;

import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.auth.AuthService;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.OpStore;
import com.bishe.server.store.SpaceRepo;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CollabRealtimeHardeningTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void validatesHelloOperationAndHeartbeatBoundaries() throws Exception {
        assertProtocol("INVALID_HELLO", """
                {"type":"hello","docId":"doc","clientId":"client","lastRev":-1}
                """, true, "client");
        assertProtocol("INVALID_HELLO", """
                {"type":"hello","docId":"doc","clientId":"client id","lastRev":0}
                """, true, "client id");
        assertProtocol("INVALID_CLOCK", operation("other:1", "value"), false, "client");
        assertProtocol("INVALID_CLOCK", operation("client:0", "value"), false, "client");
        assertProtocol("INVALID_OP", """
                {"type":"op","op":{"type":"PUT","elementId":"x","elementType":"TEXT",
                 "field":"text","value":{"nested":true},"clock":"client:1"}}
                """, false, "client");

        ObjectNode ping = (ObjectNode) MAPPER.readTree("{\"type\":\"ping\",\"ts\":12,\"nonce\":\"n-1\"}");
        JsonNode pong = MAPPER.readTree(CollabMessage.pong(ping));
        assertEquals("pong", pong.path("type").asText());
        assertEquals(12, pong.path("ts").asLong());
        assertEquals("n-1", pong.path("nonce").asText());
    }

    @Test
    void duplicateClockIsIdempotentAndConflictingOrOutOfOrderClockIsRejected() throws Exception {
        OpStore store = emptyStore();
        CollabRoom room = new CollabRoom("doc", store);
        List<String> frames = new CopyOnWriteArrayList<>();
        CollabSession session = new CollabSession("client", "host", recordingSocket(frames),
                7, "Alice", "editor");
        room.joinAndSync(session, 0);

        long before = room.currentRev();
        Op first = Op.put("card", ElementType.CARD, "text", "v1", new LamportClock("client", 1));
        CollabRoom.ApplyResult applied = room.applyClientOp(first, "op-1", session);
        assertEquals(CollabRoom.ApplyStatus.APPLIED, applied.status());
        assertEquals(before + 1, room.currentRev());
        verify(store).appendBatch(eq("doc"), org.mockito.ArgumentMatchers.argThat(entries ->
                entries.size() == 1
                        && entries.get(0).op() == first
                        && "op-1".equals(entries.get(0).operationId())
                        && Long.valueOf(7).equals(entries.get(0).actorId())
                        && entries.get(0).seq() == before + 1));

        CollabRoom.ApplyResult duplicate = room.applyClientOp(first, "op-1", session);
        assertEquals(CollabRoom.ApplyStatus.DUPLICATE, duplicate.status());
        assertEquals(applied.rev(), duplicate.rev());
        assertEquals(before + 1, room.currentRev());

        CollabRoom.OperationRejected conflict = assertThrows(CollabRoom.OperationRejected.class,
                () -> room.applyClientOp(Op.put("card", ElementType.CARD, "text", "changed",
                        new LamportClock("client", 1)), "op-2", session));
        assertEquals("CLOCK_CONFLICT", conflict.code());

        room.applyClientOp(Op.put("card", ElementType.CARD, "text", "v3",
                new LamportClock("client", 3)), "op-3", session);
        CollabRoom.OperationRejected backwards = assertThrows(CollabRoom.OperationRejected.class,
                () -> room.applyClientOp(Op.add("late", ElementType.TEXT,
                        new LamportClock("client", 2)), "op-4", session));
        assertEquals("CLOCK_OUT_OF_ORDER", backwards.code());
        verify(store, times(3)).appendBatch(eq("doc"), any());

        JsonNode welcome = awaitType(frames, "welcome");
        assertEquals("Alice", welcome.path("displayName").asText());
        assertTrue(welcome.path("canWrite").asBoolean());
        JsonNode presence = awaitType(frames, "presence");
        assertEquals("Alice", presence.at("/members/0/displayName").asText());
    }

    @Test
    void restoresReplicaCounterAndRejectsAReusedLowerClockAfterReconnect() {
        OpStore store = mock(OpStore.class);
        Op historical = Op.add("existing", ElementType.TEXT, new LamportClock("client", 100));
        when(store.latestSnapshot("doc")).thenReturn(new OpStore.Snapshot("doc", 0, null, false));
        when(store.loadOpsAfterWithSeq("doc", 0))
                .thenReturn(List.of(new OpStore.LoadOp(1, historical, historical.clock().toString())));
        when(store.maxSeq("doc")).thenReturn(1L);
        CollabRoom room = new CollabRoom("doc", store);
        CollabSession reconnected = new CollabSession("client", "host", recordingSocket(new ArrayList<>()),
                7, "Alice", "editor");
        room.joinAndSync(reconnected, 0);

        CollabRoom.OperationRejected rejected = assertThrows(CollabRoom.OperationRejected.class,
                () -> room.applyClientOp(Op.add("new", ElementType.TEXT,
                        new LamportClock("client", 3)), null, reconnected));
        assertEquals("CLOCK_OUT_OF_ORDER", rejected.code());
    }

    @Test
    void appendFailureDoesNotMutateRevisionOrMemoryState() {
        OpStore store = emptyStore();
        doAnswer(invocation -> {
            @SuppressWarnings("unchecked")
            List<OpStore.AppendEntry> entries = invocation.getArgument(1);
            if (entries.stream().anyMatch(entry -> "failed".equals(entry.op().elementId()))) {
                throw new IllegalStateException("database unavailable");
            }
            return null;
        }).when(store).appendBatch(anyString(), any());
        CollabRoom room = new CollabRoom("doc", store);
        long before = room.currentRev();

        assertThrows(IllegalStateException.class,
                () -> room.applyOp(Op.add("failed", ElementType.CARD,
                        new LamportClock("writer", 1))));
        assertEquals(before, room.currentRev());
        assertNull(room.state().element("failed"));
    }

    @Test
    void joinSyncAndRegistrationAreAtomicWithConcurrentApply() throws Exception {
        OpStore store = emptyStore();
        CollabRoom room = new CollabRoom("doc", store);
        List<String> order = new CopyOnWriteArrayList<>();
        CountDownLatch welcomeEntered = new CountDownLatch(1);
        CountDownLatch releaseWelcome = new CountDownLatch(1);
        WebSocketSession socket = mock(WebSocketSession.class);
        when(socket.isOpen()).thenReturn(true);
        doAnswer(invocation -> {
            String payload = ((TextMessage) invocation.getArgument(0)).getPayload();
            order.add(read(payload).path("type").asText());
            if (payload.contains("\"type\":\"welcome\"")) {
                welcomeEntered.countDown();
                assertTrue(releaseWelcome.await(5, TimeUnit.SECONDS));
            }
            return null;
        }).when(socket).sendMessage(any(TextMessage.class));
        CollabSession session = new CollabSession("client", "host", socket, 7, "Alice", "editor");

        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<?> joining = executor.submit(() -> room.joinAndSync(session, 0));
            assertTrue(welcomeEntered.await(5, TimeUnit.SECONDS));
            Future<?> applying = executor.submit(() -> room.applyOp(Op.put("atomic", ElementType.TEXT,
                    "text", "after", new LamportClock("writer", 1))));
            applying.get(5, TimeUnit.SECONDS);

            releaseWelcome.countDown();
            joining.get(5, TimeUnit.SECONDS);
            awaitType(order, "applied");
            assertTrue(order.indexOf("welcome") < order.indexOf("applied"));
        } finally {
            releaseWelcome.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void lastRevisionBeyondServerFallsBackToWelcomeAndValidCursorGetsDelta() {
        OpStore store = emptyStore();
        CollabRoom room = new CollabRoom("doc", store);
        long cursor = room.currentRev();
        room.applyOp(Op.put("delta", ElementType.TEXT, "text", "v",
                new LamportClock("writer", 1)));

        List<String> futureFrames = new CopyOnWriteArrayList<>();
        room.joinAndSync(new CollabSession("future", "host", recordingSocket(futureFrames),
                7, "Future", "editor"), room.currentRev() + 100);
        assertEquals("welcome", awaitType(futureFrames, "welcome").path("type").asText());

        List<String> deltaFrames = new CopyOnWriteArrayList<>();
        room.joinAndSync(new CollabSession("resume", "host", recordingSocket(deltaFrames),
                7, "Resume", "editor"), cursor);
        JsonNode incremental = awaitType(deltaFrames, "incremental");
        assertEquals("incremental", incremental.path("type").asText());
        assertEquals(room.currentRev(), incremental.path("toRev").asLong());
        assertEquals(room.currentRev(), incremental.path("rev").asLong());
        assertEquals(1, incremental.path("ops").size());
    }

    @Test
    void handlerRequiresPersistedDocumentAndRechecksRoleForEveryOperation() throws Exception {
        OpStore store = mock(OpStore.class);
        DocRepo docs = mock(DocRepo.class);
        SpaceRepo spaces = mock(SpaceRepo.class);
        RoomRegistry registry = mock(RoomRegistry.class);
        CollabRoom room = mock(CollabRoom.class);
        CollabSocketHandler handler = new CollabSocketHandler(store, docs, spaces, registry);

        List<String> missingFrames = new CopyOnWriteArrayList<>();
        WebSocketSession missing = authenticatedSocket(missingFrames);
        when(docs.spaceIdOf("missing")).thenReturn(-1L);
        handler.handleTextMessage(missing, new TextMessage(hello("missing", "client", 0)));
        assertEquals("DOCUMENT_NOT_FOUND", awaitType(missingFrames, "error").path("code").asText());
        verify(registry, never()).roomFor(eq("missing"), any(OpStore.class));

        List<String> frames = new CopyOnWriteArrayList<>();
        WebSocketSession socket = authenticatedSocket(frames);
        when(docs.spaceIdOf("real-doc")).thenReturn(9L);
        java.util.concurrent.atomic.AtomicReference<String> currentRole =
                new java.util.concurrent.atomic.AtomicReference<>("editor");
        when(spaces.roleOf(9L, 7L)).thenAnswer(invocation -> currentRole.get());
        when(room.docId()).thenReturn("real-doc");
        when(registry.roomFor("real-doc", store)).thenReturn(room);
        handler.handleTextMessage(socket, new TextMessage(hello("real-doc", "client", 0)));
        verify(room).joinAndSync(any(CollabSession.class), eq(0L), any());

        currentRole.set("viewer");
        handler.handleTextMessage(socket, new TextMessage(operation("client:1", "v1")));
        assertEquals("READ_ONLY", awaitType(frames, "error").path("code").asText());
        verify(room, never()).applyClientOp(any(Op.class), any(), any(CollabSession.class));

        frames.clear();
        currentRole.set(null);
        handler.handleTextMessage(socket, new TextMessage(operation("client:2", "v2")));
        assertEquals("MEMBERSHIP_REVOKED", awaitType(frames, "error").path("code").asText());
        verify(room).leave(any(CollabSession.class));
    }

    @Test
    void handlerRepliesToApplicationPingBeforeJoin() throws Exception {
        CollabSocketHandler handler = new CollabSocketHandler(mock(OpStore.class), mock(DocRepo.class),
                mock(SpaceRepo.class), mock(RoomRegistry.class));
        List<String> frames = new CopyOnWriteArrayList<>();
        WebSocketSession socket = recordingSocket(frames);
        handler.handleTextMessage(socket,
                new TextMessage("{\"type\":\"ping\",\"ts\":123,\"nonce\":\"probe\"}"));
        JsonNode pong = awaitType(frames, "pong");
        assertEquals(123, pong.path("ts").asLong());
        assertEquals("probe", pong.path("nonce").asText());
    }

    private static OpStore emptyStore() {
        OpStore store = mock(OpStore.class);
        when(store.latestSnapshot(anyString())).thenAnswer(invocation ->
                new OpStore.Snapshot(invocation.getArgument(0), 0, null, false));
        when(store.loadOpsAfterWithSeq(anyString(), eq(0L))).thenReturn(List.of());
        when(store.maxSeq(anyString())).thenReturn(0L);
        return store;
    }

    private static WebSocketSession recordingSocket(List<String> frames) {
        WebSocketSession socket = mock(WebSocketSession.class);
        when(socket.isOpen()).thenReturn(true);
        when(socket.getId()).thenReturn("socket-1");
        when(socket.getAttributes()).thenReturn(new HashMap<>());
        try {
            doAnswer(invocation -> {
                frames.add(((TextMessage) invocation.getArgument(0)).getPayload());
                return null;
            }).when(socket).sendMessage(any(TextMessage.class));
        } catch (java.io.IOException e) {
            throw new AssertionError(e);
        }
        return socket;
    }

    private static WebSocketSession authenticatedSocket(List<String> frames) {
        WebSocketSession socket = recordingSocket(frames);
        socket.getAttributes().put(TokenHandshakeInterceptor.ATTR_USER,
                new AuthService.UserPub(7, "alice", "Alice", "editor"));
        return socket;
    }

    private static void assertProtocol(String expectedCode, String json, boolean hello, String clientId)
            throws Exception {
        ObjectNode frame = (ObjectNode) MAPPER.readTree(json);
        CollabMessage.ProtocolException exception = assertThrows(CollabMessage.ProtocolException.class,
                () -> {
                    if (hello) {
                        CollabMessage.parseJoin(frame);
                    } else {
                        CollabMessage.parseOperation(frame, clientId);
                    }
                });
        assertEquals(expectedCode, exception.code());
    }

    private static String hello(String docId, String clientId, long lastRev) {
        return "{\"type\":\"hello\",\"docId\":\"" + docId + "\",\"clientId\":\""
                + clientId + "\",\"hostname\":\"test\",\"lastRev\":" + lastRev + "}";
    }

    private static String operation(String clock, String value) {
        return "{\"type\":\"op\",\"op\":{\"type\":\"PUT\",\"elementId\":\"item\","
                + "\"elementType\":\"TEXT\",\"field\":\"text\",\"value\":\"" + value
                + "\",\"clock\":\"" + clock + "\"}}";
    }

    private static JsonNode awaitType(List<String> frames, String type) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            for (int i = frames.size() - 1; i >= 0; i--) {
                JsonNode frame;
                String value = frames.get(i);
                if (value.startsWith("{")) {
                    frame = read(value);
                    if (type.equals(frame.path("type").asText())) {
                        return frame;
                    }
                } else if (type.equals(value)) {
                    return MAPPER.createObjectNode().put("type", value);
                }
            }
            try {
                Thread.sleep(5);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError(e);
            }
        }
        throw new AssertionError("No frame of type " + type + ": " + frames);
    }

    private static JsonNode read(String json) {
        try {
            return MAPPER.readTree(json);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
