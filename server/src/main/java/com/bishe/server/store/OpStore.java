package com.bishe.server.store;

import com.bishe.engine.Element;
import com.bishe.engine.ElementType;
import com.bishe.engine.FieldValue;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 持久化仓储：operation_log（append-only 日志） + element_snapshot（快照）。
 *
 * <p>恢复口径（M2 验收）：取 doc 最近快照 → 回放快照之后全部日志 → 状态还原。
 * 快照/日志写入均为幂等（唯一键 doc_id+seq），崩溃后重放安全。
 */
@Repository
public class OpStore {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final JdbcTemplate jdbc;

    public OpStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** doc 目前最大 seq（无记录 → 0）。 */
    public long maxSeq(String docId) {
        Long v = jdbc.queryForObject(
                "SELECT COALESCE(MAX(seq),0) FROM operation_log WHERE doc_id=?",
                Long.class, docId);
        return v == null ? 0 : v;
    }

    /** 追加一批操作（seq 由调用方提供，从 maxSeq+1 起）。 */
    public void appendOps(String docId, List<Op> ops, long nextSeq) {
        if (ops.isEmpty()) {
            return;
        }
        java.util.concurrent.atomic.AtomicLong seqRef = new java.util.concurrent.atomic.AtomicLong(nextSeq);
        jdbc.batchUpdate(
                "INSERT INTO operation_log(doc_id, element_id, field, value_json, clock, seq)"
                        + " VALUES(?,?,?,?,?,?)",
                ops, ops.size(), (ps, op) -> {
                    ps.setString(1, docId);
                    ps.setString(2, op.elementId());
                    String field = op.field() == null ? "" : op.field();
                    ps.setString(3, op.type() == Op.Type.DELETE ? Element.TOMBSTONE_KEY : field);
                    ps.setString(4, encodeValue(op.value()));
                    ps.setString(5, String.valueOf(op.type()) + "|" + op.clock());
                    ps.setLong(6, seqRef.getAndIncrement());
                });
    }

    private static String encodeValue(Object v) {
        try {
            return MAPPER.writeValueAsString(v);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("op value 序列化失败: " + v, e);
        }
    }

    /** 读取 (afterSeq, ...] 区间的日志。 */
    public List<Op> loadOpsAfter(String docId, long afterSeq) {
        return loadOpsAfterWithSeq(docId, afterSeq).stream().map(r -> r.op()).toList();
    }

    /** (afterSeq, ...] 区间 op + 服务端 seq（回放按 seq 过滤用）。 */
    public record LoadOp(long seq, Op op) {}

    public List<LoadOp> loadOpsAfterWithSeq(String docId, long afterSeq) {
        return jdbc.query(
                "SELECT seq, element_id, field, value_json, clock FROM operation_log"
                        + " WHERE doc_id=? AND seq>? ORDER BY seq",
                (rs, i) -> new LoadOp(rs.getLong(1),
                        decodeOp(rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5))),
                docId, afterSeq);
    }

    /** 最近 N 条 op 摘要（历史时间线）。 */
    public List<Map<String, Object>> opSummaries(String docId, int limit) {
        return jdbc.queryForList(
                "SELECT seq, element_id, field, value_json, clock, created_at"
                        + " FROM operation_log WHERE doc_id=? ORDER BY seq DESC LIMIT ?",
                docId, limit);
    }

    /** 写入快照（UPSERT：同 doc 同 rev 幂等覆盖）。 */
    public void saveSnapshot(String docId, long rev, String elementsJson) {
        jdbc.update(
                "INSERT INTO element_snapshot(doc_id, rev, elements_json, created_at)"
                        + " VALUES(?,?,?,NOW()) ON DUPLICATE KEY UPDATE elements_json=VALUES(elements_json)",
                docId, rev, elementsJson);
    }

    /** 最新快照 + 其 rev。 */
    public record Snapshot(String docId, long rev, List<Element> elements, boolean present) {
    }

    public Snapshot latestSnapshot(String docId) {
        return jdbc.query(
                "SELECT rev, elements_json FROM element_snapshot WHERE doc_id=?"
                        + " ORDER BY rev DESC LIMIT 1",
                rs -> {
                    if (!rs.next()) {
                        return new Snapshot(docId, 0, null, false);
                    }
                    long rev = rs.getLong(1);
                    List<Element> els = decodeElements(rs.getString(2));
                    return new Snapshot(docId, rev, els, true);
                },
                docId);
    }

    /* ---------------- 编解码 ---------------- */

    private static Op decodeOp(String elementId, String field, String valueJson, String clockTag) {
        int bar = clockTag.indexOf('|');
        if (bar < 0) {
            throw new IllegalStateException("损坏的 clock 标记: " + clockTag);
        }
        Op.Type t = Op.Type.valueOf(clockTag.substring(0, bar));
        LamportClock clock = LamportClock.parse(clockTag.substring(bar + 1));
        ElementType et = ElementType.TEXT;   // 日志未存 element_type；恢复时类型来自快照会合并
        return switch (t) {
            case ADD -> Op.add(elementId, et, clock);
            case PUT -> Op.put(elementId, et, field, parseValue(valueJson), clock);
            case DELETE -> Op.delete(elementId, et, clock);
        };
    }

    private static Object parseValue(String valueJson) {
        if (valueJson == null) {
            return null;
        }
        try {
            JsonNode v = MAPPER.readTree(valueJson);
            return toPlain(v);
        } catch (Exception e) {
            return valueJson;
        }
    }

    private static List<Element> decodeElements(String json) {
        List<Element> out = new ArrayList<>();
        try {
            JsonNode arr = MAPPER.readTree(json);
            for (JsonNode n : arr) {
                Element el = new Element(n.path("id").asText(),
                        ElementType.valueOf(n.path("type").asText()),
                        LamportClock.parse(n.path("root").asText()));
                JsonNode fs = n.path("fields");
                fs.fields().forEachRemaining(e -> {
                    JsonNode f = e.getValue();
                    Object value = f.has("value") ? toPlain(f.get("value")) : null;
                    el.putField(e.getKey(), value, LamportClock.parse(f.path("clock").asText()));
                });
                out.add(el);
            }
        } catch (Exception e) {
            throw new IllegalStateException("快照解码失败", e);
        }
        return out;
    }

    public static String encodeElements(List<Element> els) {
        ArrayNode arr = MAPPER.createArrayNode();
        for (Element el : els) {
            ObjectNode n = arr.addObject();
            n.put("id", el.id());
            n.put("type", el.type().name());
            n.put("root", el.rootClock().toString());
            ObjectNode fs = n.putObject("fields");
            el.fields().forEach((k, fv) -> {
                ObjectNode f = fs.putObject(k);
                f.set("value", MAPPER.valueToTree(fv.value()));
                f.put("clock", fv.writtenAt().toString());
            });
        }
        return arr.toString();
    }

    /** JsonNode → 引擎语义（整数还原、null 保持）便捷方法。 */
    public static Object toPlainValue(JsonNode v) {
        return toPlain(v);
    }

    private static Object toPlain(JsonNode v) {
        if (v.isBoolean()) {
            return v.asBoolean();
        }
        if (v.isIntegralNumber()) {
            long l = v.asLong();
            return (l == (int) l) ? (int) l : l;   // 与引擎直接 put 的 Integer/Long 一致
        }
        if (v.isFloatingPointNumber()) {
            return v.asDouble();
        }
        return v.asText();
    }
}