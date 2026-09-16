package com.bishe.server.ws;

import com.bishe.engine.DocState;
import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.store.OpStore;
import com.bishe.engine.Element;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 协同房间：一个 docId 一个 room。
 *
 * <p>持久化策略（T0+4）：
 * 启动/首次进入 → OpStore 恢复（最近快照 + 其后 op 日志回放）；
 * applyOp → 内存状态 + operation_log 追加（rev=seq 单调）；
 * 每 {@link #SNAPSHOT_INTERVAL} 条 op 打一次快照（DB 侧压缩，内存日志保留
 * 供任意 rev 增量续传）。
 */
public final class CollabRoom {

    private static final Logger log = LoggerFactory.getLogger(CollabRoom.class);
    private static final int SNAPSHOT_INTERVAL = 64;

    /** doc-root 元素 id（文档元数据锚点）。 */
    public static final String ROOT_ID = "doc-root";

    private final String docId;
    private final OpStore store;
    private final DocState state;
    private final List<Op> ops = new ArrayList<>();
    private final Object opsLock = new Object();
    private final AtomicLong revSeq = new AtomicLong(0);
    private final ConcurrentHashMap<String, CollabSession> sessions = new ConcurrentHashMap<>();

    public CollabRoom(String docId, OpStore store) {
        this.docId = docId;
        this.store = store;
        // —— 恢复：快照 + 日志回放 ——
        DocState restored = new DocState("server:" + docId);
        long restoredFrom = 0;
        OpStore.Snapshot snap = store.latestSnapshot(docId);
        if (snap.present()) {
            DocState snapState = new DocState("server:snap:" + docId);
            snap.elements().forEach(snapState::putRestoredElement);
            restored.mergeState(snapState);
            restoredFrom = snap.rev();
            log.info("恢复[{}]：快照 rev={} elements={}", docId, snap.rev(), snap.elements().size());
        }
        List<Op> tail = store.loadOpsAfter(docId, restoredFrom);
        tail.forEach(restored::apply);
        this.state = restored;
        synchronized (opsLock) {
            ops.addAll(store.loadOpsAfter(docId, 0));   // 全量日志（含快照前，供任意点增量）
            revSeq.set(store.maxSeq(docId));
        }
        if (!tail.isEmpty() || restoredFrom > 0) {
            log.info("恢复房间[{}]：日志回放 [{}..{}]，当前 rev={}", docId, restoredFrom,
                    restoredFrom + tail.size(), revSeq.get());
        }
        // —— 空文档种子：doc-root + 首个空段落 ——
        if (revSeq.get() == 0 && !snap.present()) {
            long c = 1;
            String rid = "server:" + docId;
            Op seedRoot = Op.add(ROOT_ID, ElementType.DOC, new LamportClock(rid, c++));
            Op seedTitle = Op.put(ROOT_ID, ElementType.DOC, "title",
                    docId.length() > 8 ? docId.substring(0, 8) : docId, new LamportClock(rid, c++));
            Op seedSeg = Op.add("seg-root-01", ElementType.TEXT, new LamportClock(rid, c++));
            Op seedOrder = Op.put("seg-root-01", ElementType.TEXT, "order", 1,
                    new LamportClock(rid, c++));
            applyOp(seedRoot);
            applyOp(seedTitle);
            applyOp(seedSeg);
            applyOp(seedOrder);
            log.info("新文档[{}]：已播种 doc-root + 首个段落（rev={}）", docId, revSeq.get());
        }
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

    /** 接收并应用一条操作：顺序 = 服务端到达序（DB seq），再广播全体。 */
    public void applyOp(Op op) {
        state.apply(op);
        final long rev;
        synchronized (opsLock) {
            ops.add(op);
            rev = revSeq.incrementAndGet();
            store.appendOps(docId, List.of(op), rev);
        }
        String msg = CollabMessage.applied(rev, op);
        sessions.values().forEach(s -> s.send(msg));
        if (rev % SNAPSHOT_INTERVAL == 0) {
            store.saveSnapshot(docId, rev, OpStore.encodeElements(new ArrayList<>(state.elements().values())));
        }
    }

    /** 外部注入的批量 op（历史恢复等 REST 场景）：与 WS op 同路径落库 + 广播。 */
    public void applyExternal(java.util.List<Op> ops) {
        for (Op op : ops) applyOp(op);
    }

    /** (lastRev, rev] 区间增量 op；lastRev 超窗口（被快照吞没）时返回 null 由调用方回退全量。 */
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