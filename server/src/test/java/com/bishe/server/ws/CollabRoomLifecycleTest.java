package com.bishe.server.ws;

import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.OpStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/** Tests room invalidation without opening a Spring context or a database. */
class CollabRoomLifecycleTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void deletingOpenDocumentClosesEverySessionAndPreventsReopeningFromStaleMetadata() throws Exception {
        OpStore store = emptyStore();
        DocRepo docs = mock(DocRepo.class);
        AtomicBoolean deleted = new AtomicBoolean();
        when(docs.spaceIdOf("board")).thenAnswer(ignored -> deleted.get() ? -1L : 9L);
        when(docs.get("board")).thenAnswer(ignored -> deleted.get() ? null
                : Map.of("kind", "board", "title", "项目白板", "space_id", 9L));
        RoomRegistry registry = new RoomRegistry(docs);
        try {
            CollabRoom room = registry.roomFor("board", "board", "项目白板", store);
            List<String> editorFrames = new CopyOnWriteArrayList<>();
            List<String> viewerFrames = new CopyOnWriteArrayList<>();
            CountDownLatch closed = new CountDownLatch(2);
            room.joinAndSync(session("editor", "editor", editorFrames, closed), 0);
            room.joinAndSync(session("viewer", "viewer", viewerFrames, closed), 0);

            assertTrue(registry.deleteDocument("board", () -> {
                deleted.set(true);
                return true;
            }));
            assertTrue(closed.await(5, TimeUnit.SECONDS));
            assertNull(registry.get("board"));
            assertEquals(0, room.occupantCount());
            for (List<String> frames : List.of(editorFrames, viewerFrames)) {
                JsonNode error = frames.stream().map(CollabRoomLifecycleTest::read)
                        .filter(frame -> "error".equals(frame.path("type").asText())).findFirst().orElseThrow();
                assertEquals("DOCUMENT_DELETED", error.path("code").asText());
                assertTrue(error.path("fatal").asBoolean());
            }
            var rejection = assertThrows(CollabRoom.JoinRejected.class,
                    () -> registry.roomFor("board", "board", "旧元数据", store));
            assertEquals("DOCUMENT_NOT_FOUND", rejection.code());
            verify(store, never()).appendBatch(anyString(), any());
        } finally {
            registry.shutdown();
        }
    }

    @Test
    void deletionRejectsQueuedWritesBeforeWriterRunsAndDoesNotLeaveCallersHanging() throws Exception {
        OpStore store = emptyStore();
        ScheduledThreadPoolExecutor writer = new ScheduledThreadPoolExecutor(1);
        CollabRoom room = new CollabRoom("board", "board", "白板", store, writer);
        ExecutorService callers = Executors.newSingleThreadExecutor();
        CountDownLatch writerBlocked = new CountDownLatch(1);
        CountDownLatch releaseWriter = new CountDownLatch(1);
        writer.execute(() -> {
            writerBlocked.countDown();
            await(releaseWriter);
        });
        try {
            assertTrue(writerBlocked.await(5, TimeUnit.SECONDS));
            var pending = callers.submit(() -> room.applyOp(Op.add("queued", ElementType.CARD,
                    new LamportClock("writer", 1))));
            waitForQueued(room);

            assertTrue(room.deleteIf(() -> true));
            ExecutionException failure = assertThrows(ExecutionException.class,
                    () -> pending.get(5, TimeUnit.SECONDS));
            assertInstanceOf(CollabRoom.OperationRejected.class, failure.getCause());
            assertEquals("DOCUMENT_DELETED", ((CollabRoom.OperationRejected) failure.getCause()).code());
            assertEquals(0, room.queuedWriteCount());
            assertEquals(0, room.currentRev());
            assertNull(room.state().element("queued"));
            assertThrows(CollabRoom.OperationRejected.class, () -> room.applyOp(Op.add("late", ElementType.CARD,
                    new LamportClock("writer", 2))));
            verify(store, never()).appendBatch(anyString(), any());
        } finally {
            releaseWriter.countDown();
            room.closeNow();
            callers.shutdownNow();
            writer.shutdownNow();
        }
    }

    @Test
    void failedMetadataDeletionKeepsTheRoomUsable() {
        OpStore store = emptyStore();
        RoomRegistry registry = new RoomRegistry();
        try {
            CollabRoom room = registry.roomFor("board", "board", "白板", store);
            assertFalse(registry.deleteDocument("board", () -> false));
            assertSame(room, registry.get("board"));
            assertThrows(IllegalStateException.class,
                    () -> registry.deleteDocument("board", () -> { throw new IllegalStateException("database"); }));
            assertSame(room, registry.get("board"));
            assertEquals(CollabRoom.ApplyStatus.APPLIED, room.applyOp(Op.add("still-writable", ElementType.CARD,
                    new LamportClock("writer", 1))).status());
        } finally {
            registry.shutdown();
        }
    }

    @Test
    void restoredDocumentCreatesAFreshWritableRoomAndKeepsOldRoomClosed() throws Exception {
        OpStore store = emptyStore();
        DocRepo docs = mock(DocRepo.class);
        AtomicBoolean deleted = new AtomicBoolean();
        when(docs.get("board")).thenAnswer(ignored -> deleted.get() ? null
                : Map.of("kind", "board", "title", "恢复的白板", "space_id", 9L));
        RoomRegistry registry = new RoomRegistry(docs);
        try {
            CollabRoom original = registry.roomFor("board", "board", "恢复的白板", store);
            assertTrue(registry.deleteDocument("board", () -> { deleted.set(true); return true; }));
            assertNull(registry.get("board"));
            assertThrows(CollabRoom.JoinRejected.class, () -> registry.roomFor("board", store));

            assertTrue(registry.restoreDocument("board", () -> { deleted.set(false); return true; }));
            CollabRoom restored = registry.roomFor("board", "doc", "过期元数据", store);
            assertNotSame(original, restored);
            assertEquals("恢复的白板", restored.metadataTitle());
            CollabSession editor = session("after-restore", "editor", new CopyOnWriteArrayList<>(), new CountDownLatch(1));
            restored.joinAndSync(editor, 0);
            assertEquals(CollabRoom.ApplyStatus.APPLIED, restored.applyClientOp(Op.state("new-card", ElementType.CARD,
                    Map.of("text", "恢复后继续写入"), "after-restore-op", new LamportClock("after-restore", 1)),
                    "after-restore-op", editor).status());
            assertThrows(CollabRoom.OperationRejected.class, () -> original.applyOp(Op.add("stale-card",
                    ElementType.CARD, new LamportClock("stale", 2))));

            assertEquals("already active", registry.restoreDocument("board", () -> "already active"));
            assertSame(restored, registry.get("board"));
            assertEquals(1, restored.occupantCount(), "幂等恢复不能使已经在线的会话掉线");
        } finally {
            registry.shutdown();
        }
    }

    @Test
    void restoreWaitsForInFlightDeletionBeforeAllowingReopen() throws Exception {
        OpStore store = emptyStore();
        DocRepo docs = mock(DocRepo.class);
        AtomicBoolean deleted = new AtomicBoolean();
        when(docs.get("board")).thenAnswer(ignored -> deleted.get() ? null
                : Map.of("kind", "board", "title", "白板"));
        RoomRegistry registry = new RoomRegistry(docs);
        ExecutorService callers = Executors.newFixedThreadPool(2);
        CountDownLatch deleting = new CountDownLatch(1), releaseDelete = new CountDownLatch(1), restoring = new CountDownLatch(1);
        try {
            CollabRoom original = registry.roomFor("board", store);
            var deletion = callers.submit(() -> registry.deleteDocument("board", () -> {
                deleting.countDown();
                await(releaseDelete);
                deleted.set(true);
                return true;
            }));
            assertTrue(deleting.await(5, TimeUnit.SECONDS));
            var restoration = callers.submit(() -> {
                restoring.countDown();
                return registry.restoreDocument("board", () -> {
                    assertTrue(deleted.get(), "恢复必须排在正在执行的删除之后");
                    deleted.set(false);
                    return true;
                });
            });
            assertTrue(restoring.await(5, TimeUnit.SECONDS));
            releaseDelete.countDown();
            assertTrue(deletion.get(5, TimeUnit.SECONDS));
            assertTrue(restoration.get(5, TimeUnit.SECONDS));
            CollabRoom restored = registry.roomFor("board", store);
            assertNotSame(original, restored);
            assertEquals(CollabRoom.ApplyStatus.APPLIED, restored.applyOp(Op.add("next-card", ElementType.CARD,
                    new LamportClock("restored", 1))).status());
        } finally {
            releaseDelete.countDown();
            callers.shutdownNow();
            registry.shutdown();
        }
    }

    @Test
    void roleChangesUpdateEveryTabAndRemovalClosesOnlyThatMember() throws Exception {
        CollabRoom room = new CollabRoom("board", "board", "白板", emptyStore());
        List<String> first = new CopyOnWriteArrayList<>();
        List<String> second = new CopyOnWriteArrayList<>();
        List<String> other = new CopyOnWriteArrayList<>();
        CountDownLatch memberClosed = new CountDownLatch(2);
        CountDownLatch otherClosed = new CountDownLatch(1);
        CollabSession a = session("tab-a", "editor", first, memberClosed);
        CollabSession b = session("tab-b", "editor", second, memberClosed);
        CollabSession owner = session("owner", "owner", other, otherClosed, 99);
        try {
            room.joinAndSync(a, 0);
            room.joinAndSync(b, 0);
            room.joinAndSync(owner, 0);
            room.refreshMemberAccess(7, () -> "viewer");
            assertEquals("viewer", a.role());
            assertFalse(b.canWrite());
            awaitFrame(first, "access");
            awaitFrame(second, "access");
            assertFalse(awaitFrame(first, "access").path("canWrite").asBoolean());
            var readOnly = assertThrows(CollabRoom.OperationRejected.class, () -> room.applyClientOp(
                    Op.add("no-write", ElementType.CARD, new LamportClock("tab-a", 1)), "op-no", a));
            assertEquals("READ_ONLY", readOnly.code());

            room.refreshMemberAccess(7, () -> "editor");
            assertTrue(a.canWrite());
            assertEquals(CollabRoom.ApplyStatus.APPLIED, room.applyClientOp(
                    Op.add("allowed", ElementType.CARD, new LamportClock("tab-a", 1)), "op-yes", a).status());
            room.refreshMemberAccess(7, () -> null);
            assertTrue(memberClosed.await(5, TimeUnit.SECONDS));
            assertEquals(1, room.occupantCount());
            assertEquals(1, otherClosed.getCount());
            assertTrue(owner.isOpen());
            assertEquals("MEMBERSHIP_REVOKED", awaitFrame(first, "error").path("code").asText());
            var removed = assertThrows(CollabRoom.OperationRejected.class, () -> room.applyClientOp(
                    Op.add("removed-write", ElementType.CARD, new LamportClock("tab-a", 2)), "op-late", a));
            assertEquals("MEMBERSHIP_REVOKED", removed.code());
        } finally {
            room.closeNow();
        }
    }

    @Test
    void queuedOperationCannotCommitAfterRoleWasDowngraded() throws Exception {
        ScheduledThreadPoolExecutor writer = new ScheduledThreadPoolExecutor(1);
        CollabRoom room = new CollabRoom("board", "board", "白板", emptyStore(), writer);
        CollabSession member = session("editor", "editor", new CopyOnWriteArrayList<>(), new CountDownLatch(1));
        room.joinAndSync(member, 0);
        var caller = Executors.newSingleThreadExecutor();
        CountDownLatch blocked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        writer.execute(() -> { blocked.countDown(); await(release); });
        try {
            assertTrue(blocked.await(5, TimeUnit.SECONDS));
            var pending = caller.submit(() -> room.applyClientOp(Op.add("queued", ElementType.CARD,
                    new LamportClock("editor", 1)), "pending", member));
            waitForQueued(room);
            room.refreshMemberAccess(7, () -> "viewer");
            release.countDown();
            ExecutionException failure = assertThrows(ExecutionException.class, () -> pending.get(5, TimeUnit.SECONDS));
            assertEquals("READ_ONLY", ((CollabRoom.OperationRejected) failure.getCause()).code());
            assertEquals(0, room.currentRev());
            assertNull(room.state().element("queued"));
        } finally {
            release.countDown();
            room.closeNow();
            caller.shutdownNow();
            writer.shutdownNow();
        }
    }

    @Test
    void joinRevalidatesMembershipBeforeSendingAnyContent() throws Exception {
        CollabRoom room = new CollabRoom("board", "board", "白板", emptyStore());
        List<String> frames = new CopyOnWriteArrayList<>();
        CollabSession member = session("stale-join", "editor", frames, new CountDownLatch(1));
        try {
            var rejected = assertThrows(CollabRoom.JoinRejected.class,
                    () -> room.joinAndSync(member, 0, () -> null));
            assertEquals("MEMBERSHIP_REVOKED", rejected.code());
            assertEquals(0, room.occupantCount());
            assertTrue(frames.isEmpty());
            room.joinAndSync(member, 0, () -> "viewer");
            assertEquals("viewer", awaitFrame(frames, "welcome").path("role").asText());
            assertFalse(member.canWrite());
        } finally {
            room.closeNow();
        }
    }

    @Test
    void welcomeRetainsDeletionClockWhenAnOlderUnacknowledgedStateIsReplayed() throws Exception {
        CollabRoom room = new CollabRoom("board", "board", "白板", emptyStore());
        List<String> frames = new CopyOnWriteArrayList<>();
        CollabSession member = session("offline", "editor", frames, new CountDownLatch(1));
        try {
            room.applyOp(Op.state("removed-card", ElementType.CARD,
                    Map.of("text", "被删除的卡片", "#tombstone", true), "delete", new LamportClock("online", 10)));
            room.joinAndSync(member, 0);
            JsonNode snapshot = awaitFrame(frames, "welcome").path("snapshot");
            assertEquals(1, snapshot.size());
            assertTrue(snapshot.get(0).at("/fields/#tombstone/value").asBoolean());
            assertEquals("online:10", snapshot.get(0).at("/fields/#tombstone/clock").asText());
            room.applyClientOp(Op.state("removed-card", ElementType.CARD,
                    Map.of("text", "断线旧输入", "#tombstone", false), "offline-old", new LamportClock("offline", 5)),
                    "offline-old", member);
            assertTrue(room.state().element("removed-card").isTombstone());
            assertEquals("online:10", room.state().element("removed-card").fields().get("#tombstone").writtenAt().toString());
        } finally {
            room.closeNow();
        }
    }

    private static CollabSession session(String id, String role, List<String> frames, CountDownLatch closed)
            throws Exception {
        return session(id, role, frames, closed, 7);
    }

    private static CollabSession session(String id, String role, List<String> frames, CountDownLatch closed,
                                         long userId) throws Exception {
        WebSocketSession socket = mock(WebSocketSession.class);
        AtomicBoolean open = new AtomicBoolean(true);
        when(socket.isOpen()).thenAnswer(ignored -> open.get());
        doAnswer(invocation -> {
            frames.add(((TextMessage) invocation.getArgument(0)).getPayload());
            return null;
        }).when(socket).sendMessage(any(TextMessage.class));
        doAnswer(invocation -> {
            assertEquals(CloseStatus.POLICY_VIOLATION, invocation.getArgument(0));
            open.set(false);
            closed.countDown();
            return null;
        }).when(socket).close(any(CloseStatus.class));
        return new CollabSession(id, "test", socket, userId, id, role);
    }

    private static OpStore emptyStore() {
        OpStore store = mock(OpStore.class);
        when(store.latestSnapshot(anyString())).thenAnswer(invocation ->
                new OpStore.Snapshot(invocation.getArgument(0), 0, null, false));
        when(store.loadOpsAfterWithSeq(anyString(), eq(0L))).thenReturn(List.of());
        return store;
    }

    private static JsonNode read(String json) {
        try {
            return JSON.readTree(json);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static JsonNode awaitFrame(List<String> frames, String type) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            for (int i = frames.size() - 1; i >= 0; i--) {
                JsonNode frame = read(frames.get(i));
                if (type.equals(frame.path("type").asText())) return frame;
            }
            Thread.sleep(2);
        }
        throw new AssertionError("No frame of type " + type);
    }

    private static void waitForQueued(CollabRoom room) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (room.queuedWriteCount() == 0 && System.nanoTime() < deadline) Thread.sleep(2);
        assertEquals(1, room.queuedWriteCount());
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }
}
