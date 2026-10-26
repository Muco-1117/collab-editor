package com.bishe.engine;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * 文档状态（副本状态机）—— 协同引擎的宿主。
 *
 * <p>新版 STATE 按完整元素的 (clock, opId) 合并，旧 ADD/PUT/DELETE 可回放。
 * 元素一旦迁移到新版，旧字段操作不再影响它；同一组有效操作送达后状态收敛。
 */
public final class DocState {

    private final String replicaId;
    private final Map<String, Element> elements = new LinkedHashMap<>();

    public DocState(String replicaId) {
        this.replicaId = replicaId;
    }

    public String replicaId() {
        return replicaId;
    }

    public Map<String, Element> elements() {
        return elements;
    }

    public int size() {
        return elements.size();
    }

    public Element element(String id) {
        return elements.get(id);
    }

    /** 快照恢复用：把已反序列化的元素整体放入状态（不比对时钟，快照即权威）。 */
    public void putRestoredElement(Element el) {
        elements.put(el.id(), el.copy());
    }

    /** 应用一条操作（幂等、可乱序）。 */
    public void apply(Op op) {
        switch (op.type()) {
            case STATE -> {
                Element previous = elements.get(op.elementId());
                // v2 完整状态优先于兼容的 v1 字段日志；迁移后不能混入迟到的字段写。
                LamportClock version = previous == null || !previous.fields().containsKey("#version")
                        ? null : previous.fields().get("#version").writtenAt();
                String previousId = previous != null && previous.fields().containsKey("#version")
                        ? String.valueOf(previous.fields().get("#version").value()) : "";
                int order = version == null ? 1 : op.clock().compareTo(version);
                if (order > 0 || (order == 0 && op.field().compareTo(previousId) > 0)) {
                    Element replacement = new Element(op.elementId(), op.elementType(), op.clock());
                    @SuppressWarnings("unchecked")
                    Map<String, Object> values = (Map<String, Object>) op.value();
                    values.forEach((key, value) -> replacement.putField(key, value, op.clock()));
                    replacement.putField("#version", op.field(), op.clock());
                    elements.put(op.elementId(), replacement);
                }
            }
            case ADD -> {
                Element existing = elements.get(op.elementId());
                if (existing != null && existing.fields().containsKey("#version")) return;
                if (existing == null) {
                    elements.put(op.elementId(),
                            new Element(op.elementId(), op.elementType(), op.clock()));
                } else {
                    existing.mergeIdentity(op.elementType(), op.clock());
                }
            }
            case PUT, DELETE -> {
                Element el = elements.get(op.elementId());
                if (el != null && el.fields().containsKey("#version")) return;
                if (el == null) {
                    // 先到后序写 op：自动补建元素（op 携带的类型参与，
                    // 保证与 ADD 先到时创建的 type 一致 → 状态与到达顺序无关）
                    ElementType t = op.elementType() != null ? op.elementType() : ElementType.TEXT;
                    el = new Element(op.elementId(), t, op.clock());
                    elements.put(op.elementId(), el);
                } else {
                    // 每条 op 都携带类型声明；冲突时也必须与到达顺序无关。
                    el.mergeIdentity(op.elementType(), op.clock());
                }
                el.putField(op.type() == Op.Type.DELETE ? Element.TOMBSTONE_KEY : op.field(),
                        op.type() == Op.Type.DELETE ? Boolean.TRUE : op.value(), op.clock());
            }
            default -> throw new IllegalStateException("unreachable");
        }
    }

    /** 合并来自远端副本的整份状态（快照同步场景）。 */
    public void mergeState(DocState remote) {
        remote.elements.forEach((id, remoteEl) -> {
            Element local = elements.get(id);
            if (local == null) {
                elements.put(id, remoteEl.copy());
            } else {
                // 字段级 LWW 自行裁决（含迟到远端字段、迟到本地字段）
                local.merge(remoteEl);
            }
        });
    }

    /**
     * 规范哈希：全部元素（含墓碑）按 id 字典序拼接后 SHA-256。
     * 两个副本 canonicalHash 相等 ⇔ 状态一致（收敛判据）。
     */
    public String canonicalHash() {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            var sorted = new TreeMap<>(elements);
            sorted.forEach((id, el) -> md.update(el.toCanonicalString().getBytes(StandardCharsets.UTF_8)));
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : d) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
