package com.bishe.engine;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Lamport 时钟基本性质：严格全序、可观察推进、自反相等/传递性。
 */
class LamportClockTest {

    @Test
    void counterOrderThenReplicaIdTiebreak() {
        LamportClock a1 = new LamportClock("A", 1);
        LamportClock b1 = new LamportClock("B", 1);
        LamportClock a2 = new LamportClock("A", 2);

        assertTrue(a1.compareTo(a2) < 0, "counter 大者新");
        assertTrue(b1.compareTo(a1) > 0, "counter 相同按 replicaId 字典序（B>A）");
        assertTrue(a1.compareTo(b1) < 0);
        assertTrue(a1.compareTo(a1) == 0, "自反");
        // 传递性的具体例：a1(1) < a2(2)，且 b1(1) < a2(2) → 大 counter 恒赢
        assertTrue(a2.compareTo(b1) > 0, "counter 2 > counter 1 时无论 replica 都必须更大");
    }

    @Test
    void observeAdvancesToMaxPlusOne() {
        LamportClock local = new LamportClock("L", 3);
        LamportClock farAhead = new LamportClock("R", 100);
        LamportClock advanced = local.observe(farAhead);
        assertEquals(101, advanced.counter());
        assertEquals("L", advanced.replicaId());
        assertEquals(4, local.observe(new LamportClock("R", 3)).counter(),
                "counter 相等时 observe 取 max(3,3)+1 = 4");
    }

    @Test
    void clockTotalOrderAcrossRandomSet() {
        List<LamportClock> clocks = new ArrayList<>();
        for (int i = 0; i < 40; i++) {
            clocks.add(new LamportClock("R" + (i % 7), i * 3 % 17));
        }
        for (int i = 0; i < clocks.size(); i++) {
            for (int j = 0; j < clocks.size(); j++) {
                int cmp = clocks.get(i).compareTo(clocks.get(j));
                assertEquals(-cmp, clocks.get(j).compareTo(clocks.get(i)), "反对称");
                if (i != j) {
                    assertNotEquals(0, cmp, "全序：任意两不同时钟必有大小");
                }
            }
        }
    }

    @Test
    void encodeRoundTrip() {
        LamportClock c = new LamportClock("replica-X", 42);
        assertEquals(c, LamportClock.parse(c.toString()));
    }

    @Test
    void sortedByTimestampEqualsLamportOrder() {
        // 事件时间的偏序蕴含于时钟序：counter 小的必然先于大的
        List<LamportClock> clocks = List.of(
                new LamportClock("R3", 9), new LamportClock("R1", 5), new LamportClock("R2", 9));
        List<LamportClock> sorted = new ArrayList<>(clocks);
        sorted.sort(Comparator.naturalOrder());
        assertEquals(5, sorted.get(0).counter());
        assertEquals(9, sorted.get(1).counter());
        assertEquals(9, sorted.get(2).counter());
        assertTrue(sorted.get(1).compareTo(sorted.get(2)) != 0, "同 counter 不同 replica 仍需分序");
    }
}