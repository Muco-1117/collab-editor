package com.bishe.server.ws;

import com.bishe.server.store.OpStore;
import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;

/**
 * 房间表注册中心（跨 WS 与 REST 共享的单一 Map）。
 */
@Component
public class RoomRegistry {

    private final ConcurrentHashMap<String, CollabRoom> rooms = new ConcurrentHashMap<>();

    public CollabRoom roomFor(String docId, OpStore store) {
        return rooms.computeIfAbsent(docId, id -> new CollabRoom(id, store));
    }

    public CollabRoom get(String docId) {
        return rooms.get(docId);
    }
}