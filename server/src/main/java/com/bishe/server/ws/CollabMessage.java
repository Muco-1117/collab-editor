package com.bishe.server.ws;

import com.bishe.engine.Element;
import com.bishe.engine.ElementType;
import com.bishe.engine.FieldValue;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Collection;
import java.util.List;

/**
 * 实时层报文 v1.0（JSON 帧）。
 *
 * <p>C→S：hello（join，带 lastRev 增量续传）、op（引擎操作）
 * S→C：welcome（全量快照+rev）、applied（op 已应用，广播含行者）、
 * incremental（增量补发）、presence（在线集）、error。
 */
public final class CollabMessage {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private CollabMessage() {
    }

    /* ============ 入站解析 ============ */

    public record JoinRequest(String docId, String clientId, String hostname, long lastRev) {
    }

    /** {"type":"hello","docId":..,"clientId":..,"hostname":..,"lastRev":..} */
    public static JoinRequest parseJoin(ObjectNode n) {
        return new JoinRequest(
                n.path("docId").asText(),
                n.path("clientId").asText(),
                n.path("hostname").asText(""),
                n.path("lastRev").asLong(0));
    }

    /** 出站 op 的 引擎 rep：{"type":"op","op":{...}} */
    public static Op parseOp(ObjectNode n) {
        JsonNode op = n.path("op");
        String type = op.path("type").asText();
        String elementId = op.path("elementId").asText();
        ElementType elementType = ElementType.valueOf(op.path("elementType").asText());
        String field = op.path("field").asText();
        String clock = op.path("clock").asText();
        LamportClock lc = LamportClock.parse(clock);
        return switch (type) {
            case "ADD" -> Op.add(elementId, elementType, lc);
            case "PUT" -> Op.put(elementId, elementType, field, toJava(op.path("value")), lc);
            case "DELETE" -> Op.delete(elementId, elementType, lc);
            default -> throw new IllegalArgumentException("未知 op 类型: " + type);
        };
    }

    /* ============ 出站报文 ============ */

    /** hello 回执：{"type":"welcome","docId":..,"rev":..,"snapshot":[{id,type,fields}]} */
    public static String welcome(String clientId, CollabRoom room) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "welcome");
        n.put("clientId", clientId);
        n.put("docId", room.docId());
        n.put("rev", room.currentRev());
        ArrayNode els = n.putArray("snapshot");
        // 过滤墓碑元素：已删除的卡片/段落不随快照复活（视图层收敛语义）
        room.state().elements().values().stream()
                .filter(el -> !el.isTombstone())
                .forEach(el -> els.add(elementToJson(el)));
        return n.toString();
    }

    /** {"type":"applied","rev":..,"op":{...}} —— 广播给在场所有会话 */
    public static String applied(long rev, Op op) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "applied");
        n.put("rev", rev);
        n.set("op", opToJson(op));
        return n.toString();
    }

    /** 增量补发：{"type":"incremental","fromRev":..,"ops":[...]} */
    public static String incremental(long fromRev, Collection<Op> ops) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "incremental");
        n.put("fromRev", fromRev);
        ArrayNode arr = n.putArray("ops");
        ops.forEach(o -> arr.add(opToJson(o)));
        return n.toString();
    }

    /** 在线成员：{"type":"presence","clients":[...]} */
    public static String presence(Collection<String> clientIds) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "presence");
        ArrayNode arr = n.putArray("clients");
        clientIds.forEach(arr::add);
        return n.toString();
    }

    public static String error(String message) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "error");
        n.put("message", message);
        return n.toString();
    }

    /* ============ 序列化 ============ */

    /** 引擎 Op → wire JSON（客户端可直读并再次提交） */
    public static ObjectNode opToJson(Op op) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", op.type().name());
        n.put("elementId", op.elementId());
        if (op.elementType() != null) {
            n.put("elementType", op.elementType().name());
        }
        if (op.field() != null) {
            n.put("field", op.field());
        }
        if (op.value() != null) {
            n.set("value", MAPPER.valueToTree(op.value()));
        }
        n.put("clock", op.clock().toString());
        return n;
    }

    private static ObjectNode elementToJson(Element el) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("id", el.id());
        n.put("type", el.type().name());
        ObjectNode fs = n.putObject("fields");
        el.fields().forEach((k, fv) -> fs.set(k, fieldToJson(fv)));
        return n;
    }

    private static ObjectNode fieldToJson(FieldValue fv) {
        ObjectNode n = MAPPER.createObjectNode();
        n.set("value", MAPPER.valueToTree(fv.value()));
        n.put("clock", fv.writtenAt().toString());
        return n;
    }

    private static Object toJava(JsonNode v) {
        if (v == null || v.isNull()) {
            return null;
        }
        if (v.isBoolean()) {
            return v.asBoolean();
        }
        if (v.isNumber()) {
            double d = v.asDouble();
            return d == Math.rint(d) ? v.asLong() : d;
        }
        return v.asText();
    }
}