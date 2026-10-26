package com.bishe.server.history;

import com.bishe.engine.DocState;
import com.bishe.engine.Element;
import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.store.OpStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 版本历史：回放（任意 rev 的元素快照）+ 恢复（diff 写回）。
 * 数据源 = element_snapshot + operation_log（引擎的溯源日志，天然可用作历史）。
 */
@Service
public class HistoryService {

    private final OpStore store;
    private static final ObjectMapper M = new ObjectMapper();
    private static final String RESTORE_REPLICA = "server-restore";
    private final ConcurrentHashMap<String, AtomicLong> restoreCounters = new ConcurrentHashMap<>();

    public HistoryService(OpStore store) {
        this.store = store;
    }

    /** 回放到 rev 的元素快照（结构同 welcome.snapshot）。rev<=0 返回空数组。 */
    public ArrayNode replay(String docId, long rev) {
        DocState st = new DocState("replay");
        if (rev <= 0) return M.createArrayNode();
        OpStore.Snapshot snap = store.latestSnapshot(docId);
        long base = 0;
        if (snap.present() && snap.rev() <= rev) {
            snap.elements().forEach(st::putRestoredElement);
            base = snap.rev();
        }
        for (OpStore.LoadOp lo : store.loadOpsAfterWithSeq(docId, base)) {
            if (lo.seq() <= rev) st.apply(lo.op());
        }
        ArrayNode out = M.createArrayNode();
        st.elements().values().forEach(el -> out.add(elementToJson(el)));
        return out;
    }

    /** 最近 N 条 op 摘要（时间线）。 */
    public List<Map<String, Object>> timeline(String docId, int limit) {
        return store.opSummaries(docId, Math.max(1, Math.min(limit, 200)));
    }

    /**
     * 把文档状态收敛到 rev（回退或前拨），产出一组 diff op。
     * 恢复语义：目标版本元素 = 权威；缺 → ADD，多 → DELETE，字段不同 → PUT。
     */
    public List<Op> restoreOps(String docId, long rev) {
        long curSeq = store.maxSeq(docId);
        Map<String, JsonNode> target = indexById(replay(docId, rev));
        Map<String, JsonNode> current = indexById(replay(docId, curSeq));

        List<Op> ops = new ArrayList<>();
        RestoreClockSequence clocks = restoreClocks(docId);

        for (Map.Entry<String, JsonNode> e : target.entrySet()) {
            String eid = e.getKey();
            ObjectNode el = (ObjectNode) e.getValue();
            ElementType type = ElementType.valueOf(el.path("type").asText("TEXT"));
            JsonNode curEl = current.remove(eid);
            if (el.path("fields").has("#version") || (curEl != null && curEl.path("fields").has("#version"))) {
                Map<String, Object> values = new LinkedHashMap<>();
                fieldsOf(el).forEach((key, value) -> { if (!"#version".equals(key)) values.put(key, plain(value)); });
                if (!values.containsKey(Element.TOMBSTONE_KEY)) values.put(Element.TOMBSTONE_KEY, false);
                ops.add(Op.state(eid, type, values, java.util.UUID.randomUUID().toString(), clocks.next()));
                continue;
            }
            if (curEl == null) {
                ops.add(Op.add(eid, type, clocks.next()));
                for (var f : fieldsOf(el).entrySet()) {
                    ops.add(Op.put(eid, type, f.getKey(), plain(f.getValue()), clocks.next()));
                }
                continue;
            }
            if (!type.name().equals(curEl.path("type").asText())) {
                ops.add(Op.add(eid, type, clocks.next()));
            }
            Map<String, JsonNode> targetF = fieldsOf(el);
            Map<String, JsonNode> curF = fieldsOf(curEl);
            // 字段值不同（或目标缺失该字段）→ PUT（null 清除）
            for (Map.Entry<String, JsonNode> f : targetF.entrySet()) {
                JsonNode cv = curF.get(f.getKey());
                if (cv == null || cv.isNull() || !cv.equals(f.getValue())) {
                    ops.add(Op.put(eid, type, f.getKey(), plain(f.getValue()), clocks.next()));
                }
            }
            // 当前多余的字段（还原删除）→ 写入带新时钟的显式 null。
            for (String f : curF.keySet()) {
                if (!targetF.containsKey(f)) {
                    ops.add(Op.put(eid, type, f, null, clocks.next()));
                }
            }
        }
        // 目标中不存在但当前存在 → 删除
        for (String eid : current.keySet()) {
            String type = current.get(eid).path("type").asText("TEXT");
            if (current.get(eid).path("fields").has("#version")) {
                Map<String, Object> values = new LinkedHashMap<>();
                fieldsOf(current.get(eid)).forEach((key, value) -> { if (!"#version".equals(key)) values.put(key, plain(value)); });
                values.put(Element.TOMBSTONE_KEY, true);
                ops.add(Op.state(eid, ElementType.valueOf(type), values, java.util.UUID.randomUUID().toString(), clocks.next()));
            } else ops.add(Op.delete(eid, ElementType.valueOf(type), clocks.next()));
        }
        return ops;
    }

    /* ---------- 内部 ---------- */

    private static Map<String, JsonNode> indexById(ArrayNode arr) {
        Map<String, JsonNode> m = new LinkedHashMap<>();
        arr.forEach(n -> m.put(n.path("id").asText(), n));
        return m;
    }

    private static Map<String, JsonNode> fieldsOf(JsonNode el) {
        Map<String, JsonNode> m = new LinkedHashMap<>();
        JsonNode f = el.path("fields");
        f.fields().forEachRemaining(kv -> {
            JsonNode value = kv.getValue().path("value");
            // null 是字段清除标记：保留在引擎状态中参与 LWW，但历史逻辑视图中等价于不存在。
            if (!value.isMissingNode() && !value.isNull()) {
                m.put(kv.getKey(), value);
            }
        });
        return m;
    }

    private RestoreClockSequence restoreClocks(String docId) {
        long persistedMax = store.maxLamportCounter(docId);
        AtomicLong counter = restoreCounters.compute(docId, (id, existing) -> {
            if (existing == null) {
                return new AtomicLong(persistedMax);
            }
            existing.accumulateAndGet(persistedMax, Math::max);
            return existing;
        });
        return new RestoreClockSequence(counter);
    }

    private record RestoreClockSequence(AtomicLong counter) {
        LamportClock next() {
            long next = counter.updateAndGet(current -> {
                if (current == Long.MAX_VALUE) {
                    throw new IllegalStateException("Lamport counter 已耗尽，无法生成历史恢复操作");
                }
                return current + 1;
            });
            return new LamportClock(RESTORE_REPLICA, next);
        }
    }

    /** JSON 值 → 引擎语义（整数还原、null 保持）。 */
    private static Object plain(JsonNode v) {
        return OpStore.toPlainValue(v);
    }

    /** 与 welcome 快照同构的元素序列化。 */
    public static ObjectNode elementToJson(Element el) {
        ObjectNode n = M.createObjectNode();
        n.put("id", el.id());
        n.put("type", el.type().name());
        n.put("rootClock", el.rootClock().toString());
        ObjectNode f = n.putObject("fields");
        el.fields().forEach((k, fv) -> {
            ObjectNode o = f.putObject(k);
            o.set("value", M.valueToTree(fv.value()));
            o.put("clock", fv.writtenAt().toString());
        });
        return n;
    }
}
