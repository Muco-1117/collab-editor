package com.bishe.engine;

/**
 * 自研协同引擎入口（脚手架占位）。
 *
 * <p>里程碑 T0+2 在此落地：统一元素模型（Element / fields / Lamport clock / tombstone）、
 * LWW 字段级合并引擎、收敛性 JUnit 验证（1000 随机操作断言收敛）。
 * 当前仅为「可编译的占位」，保证多模块父子依赖先跑通。
 */
public final class Engine {

    private Engine() {
    }

    /** 引擎代号，供健康检查与日志展示。 */
    public static String id() {
        return "bishe-collab-engine@0.1.0-skeleton";
    }
}