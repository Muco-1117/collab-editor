package com.bishe.engine;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

/**
 * 元素 —— 协同状态的基本单元（id 全局唯一，一切应用复用）。
 *
 * <pre>
 * Element {
 *   id      : String         全局唯一（UUID）
 *   type    : ElementType    应用类型
 *   rootClk : LamportClock   元素创建时钟（兼作 type 冲突裁决）
 *   fields  : Map&lt;String, FieldValue&gt;   字段级 LWW
 *   deleted : boolean        删除=墓碑（历史保留，合并按 LWW 仲裁）
 * }
 * </pre>
 *
 * <p>合并语义（逐字段 LWW，幂等、可交换）：同一字段只有「最后写入者」胜出；
 * 元素存在性由 rootClk 仲裁：远端元素 rootClk 更大 → 其完整字段视图覆盖本地
 * 同字段；墓碑是普通字段的特例（"#tombstone"），同样由 LWW 决定。
 */
public final class Element {

    /** 墓碑字段名：字段值为 Boolean.TRUE 表示已删除。 */
    public static final String TOMBSTONE_KEY = "#tombstone";

    private final String id;
    private final ElementType type;
    private final LamportClock rootClock;
    private final Map<String, FieldValue> fields = new LinkedHashMap<>();

    public Element(String id, ElementType type, LamportClock rootClock) {
        this.id = id;
        this.type = type;
        this.rootClock = rootClock;
    }

    public String id() {
        return id;
    }

    public ElementType type() {
        return type;
    }

    public LamportClock rootClock() {
        return rootClock;
    }

    public Map<String, FieldValue> fields() {
        return fields;
    }

    public boolean isTombstone() {
        FieldValue fv = fields.get(TOMBSTONE_KEY);
        return fv != null && Boolean.TRUE.equals(fv.value());
    }

    /**
     * 写入 / 合并一个字段：按 LWW 仲裁（本地新写时钟必大于旧值 → 自然胜出；
     * 远端乱序到达的同字段旧时钟写入 → 被新值压住）。所有路径统一走这里，
     * 保证 apply 与到达顺序无关。
     */
    public void putField(String name, Object value, LamportClock clock) {
        fields.merge(name, new FieldValue(value, clock), FieldValue::mergeLww);
    }

    /** 应用远程元素：按字段 LWW 合并（含墓碑）。 */
    public void merge(Element remote) {
        remote.fields.forEach((name, fv) -> fields.merge(name, fv, FieldValue::mergeLww));
    }

    /**
     * 规范序列化（canonical hash 基准）：按字段名字典序输出。
     *
     * <p>注意：元素 rootClock 是“创建事件”的历史元数据，不参与状态视图
     * （某副本可能因乱序先收到后续写 op 而自动补建，root 会不同）；状态
     * 收敛判定只看“元素集合与字段视图”。
     */
    public String toCanonicalString() {
        StringBuilder sb = new StringBuilder();
        sb.append(id).append('|').append(type).append('|');
        var sorted = new TreeMap<>(fields);
        sorted.forEach((k, v) -> sb.append(k).append('=').append(v).append(';'));
        return sb.toString();
    }

    @Override
    public String toString() {
        return toCanonicalString();
    }
}