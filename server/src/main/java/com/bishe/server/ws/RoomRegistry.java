package com.bishe.server.ws;

import com.bishe.server.store.OpStore;
import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 房间表注册中心（跨 WS 与 REST 共享的单一 Map）。
 *
 * <p>防泄漏：最后一个连接断开 90 秒后自动驱逐房间（期间有新人进入则取消驱逐）。
 * 驱逐后再次访问会按「最近快照 + 日志回放」重建，状态不丢。
 */
@Component
public class RoomRegistry {

    /** 无人连接后的驱逐延迟。 */
    private static final long EVICT_DELAY_SECONDS = 90;

    private final ConcurrentHashMap<String, CollabRoom> rooms = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "room-evictor");
        t.setDaemon(true);
        return t;
    });

    public CollabRoom roomFor(String docId, OpStore store) {
        return rooms.computeIfAbsent(docId, id -> new CollabRoom(id, store));
    }

    public CollabRoom get(String docId) {
        return rooms.get(docId);
    }

    /** 房间无人时安排延时驱逐；期间有新人加入（occupantCount>0）则放弃。 */
    public void scheduleEviction(String docId) {
        final CollabRoom r = rooms.get(docId);
        if (r == null) {
            return;
        }
        scheduler.schedule(() -> {
            if (rooms.get(docId) == r && r.occupantCount() == 0) {
                rooms.remove(docId, r);
            }
        }, EVICT_DELAY_SECONDS, TimeUnit.SECONDS);
    }
}