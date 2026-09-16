package com.bishe.engine;

import java.util.Objects;

/**
 * Lamport 逻辑时钟（全序）。
 *
 * <p>比较规则：(counter, replicaId) 字典序 —— counter 大者新；counter 相同以
 * replicaId 打破平局，保证分布式 replica 之间的操作存在唯一的全序。
 */
public final class LamportClock implements Comparable<LamportClock> {

    private final String replicaId;
    private final long counter;

    public LamportClock(String replicaId, long counter) {
        this.replicaId = Objects.requireNonNull(replicaId);
        this.counter = counter;
    }

    public String replicaId() {
        return replicaId;
    }

    public long counter() {
        return counter;
    }

    /** 在本地时钟基础上前进一步，产生新的写入时钟。 */
    public LamportClock tick() {
        return new LamportClock(replicaId, counter + 1);
    }

    /** 吸收一个远端时钟：本地计数取 max(local, remote)+1，用于接收事件后的推进。 */
    public LamportClock observe(LamportClock remote) {
        return new LamportClock(replicaId, Math.max(counter, remote.counter) + 1);
    }

    @Override
    public int compareTo(LamportClock o) {
        int c = Long.compare(counter, o.counter);
        return c != 0 ? c : replicaId.compareTo(o.replicaId);
    }

    /** 时钟编码（协议报文 / 持久化用）："{replicaId}:{counter}" */
    @Override
    public String toString() {
        return replicaId + ":" + counter;
    }

    /** 从编码串还原。 */
    public static LamportClock parse(String s) {
        int i = s.lastIndexOf(':');
        return new LamportClock(s.substring(0, i), Long.parseLong(s.substring(i + 1)));
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof LamportClock that)) {
            return false;
        }
        return counter == that.counter && replicaId.equals(that.replicaId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(replicaId, counter);
    }
}