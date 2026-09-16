package com.bishe.engine;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 收敛性验证 —— 答辩核心实验的自动化版本。
 *
 * <p>实验模型：8 个虚拟副本（replica-0..7），1200+ 条随机操作（ADD/PUT/DELETE），
 * 每一条操作只「随机送达部分副本且顺序乱序」模拟网络延迟与乱序，最后全量补发；
 * 断言全部副本的状态哈希（SHA-256）一致 = 强收敛。
 *
 * <p>收敛的根本原因：字段级 LWW 合并是幂等 + 可交换 + 结合律的，同一操作集合
 * 无论以何种顺序/何种分片到达，最终每一字段的胜者唯一（时钟全序）。
 */
class ConvergenceTest {

    private static final int REPLICAS = 8;
    private static final int OPS = 500;
    private static final int ELEMENT_POOL = 120;
    private static final long SEED = 20260915L;

    private static final List<String> FIELDS = List.of("text", "title", "x", "y", "color", "columnId");

    private final Map<String, Long> clockByReplica = new HashMap<>();
    private long nextClock = 0;

    private synchronized long nextClock() {
        return ++nextClock;
    }

    private String replica(int i) {
        return "replica-" + i;
    }

    private final Map<String, ElementType> typeById = new HashMap<>();

    /** 生成一条随机操作（维护 existsPool 保证 PUT/DELETE 命中已存在元素）。 */
    private Op randomOp(Random rnd, Set<String> exists) {
        String id = "el-" + rnd.nextInt(ELEMENT_POOL);
        int kind = rnd.nextInt(10);
        // 同一元素 type 自创建起固定（PUT/DELETE 沿用登记值 → 乱序到达也一致）
        ElementType type = typeById.computeIfAbsent(id,
                k -> ElementType.values()[rnd.nextInt(ElementType.values().length)]);
        // 以随机 replica 的身份产生时钟：同 replica 单调递增，跨 replica 交织
        String replica = replica(rnd.nextInt(REPLICAS));
        long c = clockByReplica.merge(replica, 1L, Long::sum);
        LamportClock clock = new LamportClock(replica, c);
        if (kind < 3 || !exists.contains(id)) {
            exists.add(id);
            return Op.add(id, type, clock);
        } else if (kind < 8) {
            String field = FIELDS.get(rnd.nextInt(FIELDS.size()));
            Object value = switch (rnd.nextInt(3)) {
                case 0 -> "值-" + rnd.nextInt(100000);
                case 1 -> rnd.nextInt(1000);
                default -> rnd.nextBoolean();
            };
            return Op.put(id, type, field, value, clock);
        } else {
            return Op.delete(id, type, clock);
        }
    }

    private long nextLamport() {
        return nextClock();
    }

    @Test
    void eightReplicasConvergeAfterPartialBroadcast() {
        for (int round = 0; round < 3; round++) {
            long seed = SEED + round;
            Random rnd = new Random(seed);
            Set<String> exists = new HashSet<>();
            List<Op> allOps = new ArrayList<>();
            for (int i = 0; i < OPS; i++) {
                allOps.add(randomOp(rnd, exists));
            }

            // 1) 每个副本只收到随机子集且顺序乱序
            List<DocState> replicas = new ArrayList<>();
            for (int r = 0; r < REPLICAS; r++) {
                DocState st = new DocState(replica(r));
                for (Op op : allOps) {
                    if (rnd.nextInt(100) < 70) {         // 70% 概率到达
                        st.apply(op);
                    }
                }
                replicas.add(st);
            }

            // 2) 最终全量同步：每 op 广播给所有副本（乱序一次）
            for (DocState st : replicas) {
                List<Op> shuffled = new ArrayList<>(allOps);
                Collections.shuffle(shuffled, new Random(seed + 777));
                shuffled.forEach(st::apply);
            }

            // 3) 收敛断言：所有副本状态哈希一致 + 元素数一致
            String h0 = replicas.get(0).canonicalHash();
            int size0 = replicas.get(0).size();
            for (int r = 1; r < REPLICAS; r++) {
                assertEquals(h0, replicas.get(r).canonicalHash(),
                        "round=" + round + " replica" + r + " 状态未收敛");
                assertEquals(size0, replicas.get(r).size());
                assertTrue(size0 > 0, "有元素被创建");
            }
            // 抽样断言：同 id 元素逐字段一致（取 exists 中必然存在的样例 id）
            String sampleId = exists.iterator().next();
            var el0 = replicas.get(0).element(sampleId);
            for (int r = 1; r < REPLICAS; r++) {
                var elr = replicas.get(r).element(sampleId);
                assertEquals(el0.fields().keySet(), elr.fields().keySet(), "字段集合一致（sample " + sampleId + "）");
                el0.fields().forEach((k, v) -> assertEquals(v, elr.fields().get(k), "字段 " + k + " 收敛"));
            }
        }
    }

    @Test
    void partitionMergeConverges() {
        // 网络分区：A 组 4 副本、B 组 4 副本各自独立应用全部 op，随后合并
        Random rnd = new Random(424242);
        Set<String> exists = new HashSet<>();
        List<Op> ops = new ArrayList<>();
        for (int i = 0; i < 800; i++) {
            ops.add(randomOp(rnd, exists));
        }
        DocState grpA = new DocState("group-A"), grpB = new DocState("group-B");
        for (Op op : ops) {
            grpA.apply(op);
            grpB.apply(op);
        }
        // 分区期间各自又产生 200 条新 op 互相不可见
        for (int i = 0; i < 200; i++) {
            grpA.apply(randomOp(rnd, exists));
        }
        for (int i = 0; i < 250; i++) {
            grpB.apply(randomOp(rnd, exists));
        }
        String ha = grpA.canonicalHash(), hb = grpB.canonicalHash();
        assertTrue(!ha.equals(hb), "分区期间哈希应不同（各自持有对方未见的变化）");

        // 断线恢复 = 快照互推（mergeState 全量）
        grpA.mergeState(grpB);
        grpB.mergeState(grpA);
        grpA.mergeState(grpB);

        assertEquals(grpA.canonicalHash(), grpB.canonicalHash(),
                "重连合并后 A/B 两组收敛");
    }

    @Test
    void identicalOpSetAnyOrderConverges() {
        // 同一 op 集合两种截然不同的到达顺序 → 状态一致（乱序收敛）
        Random rnd = new Random(SEED + 1);
        Set<String> exists = new HashSet<>();
        List<Op> ops = new ArrayList<>();
        for (int i = 0; i < 600; i++) {
            ops.add(randomOp(rnd, exists));
        }
        DocState ordered = new DocState("ordered");
        ops.forEach(ordered::apply);

        DocState reversed = new DocState("reversed");
        List<Op> rev = new ArrayList<>(ops);
        Collections.reverse(rev);
        rev.forEach(reversed::apply);

        DocState interleaved = new DocState("interleaved");
        List<Op> odd = new ArrayList<>(), even = new ArrayList<>();
        for (int i = 0; i < ops.size(); i++) {
            (i % 2 == 0 ? even : odd).add(ops.get(i));
        }
        even.forEach(interleaved::apply);
        odd.forEach(interleaved::apply);   // 先偶后奇（一种交错顺序）

        assertEquals(ordered.canonicalHash(), reversed.canonicalHash(), "逆序到达仍收敛");
        assertEquals(ordered.canonicalHash(), interleaved.canonicalHash(), "交错到达仍收敛");
    }
}