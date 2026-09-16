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
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 版本历史：回放（任意 rev 的元素快照）+ 恢复（diff 写回）。
 * 数据源 = element_snapshot + operation_log（引擎的溯源日志，天然可用作历史）。
 */
@Service
public class HistoryService {

    private final OpStore store;
    private static final ObjectMapper M = new ObjectMapper();

    public HistoryService(OpStore store) {
        this.store = store;
    }

    /** 回放到 rev 的元素快照（结构同 welcome.snapshot）。rev<=0 返回空数组。 */
    public ArrayNode replay(String docId, int rev) {
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
    public List<Op> restoreOps(String docId, int rev) {
        long curSeq = store.maxSeq(docId);
        Map<String, JsonNode> target = indexById(replay(docId, rev));
        Map<String, JsonNode> current = indexById(replay(docId, (int) curSeq));

        List<Op> ops = new ArrayList<>();
        // 权威时钟：从极大值递减——任何真实客户端时钟都更小，保证恢复值必胜
        long[] c = {Long.MAX_VALUE - 10_000_000L};

        for (Map.Entry<String, JsonNode> e : target.entrySet()) {
            String eid = e.getKey();
            ObjectNode el = (ObjectNode) e.getValue();
            ElementType type = ElementType.valueOf(el.path("type").asText("TEXT"));
            JsonNode curEl = current.remove(eid);
            if (curEl == null) {
                ops.add(Op.add(eid, type, new LamportClock("svc-restore", --c[0])));
                for (var f : fieldsOf(el).entrySet()) {
                    ops.add(Op.put(eid, type, f.getKey(), plain(f.getValue()), new LamportClock("svc-restore", --c[0])));
                }
                continue;
            }
            Map<String, JsonNode> targetF = fieldsOf(el);
            Map<String, JsonNode> curF = fieldsOf(curEl);
            // 字段值不同（或目标缺失该字段）→ PUT（null 清除）
            for (Map.Entry<String, JsonNode> f : targetF.entrySet()) {
                JsonNode cv = curF.get(f.getKey());
                if (cv == null || cv.isNull() || !cv.equals(f.getValue())) {
                    ops.add(Op.put(eid, type, f.getKey(), plain(f.getValue()), new LamportClock("svc-restore", --c[0])));
                }
            }
            // 当前多余的字段（还原删除）→ 置 null
            for (String f : curF.keySet()) {
                if (!targetF.containsKey(f)) {
                    ops.add(Op.put(eid, type, f, null, new LamportClock("svc-restore", --c[0])));
                }
            }
        }
        // 目标中不存在但当前存在 → 删除
        for (String eid : current.keySet()) {
            String type = current.get(eid).path("type").asText("TEXT");
            ops.add(Op.delete(eid, ElementType.valueOf(type), new LamportClock("svc-restore", --c[0])));
        }
        return ops;
    }

    /* ---------- 内部 ---------- */

    private static Map<String, JsonNode> indexById(ArrayNode arr) {
        Map<String, JsonNode> m = new HashMap<>();
        arr.forEach(n -> m.put(n.path("id").asText(), n));
        return m;
    }

    private static Map<String, JsonNode> fieldsOf(JsonNode el) {
        Map<String, JsonNode> m = new HashMap<>();
        JsonNode f = el.path("fields");
        f.fields().forEachRemaining(kv -> m.put(kv.getKey(), kv.getValue().path("value")));
        return m;
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
        ObjectNode f = n.putObject("fields");
        el.fields().forEach((k, fv) -> {
            ObjectNode o = f.putObject(k);
            o.set("value", M.valueToTree(fv.value()));
            ObjectNode clk = o.putObject("clock");
            clk.put("replica", fv.writtenAt().replicaId());
            clk.put("counter", fv.writtenAt().counter());
        });
        return n;
    }
}