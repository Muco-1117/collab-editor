package com.bishe.engine;

/**
 * 自研协同引擎入口。
 *
 * <p>里程碑 T0+2 在此落地：统一元素模型（Element / fields / Lamport clock / tombstone）、
 * v2 元素级 LWW 合并，兼容 v1 字段日志；通过重复、乱序与快照合并验证收敛。
 */
public final class Engine {

    private Engine() {
    }

    /** 引擎代号，供健康检查与日志展示。 */
    public static String id() {
        return "bishe-collab-engine@0.2.0";
    }
}
