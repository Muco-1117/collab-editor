package com.bishe.engine;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 质量门：引擎收敛性大验证。
 *
 * <p>8 个副本、每轮 1000 条随机操作（ADD/PUT/DELETE 混合，有限值池制造 LWW 冲突），
 * 每条 op 随机分配归属副本、各副本内部递增 Lamport 计数（真实并发：不同副本计数可相同，
 * 由 (counter, replicaId) 全序决胜）。每个副本以【不同随机乱序】应用同一操作集——
 * 模拟网络乱序投递 —— 断言全部副本 canonicalHash 一致，且等于按时钟全序回放的结果。
 */
class ConvergenceStressTest {

    private static final int REPLICAS = 8;
    private static final int OPS = 1000;
    private static final String[] FIELD_POOL = {"text", "x", "y", "order"};
    private static final String[] TEXT_POOL = {"alpha", "beta", "gamma", "delta"};
    private static final long[] NUM_POOL = {1L, 2L, 3L};

    /** 元素 id 池游标（每个 ADD 分配新 id，从 e0 起）。 */
    private int nextId = 0;

    /** 每个元素的类型由创建者固定（协议不变量：type 不随 op 变化）。 */
    private final java.util.List<ElementType> elemTypes = new java.util.ArrayList<>();

    /** 生成一轮随机操作：ops 按「生成序」产出，每个 op 带其作者副本递增的时钟。 */
    private List<Op> generate(Random rnd, long[] authorCounters) {
        List<Op> ops = new ArrayList<>(OPS);
        int nextElem = 0;
        for (int i = 0; i < OPS; i++) {
            int author = rnd.nextInt(REPLICAS);
            LamportClock clock = new LamportClock("r" + author, ++authorCounters[author]);
            int roll = rnd.nextInt(100);
            String id;
            if (roll < 15) {
                // ADD 新元素（池按需增长）
                id = "e" + (nextId++);
                elemTypes.add(rnd.nextInt(2) == 0 ? ElementType.TEXT : ElementType.CARD);
                ops.add(Op.add(id, elemTypes.get(elemTypes.size() - 1), clock));
            } else {
                // 操作现有元素：随机挑（含未 ADD 先 PUT 的乱序场景）
                id = "e" + rnd.nextInt(Math.max(1, nextId));
                ElementType t = Integer.parseInt(id.substring(1)) < elemTypes.size()
                        ? elemTypes.get(Integer.parseInt(id.substring(1))) : ElementType.TEXT;
                if (roll < 90) {
                    ops.add(Op.put(id, t,
                            FIELD_POOL[rnd.nextInt(FIELD_POOL.length)],
                            rnd.nextInt(2) == 0 ? TEXT_POOL[rnd.nextInt(TEXT_POOL.length)]
                                    : NUM_POOL[rnd.nextInt(NUM_POOL.length)],
                            clock));
                } else {
                    ops.add(Op.delete(id, t, clock));
                }
            }
        }
        return ops;
    }

    @Test
    void convergesUnderRandomOrdering() {
        for (int round = 0; round < 3; round++) {
            Random rnd = new Random(20260916L + round);

            // 各副本独立递增计数器（真实并发）
            long[] authorCounters = new long[REPLICAS];

            List<Op> ops = generate(rnd, authorCounters);

            // 标准答案：按时钟全序（counter, replicaId）回放
            List<Op> sorted = new ArrayList<>(ops);
            sorted.sort((a, b) -> a.clock().compareTo(b.clock()));
            DocState oracle = new DocState("oracle");
            sorted.forEach(oracle::apply);

            // 8 副本各自乱序应用（不同种子 → 不同到达顺序）
            List<DocState> replicas = new ArrayList<>();
            for (int r = 0; r < REPLICAS; r++) {
                List<Op> copy = new ArrayList<>(ops);
                Collections.shuffle(copy, new Random(rnd.nextLong()));
                DocState st = new DocState("r" + r);
                copy.forEach(st::apply);
                replicas.add(st);
            }

            // 全部收敛
            String h = replicas.get(0).canonicalHash();
            for (DocState st : replicas) {
                if (!h.equals(st.canonicalHash())) {
                    System.out.println("[诊断] 副本 " + st.replicaId() + " 与 副本 r0 不一致，差异元素：");
                    st.elements().forEach((id, el) -> {
                        Element e0 = replicas.get(0).element(id);
                        if (e0 != null && !e0.toCanonicalString().equals(el.toCanonicalString())) {
                            System.out.println("  " + id + "\n    r0: " + e0.toCanonicalString()
                                    + "\n    " + st.replicaId() + ": " + el.toCanonicalString());
                        }
                    });
                }
                assertEquals(h, st.canonicalHash(), "round " + round + " 副本未收敛");
            }
            // 3) 与时钟全序回放一致
            assertEquals(oracle.canonicalHash(), h, "round " + round + " 乱序结果偏离全序结果");

            // 4) 有足够 LWW 冲突（并发副本同 counter → (counter,replica) 决胜被真实触发）
            long distinctCounters = sorted.stream().map(op -> op.clock().counter()).distinct().count();
            assertTrue(distinctCounters < OPS, "本轮未产生并发碰撞，测试失真");
            System.out.println("[收敛] 轮" + round + ": " + OPS + " ops / 副本" + REPLICAS
                    + " 乱序收敛一致 · 并发碰撞 " + (OPS - distinctCounters) + " 次 → " + h.substring(0, 12));
        }
    }
}