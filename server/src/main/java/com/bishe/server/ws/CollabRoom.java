package com.bishe.server.ws;

import com.bishe.engine.DocState;
import com.bishe.engine.Op;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 协同房间：一个 docId 一个 room。
 *
 * <p>组成：一份服务端状态（引擎并发合并）+ append-only Op 日志（T0+4 直接落
 * MySQL 成为 operation_log 表）+ 在场会话集合。rev 为日志位置（服务端顺序），
 * 断线重连：Join 时带 lastRev → 从日志回放弥补（增量同步）；日志清空前的
 * 全量兜底由 welcome 快照承担。
 */
public final class CollabRoom {

    private final String docId;
    private final DocState state;
    private final List<Op> ops = new ArrayList<>();
    private final Object opsLock = new Object();
    private final AtomicLong revSeq = new AtomicLong(0);
    private final ConcurrentHashMap<String, CollabSession> sessions = new ConcurrentHashMap<>();

    public CollabRoom(String docId) {
        this.docId = docId;
        this.state = new DocState("server:" + docId);
    }

    public String docId() {
        return docId;
    }

    public DocState state() {
        return state;
    }

    public long currentRev() {
        return revSeq.get();
    }

    /** 接收并应用一条操作：先进状态再广播（含作者本人，便于本地回执对齐）。 */
    public void applyOp(Op op) {
        state.apply(op);
        final long rev;
        synchronized (opsLock) {
            ops.add(op);
            rev = revSeq.incrementAndGet();
        }
        String msg = CollabMessage.applied(rev, op);
        sessions.values().forEach(s -> s.send(msg));
    }

    /** (lastRev, rev] 区间增量 op。 */
    public List<Op> opsAfter(long lastRev) {
        synchronized (opsLock) {
            if (lastRev >= ops.size()) {
                return List.of();
            }
            return new ArrayList<>(ops.subList((int) lastRev, ops.size()));
        }
    }

    public void join(CollabSession s) {
        sessions.put(s.clientId(), s);
        broadcastPresence();
    }

    public int occupantCount() {
        return sessions.size();
    }

    public void leave(String clientId) {
        sessions.remove(clientId);
        broadcastPresence();
    }

    private void broadcastPresence() {
        String msg = CollabMessage.presence(sessions.keySet());
        sessions.values().forEach(s -> s.send(msg));
    }
}