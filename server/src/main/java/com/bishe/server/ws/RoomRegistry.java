package com.bishe.server.ws;

import com.bishe.server.store.OpStore;
import com.bishe.server.store.DocRepo;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * 房间表注册中心（跨 WS 与 REST 共享的单一 Map）。
 *
 * <p>防泄漏：最后一个连接断开 90 秒后自动驱逐房间（期间有新人进入则取消驱逐）。
 * 驱逐后再次访问会按「最近快照 + 日志回放」重建，状态不丢。
 */
@Component
public class RoomRegistry {

    private static final Logger log = LoggerFactory.getLogger(RoomRegistry.class);

    /** 无人连接后的驱逐延迟。 */
    private static final long EVICT_DELAY_SECONDS = 90;

    private final ConcurrentHashMap<String, CollabRoom> rooms = new ConcurrentHashMap<>();
    private final DocRepo documents;
    private final AtomicInteger writerThreadIds = new AtomicInteger();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "room-evictor");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledThreadPoolExecutor writers = new ScheduledThreadPoolExecutor(
            Math.max(2, Math.min(8, Runtime.getRuntime().availableProcessors())), task -> {
        Thread thread = new Thread(task, "room-writer-" + writerThreadIds.incrementAndGet());
        thread.setDaemon(true);
        return thread;
    });

    public RoomRegistry() {
        this(null);
    }

    @Autowired
    public RoomRegistry(DocRepo documents) {
        this.documents = documents;
        writers.setRemoveOnCancelPolicy(true);
        writers.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    }

    public CollabRoom roomFor(String docId, OpStore store) {
        return roomFor(docId, "doc", null, store);
    }

    /**
     * Re-read metadata inside the same per-document map operation used for
     * renaming and deletion. Earlier caller reads are only adapter fallbacks.
     */
    public CollabRoom roomFor(String docId, String kind, String title, OpStore store) {
        return rooms.computeIfAbsent(docId, id -> {
            Map<String, Object> metadata = documents == null ? null : documents.get(id);
            if (documents != null && metadata == null) {
                throw new CollabRoom.JoinRejected("DOCUMENT_NOT_FOUND", "此内容已不存在或已被删除");
            }
            String currentKind = metadata == null ? kind : String.valueOf(metadata.getOrDefault("kind", "doc"));
            String currentTitle = metadata == null ? title : String.valueOf(metadata.getOrDefault("title", ""));
            CollabRoom room = new CollabRoom(id, currentKind, currentTitle, store, writers);
            room.synchronizeTitleProjection();
            return room;
        });
    }

    /** Same API with store before metadata for older adapters. */
    public CollabRoom roomFor(String docId, OpStore store, String kind, String title) {
        return roomFor(docId, kind, title, store);
    }

    public CollabRoom get(String docId) {
        return rooms.get(docId);
    }

    /** Persist and publish in one order, including when the first join is racing a rename. */
    public boolean renameDocument(String docId, String title, BooleanSupplier rename) {
        AtomicBoolean renamed = new AtomicBoolean();
        rooms.compute(docId, (id, room) -> {
            if (room == null) {
                renamed.set(rename.getAsBoolean());
                return null;
            }
            synchronized (room) {
                renamed.set(rename.getAsBoolean());
                if (renamed.get()) {
                    try {
                        room.synchronizeTitle(title);
                    } catch (RuntimeException error) {
                        // REST metadata has committed and the metadata frame
                        // was queued; its legacy projection retries on reopen.
                        log.warn("标题投影稍后重试 doc={}", docId, error);
                    }
                }
            }
            return room;
        });
        return renamed.get();
    }

    /** Delete metadata and invalidate its live room as one per-document action. */
    public boolean deleteDocument(String docId, BooleanSupplier delete) {
        AtomicBoolean deleted = new AtomicBoolean();
        rooms.compute(docId, (id, room) -> {
            deleted.set(room == null ? delete.getAsBoolean() : room.deleteIf(delete));
            return deleted.get() ? null : room;
        });
        return deleted.get();
    }

    /** Serialize a metadata restore with deletion and reopening, preserving any already-active room. */
    public <T> T restoreDocument(String docId, Supplier<T> restore) {
        AtomicReference<T> result = new AtomicReference<>();
        rooms.compute(docId, (id, room) -> {
            result.set(restore.get());
            return room;
        });
        return result.get();
    }

    /** Update existing connections; concurrent new joins independently recheck membership. */
    public void refreshMemberAccess(long spaceId, long userId, Supplier<String> currentRole) {
        if (documents == null) return;
        rooms.forEach((docId, room) -> {
            if (documents.spaceIdOf(docId) == spaceId) {
                room.refreshMemberAccess(userId, currentRole);
                if (room.occupantCount() == 0) scheduleEviction(docId);
            }
        });
    }

    /** 房间无人时安排延时驱逐；期间有新人加入（occupantCount>0）则放弃。 */
    public void scheduleEviction(String docId) {
        final CollabRoom r = rooms.get(docId);
        if (r == null) {
            return;
        }
        scheduler.schedule(() -> {
            if (rooms.get(docId) == r && r.occupantCount() == 0) {
                if (r.closeIfIdle()) {
                    rooms.remove(docId, r);
                } else {
                    scheduleEviction(docId);
                }
            }
        }, EVICT_DELAY_SECONDS, TimeUnit.SECONDS);
    }

    @PreDestroy
    void shutdown() {
        scheduler.shutdownNow();
        rooms.values().forEach(CollabRoom::closeNow);
        rooms.clear();
        writers.shutdown();
        try {
            if (!writers.awaitTermination(5, TimeUnit.SECONDS)) {
                writers.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            writers.shutdownNow();
        }
    }
}
