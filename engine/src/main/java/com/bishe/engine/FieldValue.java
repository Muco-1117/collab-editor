package com.bishe.engine;

import java.util.Objects;

/**
 * 字段值 —— 一个可合并的最小单元：值 + 最后写入时钟（LWW 依据）。
 *
 * <p>字段级 LWW 的口径：当前持有值在满足 {@code my.writtenAt.compareTo(remote.writtenAt) < 0}
 * 时被远端覆盖；时钟更大者胜；时钟相等视为同一写操作（幂等，值应相同）。
 */
public final class FieldValue {

    private final Object value;
    private final LamportClock writtenAt;

    public FieldValue(Object value, LamportClock writtenAt) {
        // null 是带时钟的显式清除值，必须保留才能阻止更早的写入在乱序到达时复活字段。
        this.value = value;
        this.writtenAt = Objects.requireNonNull(writtenAt, "writtenAt");
    }

    public Object value() {
        return value;
    }

    public LamportClock writtenAt() {
        return writtenAt;
    }

    /**
     * 合并本字段与远端字段，返回 LWW 胜者（可能返回 this 或 remote）。
     */
    public FieldValue mergeLww(FieldValue remote) {
        if (remote == null) {
            return this;
        }
        return remote.writtenAt.compareTo(writtenAt) > 0 ? remote : this;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof FieldValue that)) {
            return false;
        }
        return writtenAt.equals(that.writtenAt)
                && Objects.equals(normalize(value), normalize(that.value));
    }

    @Override
    public int hashCode() {
        return Objects.hash(normalize(value), writtenAt);
    }

    /** 数字以 double 规范比较（1 vs 1.0 视为同值）。 */
    private static Object normalize(Object v) {
        if (v instanceof Number n) {
            return n.doubleValue();
        }
        return v;
    }

    @Override
    public String toString() {
        return value + "@" + writtenAt;
    }
}
