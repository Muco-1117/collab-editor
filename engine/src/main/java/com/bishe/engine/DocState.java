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
 * <p>状态 = 元素集合 + 各元素字段级 LWW 视图。apply(Op) 幂等且可乱序：
 * 最终一致性由字段级 LWW（时钟全序）保证——任意两个副本在「收到相同操作集」
 * 之后必然收敛（这就是收敛性测试断言的内容）。
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

    /** 应用一条操作（幂等、可乱序）。 */
    public void apply(Op op) {
        switch (op.type()) {
            case ADD -> {
                Element existing = elements.get(op.elementId());
                if (existing == null) {
                    elements.put(op.elementId(),
                            new Element(op.elementId(), op.elementType(), op.clock()));
                }
                // 已存在：ADD 幂等忽略（字段级写由 PUT 自行管）
            }
            case PUT, DELETE -> {
                Element el = elements.get(op.elementId());
                if (el == null) {
                    // 先到后序写 op：自动补建元素（op 携带的类型参与，
                    // 保证与 ADD 先到时创建的 type 一致 → 状态与到达顺序无关）
                    ElementType t = op.elementType() != null ? op.elementType() : ElementType.TEXT;
                    el = new Element(op.elementId(), t, op.clock());
                    elements.put(op.elementId(), el);
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
                elements.put(id, remoteEl);
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