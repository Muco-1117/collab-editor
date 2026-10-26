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
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

/** JSON wire protocol and strict inbound-frame validation for the collaboration socket. */
public final class CollabMessage {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    // DELETE| + clientId + ':' + max JS-safe counter must fit operation_log.clock VARCHAR(64).
    private static final Pattern CLIENT_ID = Pattern.compile("[A-Za-z0-9._-]{1,40}");
    private static final Pattern OP_ID = Pattern.compile("[A-Za-z0-9._:-]{1,64}");
    private static final long MAX_JS_SAFE_INTEGER = 9_007_199_254_740_991L;

    private CollabMessage() {
    }

    public static final class ProtocolException extends IllegalArgumentException {
        private final String code;

        public ProtocolException(String code, String message) {
            super(message);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    public record JoinRequest(String docId, String clientId, String hostname, long lastRev) {
    }

    /**
     * {@code opId} is optional in protocol v1. It is retained in the in-memory room dedupe index;
     * persisting it later only requires extending the operation-log adapter, not the wire parser.
     */
    public record ParsedOp(Op op, String opId) {
    }

    public static JoinRequest parseJoin(ObjectNode frame) {
        String docId = requiredText(frame, "docId", 36, "INVALID_HELLO");
        if (!isIdentifier(docId)) {
            throw new ProtocolException("INVALID_HELLO", "docId 格式无效");
        }
        String clientId = requiredText(frame, "clientId", 40, "INVALID_HELLO");
        if (!CLIENT_ID.matcher(clientId).matches()) {
            throw new ProtocolException("INVALID_HELLO", "clientId 仅允许字母、数字、点、下划线和连字符");
        }

        String hostname = "";
        if (frame.has("hostname") && !frame.get("hostname").isNull()) {
            JsonNode hostNode = frame.get("hostname");
            if (!hostNode.isTextual()) {
                throw new ProtocolException("INVALID_HELLO", "hostname 必须是字符串");
            }
            hostname = hostNode.textValue().trim();
            if (hostname.length() > 64 || containsControl(hostname)) {
                throw new ProtocolException("INVALID_HELLO", "hostname 长度或字符无效");
            }
        }

        long lastRev = 0;
        if (frame.has("lastRev")) {
            JsonNode rev = frame.get("lastRev");
            if (!rev.isIntegralNumber() || !rev.canConvertToLong()) {
                throw new ProtocolException("INVALID_HELLO", "lastRev 必须是非负整数");
            }
            lastRev = rev.longValue();
            if (lastRev < 0 || lastRev > MAX_JS_SAFE_INTEGER) {
                throw new ProtocolException("INVALID_HELLO", "lastRev 超出有效范围");
            }
        }
        return new JoinRequest(docId, clientId, hostname, lastRev);
    }

    /** Compatibility entry point used by older unit tests and adapters. */
    public static Op parseOp(ObjectNode frame) {
        JsonNode opNode = frame.path("op");
        String clock = opNode.path("clock").asText("");
        int colon = clock.lastIndexOf(':');
        return parseOperation(frame, colon > 0 ? clock.substring(0, colon) : "").op();
    }

    public static ParsedOp parseOperation(ObjectNode frame, String clientId) {
        JsonNode raw = frame.get("op");
        if (!(raw instanceof ObjectNode opNode)) {
            throw new ProtocolException("INVALID_OP", "op 必须是对象");
        }

        String typeText = requiredText(opNode, "type", 16, "INVALID_OP");
        final Op.Type type;
        try {
            type = Op.Type.valueOf(typeText);
        } catch (IllegalArgumentException e) {
            throw new ProtocolException("INVALID_OP", "未知 op 类型");
        }

        String elementId = requiredText(opNode, "elementId", 64, "INVALID_OP");
        if (!isIdentifier(elementId)) {
            throw new ProtocolException("INVALID_OP", "elementId 格式无效");
        }

        String elementTypeText = requiredText(opNode, "elementType", 16, "INVALID_OP");
        final ElementType elementType;
        try {
            elementType = ElementType.valueOf(elementTypeText);
        } catch (IllegalArgumentException e) {
            throw new ProtocolException("INVALID_OP", "未知 elementType");
        }

        String clockText = requiredText(opNode, "clock", 64, "INVALID_CLOCK");
        LamportClock clock = parseClock(clockText, clientId);
        String opId = optionalOpId(frame, opNode);

        Op op;
        switch (type) {
            case STATE -> {
                if (opId == null) throw new ProtocolException("INVALID_OP", "STATE 必须声明 opId");
                JsonNode values = opNode.get("value");
                if (values == null || !values.isObject() || values.size() > 32) {
                    throw new ProtocolException("INVALID_OP", "STATE.value 必须为最多 32 个字段的对象");
                }
                java.util.Map<String, Object> fields = new java.util.LinkedHashMap<>();
                values.fields().forEachRemaining(entry -> {
                    String key = entry.getKey();
                    if (key.length() > 64 || !isIdentifier(key)
                            || (key.startsWith("#") && !Element.TOMBSTONE_KEY.equals(key))) {
                        throw new ProtocolException("INVALID_OP", "STATE 字段名无效");
                    }
                    if (Element.TOMBSTONE_KEY.equals(key) && !entry.getValue().isBoolean()) {
                        throw new ProtocolException("INVALID_OP", "删除标记必须是布尔值");
                    }
                    fields.put(key, toJava(entry.getValue()));
                });
                op = Op.state(elementId, elementType, fields, opId, clock);
            }
            case ADD -> {
                rejectPayloadFields(opNode, type);
                op = Op.add(elementId, elementType, clock);
            }
            case DELETE -> {
                rejectPayloadFields(opNode, type);
                op = Op.delete(elementId, elementType, clock);
            }
            case PUT -> {
                String field = requiredText(opNode, "field", 64, "INVALID_OP");
                if (!isIdentifier(field) || Element.TOMBSTONE_KEY.equals(field)) {
                    throw new ProtocolException("INVALID_OP", "field 格式无效或为保留字段");
                }
                if (!opNode.has("value")) {
                    throw new ProtocolException("INVALID_OP", "PUT 缺少 value");
                }
                op = Op.put(elementId, elementType, field, toJava(opNode.get("value")), clock);
            }
            default -> throw new IllegalStateException("unreachable");
        }
        return new ParsedOp(op, opId);
    }

    public static String welcome(CollabSession session, CollabRoom room) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "welcome");
        n.put("clientId", session.clientId());
        n.put("docId", room.docId());
        n.put("rev", room.currentRev());
        putMetadata(n, room);
        putMemberAccess(n, session);
        ArrayNode els = n.putArray("snapshot");
        // Tombstone clocks are part of the replicated state. Omitting them
        // lets a reconnecting client's older unacknowledged STATE resurrect
        // an element locally even when the server correctly keeps it deleted.
        room.state().elements().values().stream()
                .forEach(el -> els.add(elementToJson(el)));
        return n.toString();
    }

    /** Compatibility overload. New code should pass the session so access hints are included. */
    public static String welcome(String clientId, CollabRoom room) {
        return welcome(new CollabSession(clientId, "", null, 0, clientId, "editor"), room);
    }

    public static String incremental(long fromRev, long toRev, Collection<Op> ops,
                                     CollabSession session) {
        return incremental(fromRev, toRev, ops, session, null);
    }

    public static String incremental(long fromRev, long toRev, Collection<Op> ops,
                                     CollabSession session, CollabRoom room) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "incremental");
        n.put("fromRev", fromRev);
        n.put("toRev", toRev);
        n.put("rev", toRev); // v1 clients used rev; keep it as a compatibility alias.
        putMemberAccess(n, session);
        if (room != null) putMetadata(n, room);
        ArrayNode arr = n.putArray("ops");
        ops.forEach(o -> arr.add(opToJson(o)));
        return n.toString();
    }

    public static String incremental(long fromRev, Collection<Op> ops) {
        return incremental(fromRev, fromRev + ops.size(), ops,
                new CollabSession("", "", null, 0, "", "editor"));
    }

    public static String applied(long rev, Op op) {
        return applied(rev, op, null, false, false);
    }

    public static String applied(long rev, Op op, String opId, boolean duplicate, boolean ignored) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "applied");
        n.put("rev", rev);
        if (opId != null) {
            n.put("opId", opId);
        }
        if (duplicate) {
            n.put("duplicate", true);
        }
        if (ignored) {
            n.put("ignored", true);
        }
        n.set("op", opToJson(op));
        return n.toString();
    }

    public static String presence(Collection<CollabSession> sessions) {
        List<CollabSession> ordered = sessions.stream()
                .sorted(Comparator.comparing(CollabSession::clientId))
                .toList();
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "presence");
        ArrayNode clients = n.putArray("clients");
        ArrayNode members = n.putArray("members");
        for (CollabSession session : ordered) {
            clients.add(session.clientId());
            ObjectNode member = members.addObject();
            member.put("clientId", session.clientId());
            member.put("displayName", session.displayName());
            member.put("hostname", session.hostname());
        }
        return n.toString();
    }

    public static String presenceIds(Collection<String> clientIds) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "presence");
        ArrayNode arr = n.putArray("clients");
        clientIds.stream().sorted().forEach(arr::add);
        n.putArray("members");
        return n.toString();
    }

    public static String pong(ObjectNode ping) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "pong");
        if (ping.has("ts")) {
            JsonNode ts = ping.get("ts");
            if (!ts.isIntegralNumber() || !ts.canConvertToLong() || ts.longValue() < 0
                    || ts.longValue() > MAX_JS_SAFE_INTEGER) {
                throw new ProtocolException("INVALID_HEARTBEAT", "ping.ts 必须是非负整数");
            }
            n.put("ts", ts.longValue());
        }
        if (ping.has("nonce")) {
            JsonNode nonce = ping.get("nonce");
            if (!nonce.isTextual() || nonce.textValue().length() > 64 || containsControl(nonce.textValue())) {
                throw new ProtocolException("INVALID_HEARTBEAT", "ping.nonce 格式无效");
            }
            n.put("nonce", nonce.textValue());
        }
        return n.toString();
    }

    public static String error(String code, String message, boolean fatal) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", "error");
        n.put("code", code);
        n.put("message", message);
        n.put("fatal", fatal);
        return n.toString();
    }

    public static String error(String message) {
        return error("PROTOCOL_ERROR", message, false);
    }

    public static String metadata(CollabRoom room) {
        ObjectNode node = MAPPER.createObjectNode();
        node.put("type", "metadata");
        putMetadata(node, room);
        return node.toString();
    }

    /** Live permission changes do not require a content reconnect. */
    public static String access(CollabSession session) {
        ObjectNode node = MAPPER.createObjectNode();
        node.put("type", "access");
        putMemberAccess(node, session);
        node.put("message", session.canWrite() ? "空间所有者已授予你编辑权限" : "空间所有者已将你的权限改为只读");
        return node.toString();
    }

    public static ObjectNode opToJson(Op op) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("type", op.type().name());
        n.put("elementId", op.elementId());
        if (op.elementType() != null) {
            n.put("elementType", op.elementType().name());
        }
        if (op.type() == Op.Type.STATE) n.put("opId", op.field());
        else if (op.field() != null) {
            n.put("field", op.field());
        }
        if (op.type() == Op.Type.PUT || op.type() == Op.Type.STATE) {
            n.set("value", MAPPER.valueToTree(op.value()));
        }
        n.put("clock", op.clock().toString());
        return n;
    }

    private static void putMemberAccess(ObjectNode node, CollabSession session) {
        node.put("role", session.role());
        node.put("canWrite", session.canWrite());
        node.put("displayName", session.displayName());
    }

    private static void putMetadata(ObjectNode node, CollabRoom room) {
        node.put("docId", room.docId());
        node.put("kind", room.kind());
        node.put("title", room.metadataTitle());
    }

    private static ObjectNode elementToJson(Element el) {
        ObjectNode n = MAPPER.createObjectNode();
        n.put("id", el.id());
        n.put("type", el.type().name());
        n.put("rootClock", el.rootClock().toString());
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

    private static LamportClock parseClock(String value, String clientId) {
        int colon = value.lastIndexOf(':');
        if (colon <= 0 || colon == value.length() - 1) {
            throw new ProtocolException("INVALID_CLOCK", "clock 格式必须为 replicaId:counter");
        }
        String replica = value.substring(0, colon);
        if (!Objects.equals(replica, clientId)) {
            throw new ProtocolException("INVALID_CLOCK", "clock.replicaId 必须等于本会话 clientId");
        }
        String counterText = value.substring(colon + 1);
        if (!counterText.chars().allMatch(Character::isDigit)) {
            throw new ProtocolException("INVALID_CLOCK", "clock.counter 必须是正整数");
        }
        try {
            long counter = Long.parseLong(counterText);
            if (counter <= 0 || counter > MAX_JS_SAFE_INTEGER) {
                throw new ProtocolException("INVALID_CLOCK", "clock.counter 超出有效范围");
            }
            return new LamportClock(replica, counter);
        } catch (NumberFormatException e) {
            throw new ProtocolException("INVALID_CLOCK", "clock.counter 超出有效范围");
        }
    }

    private static String optionalOpId(ObjectNode frame, ObjectNode opNode) {
        JsonNode id = opNode.has("opId") ? opNode.get("opId") : frame.get("opId");
        if (id == null || id.isNull()) {
            return null;
        }
        if (!id.isTextual() || !OP_ID.matcher(id.textValue()).matches()) {
            throw new ProtocolException("INVALID_OP", "opId 格式无效");
        }
        return id.textValue();
    }

    private static void rejectPayloadFields(ObjectNode op, Op.Type type) {
        if (op.has("field") || op.has("value")) {
            throw new ProtocolException("INVALID_OP", type + " 不允许 field/value");
        }
    }

    private static Object toJava(JsonNode value) {
        if (value == null || value.isNull()) {
            return null;
        }
        if (value.isBoolean()) {
            return value.booleanValue();
        }
        if (value.isIntegralNumber()) {
            if (!value.canConvertToLong()) {
                throw new ProtocolException("INVALID_OP", "value 整数超出有效范围");
            }
            long number = value.longValue();
            return number >= Integer.MIN_VALUE && number <= Integer.MAX_VALUE ? (int) number : number;
        }
        if (value.isFloatingPointNumber()) {
            double number = value.doubleValue();
            if (!Double.isFinite(number)) {
                throw new ProtocolException("INVALID_OP", "value 必须是有限数值");
            }
            return number;
        }
        if (value.isTextual()) {
            if (value.textValue().length() > 32_768) {
                throw new ProtocolException("INVALID_OP", "value 文本过长");
            }
            return value.textValue();
        }
        throw new ProtocolException("INVALID_OP", "value 仅支持 null、布尔、数值或字符串");
    }

    private static String requiredText(ObjectNode node, String field, int maxLength, String code) {
        JsonNode value = node.get(field);
        if (value == null || !value.isTextual()) {
            throw new ProtocolException(code, field + " 必须是字符串");
        }
        String text = value.textValue();
        if (text.isBlank() || text.length() > maxLength || containsControl(text)) {
            throw new ProtocolException(code, field + " 长度或字符无效");
        }
        return text;
    }

    private static boolean isIdentifier(String value) {
        return !value.isBlank() && !containsControl(value) && value.chars().noneMatch(Character::isWhitespace);
    }

    private static boolean containsControl(String value) {
        return value.chars().anyMatch(Character::isISOControl);
    }
}
