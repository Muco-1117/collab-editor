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
    private ElementType type;
    private LamportClock rootClock;
    private final Map<String, FieldValue> fields = new LinkedHashMap<>();

    public Element(String id, ElementType type, LamportClock rootClock) {
        this.id = Objects.requireNonNull(id, "id");
        this.type = Objects.requireNonNull(type, "type");
        this.rootClock = Objects.requireNonNull(rootClock, "rootClock");
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

    /**
     * 合并元素类型声明。正常客户端的同一元素类型恒定；若收到冲突类型，则以
     * {@code (clock, typeName)} 全序决胜，避免首个到达者决定类型而破坏收敛。
     */
    public void mergeIdentity(ElementType remoteType, LamportClock remoteClock) {
        if (remoteType == null || remoteClock == null) {
            return;
        }
        int byClock = remoteClock.compareTo(rootClock);
        if (byClock > 0 || (byClock == 0 && remoteType.name().compareTo(type.name()) > 0)) {
            type = remoteType;
            rootClock = remoteClock;
        }
    }

    /** 应用远程元素：元素类型与全部字段分别按确定性 LWW 规则合并（含墓碑）。 */
    public void merge(Element remote) {
        if (fields.containsKey("#version") || remote.fields.containsKey("#version")) {
            if (fields.containsKey("#version") && !remote.fields.containsKey("#version")) return;
            if (!fields.containsKey("#version") && remote.fields.containsKey("#version")) {
                type = remote.type; rootClock = remote.rootClock;
                fields.clear(); fields.putAll(remote.fields); return;
            }
            LamportClock localVersion = fields.values().stream().map(FieldValue::writtenAt)
                    .max(LamportClock::compareTo).orElse(rootClock);
            LamportClock remoteVersion = remote.fields.values().stream().map(FieldValue::writtenAt)
                    .max(LamportClock::compareTo).orElse(remote.rootClock);
            String localId = fields.containsKey("#version") ? String.valueOf(fields.get("#version").value()) : "";
            String remoteId = remote.fields.containsKey("#version") ? String.valueOf(remote.fields.get("#version").value()) : "";
            int comparison = remoteVersion.compareTo(localVersion);
            if (comparison > 0 || (comparison == 0 && remoteId.compareTo(localId) > 0)) {
                type = remote.type;
                rootClock = remote.rootClock;
                fields.clear();
                fields.putAll(remote.fields);
            }
            return;
        }
        mergeIdentity(remote.type, remote.rootClock);
        remote.fields.forEach((name, fv) -> fields.merge(name, fv, FieldValue::mergeLww));
    }

    /** 快照/副本合并用防御性复制，避免两个 DocState 共享同一个可变 Element。 */
    public Element copy() {
        Element copy = new Element(id, type, rootClock);
        copy.fields.putAll(fields);
        return copy;
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
