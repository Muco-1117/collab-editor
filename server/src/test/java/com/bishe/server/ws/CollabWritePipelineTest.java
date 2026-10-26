package com.bishe.server.ws;

import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.store.OpStore;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CollabWritePipelineTest {

    @Test
    void concurrentWritesUseOneOrderedDurableBatch() throws Exception {
        OpStore store = emptyStore();
        ScheduledThreadPoolExecutor writer = new ScheduledThreadPoolExecutor(1);
        CollabRoom room = new CollabRoom("batch-doc", store, writer);
        clearInvocations(store);
        long before = room.currentRev();

        CountDownLatch writerBlocked = new CountDownLatch(1);
        CountDownLatch releaseWriter = new CountDownLatch(1);
        writer.execute(() -> {
            writerBlocked.countDown();
            await(releaseWriter);
        });
        assertTrue(writerBlocked.await(5, TimeUnit.SECONDS));

        int operations = 64;
        ExecutorService callers = Executors.newFixedThreadPool(operations);
        CountDownLatch ready = new CountDownLatch(operations);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<CollabRoom.ApplyResult>> results = new ArrayList<>();
        try {
            for (int i = 0; i < operations; i++) {
                int index = i;
                results.add(callers.submit(() -> {
                    ready.countDown();
                    assertTrue(start.await(5, TimeUnit.SECONDS));
                    return room.applyOp(Op.put("element-" + index, ElementType.TEXT, "text", "v" + index,
                            new LamportClock("writer-" + index, 1)));
                }));
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS));
            start.countDown();
            awaitQueueSize(room, operations);
            releaseWriter.countDown();

            for (Future<CollabRoom.ApplyResult> result : results) {
                assertEquals(CollabRoom.ApplyStatus.APPLIED, result.get(10, TimeUnit.SECONDS).status());
            }
            assertEquals(before + operations, room.currentRev());

            @SuppressWarnings("unchecked")
            ArgumentCaptor<List<OpStore.AppendEntry>> rows = ArgumentCaptor.forClass(List.class);
            verify(store).appendBatch(eq("batch-doc"), rows.capture());
            assertEquals(operations, rows.getValue().size());
            for (int i = 0; i < operations; i++) {
                assertEquals(before + i + 1, rows.getValue().get(i).seq());
            }
        } finally {
            start.countDown();
            releaseWriter.countDown();
            callers.shutdownNow();
            room.closeNow();
            writer.shutdownNow();
        }
    }

    @Test
    void slowSocketPreservesOrderAndQueueOverflowClosesExplicitly() throws Exception {
        WebSocketSession socket = mock(WebSocketSession.class);
        when(socket.isOpen()).thenReturn(true);
        CountDownLatch firstEntered = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        List<String> sent = new CopyOnWriteArrayList<>();
        doAnswer(invocation -> {
            String payload = ((TextMessage) invocation.getArgument(0)).getPayload();
            sent.add(payload);
            if ("first".equals(payload)) {
                firstEntered.countDown();
                assertTrue(releaseFirst.await(5, TimeUnit.SECONDS));
            }
            return null;
        }).when(socket).sendMessage(any(TextMessage.class));

        CollabSession session = new CollabSession("slow-client", "host", socket);
        assertTrue(session.send("first"));
        assertTrue(firstEntered.await(5, TimeUnit.SECONDS));
        assertTrue(session.send("second"));
        assertTrue(session.send("third"));
        releaseFirst.countDown();
        awaitSent(sent, 3);
        assertEquals(List.of("first", "second", "third"), sent);

        WebSocketSession blockedSocket = mock(WebSocketSession.class);
        when(blockedSocket.isOpen()).thenReturn(true);
        CountDownLatch blocked = new CountDownLatch(1);
        CountDownLatch unblock = new CountDownLatch(1);
        doAnswer(invocation -> {
            blocked.countDown();
            assertTrue(unblock.await(5, TimeUnit.SECONDS));
            return null;
        }).when(blockedSocket).sendMessage(any(TextMessage.class));
        CollabSession overloaded = new CollabSession("overloaded", "host", blockedSocket);
        assertTrue(overloaded.send("head"));
        assertTrue(blocked.await(5, TimeUnit.SECONDS));
        for (int i = 0; i < CollabSession.MAX_PENDING_FRAMES; i++) {
            assertTrue(overloaded.send("queued-" + i));
        }
        assertFalse(overloaded.send("overflow"));
        verify(blockedSocket).close(CloseStatus.SESSION_NOT_RELIABLE);
        unblock.countDown();
    }

    private static OpStore emptyStore() {
        OpStore store = mock(OpStore.class);
        when(store.latestSnapshot(anyString())).thenAnswer(invocation ->
                new OpStore.Snapshot(invocation.getArgument(0), 0, null, false));
        when(store.loadOpsAfterWithSeq(anyString(), eq(0L))).thenReturn(List.of());
        when(store.maxSeq(anyString())).thenReturn(0L);
        return store;
    }

    private static void awaitQueueSize(CollabRoom room, int expected) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (room.queuedWriteCount() < expected && System.nanoTime() < deadline) {
            Thread.sleep(2);
        }
        assertEquals(expected, room.queuedWriteCount());
    }

    private static void awaitSent(List<String> sent, int expected) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (sent.size() < expected && System.nanoTime() < deadline) {
            Thread.sleep(2);
        }
        assertEquals(expected, sent.size());
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
