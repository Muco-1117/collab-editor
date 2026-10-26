package com.bishe.engine;

import java.util.Objects;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.Collections;

/**
 * 操作指令（协议报文的最小载荷建模）。
 *
 * <pre>
 * ADD    —— 创建元素（携带 type 与创建时钟根）
 * PUT    —— 字段级写入（LWW 时戳写入）
 * DELETE —— 墓碑化删除（写入 TOMBSTONE_KEY=true）
 * </pre>
 *
 * <p>所有 op 幂等：同一 op 重复应用结果不变；乱序应用结果与有序一致。
 */
public final class Op {

    public enum Type {ADD, PUT, DELETE, STATE}

    private final Type type;
    private final String elementId;
    private final ElementType elementType;
    private final String field;
    private final Object value;
    private final LamportClock clock;

    private Op(Type type, String elementId, ElementType elementType,
               String field, Object value, LamportClock clock) {
        this.type = type;
        this.elementId = Objects.requireNonNull(elementId);
        this.elementType = elementType;
        this.field = field;
        this.value = value;
        this.clock = Objects.requireNonNull(clock);
    }

    public static Op add(String elementId, ElementType type, LamportClock clock) {
        return new Op(Type.ADD, elementId, type, null, null, clock);
    }

    public static Op put(String elementId, ElementType type, String field, Object value, LamportClock clock) {
        return new Op(Type.PUT, elementId, type, field, value, clock);
    }

    public static Op delete(String elementId, ElementType type, LamportClock clock) {
        return new Op(Type.DELETE, elementId, type, null, null, clock);
    }

    /** 协议 v2：完整元素状态，opId 参与等时钟裁决，值限标量元数据。 */
    public static Op state(String elementId, ElementType type, Map<String, Object> fields,
                           String opId, LamportClock clock) {
        return new Op(Type.STATE, elementId, type, opId,
                Collections.unmodifiableMap(new LinkedHashMap<>(fields)), clock);
    }

    public Type type() {
        return type;
    }

    public String elementId() {
        return elementId;
    }

    public ElementType elementType() {
        return elementType;
    }

    public String field() {
        return field;
    }

    public Object value() {
        return value;
    }

    public LamportClock clock() {
        return clock;
    }

    @Override
    public String toString() {
        return type + " " + elementId
                + (field != null ? " ." + field + "=" + value : "")
                + " @" + clock;
    }
}
