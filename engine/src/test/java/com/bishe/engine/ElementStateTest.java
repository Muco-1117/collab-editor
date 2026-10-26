package com.bishe.engine;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ElementStateTest {
    @Test void fullElementWritesConvergeAcrossReorderingDuplicatesAndSnapshots() {
        List<Op> operations = new ArrayList<>();
        ElementType[] types = {ElementType.TEXT, ElementType.IMAGE, ElementType.CARD};
        for (int n = 1; n <= 180; n++) {
            int index = n % 3;
            operations.add(Op.state("element-" + index, types[index],
                    Map.of("text", "版本" + n, "assetId", "asset-" + n, "x", n,
                            Element.TOMBSTONE_KEY, n % 7 == 0), "op-" + n,
                    new LamportClock("replica-" + n % 4, n)));
        }
        DocState expected = new DocState("expected"); operations.forEach(expected::apply);
        for (int seed = 0; seed < 20; seed++) {
            List<Op> shuffled = new ArrayList<>(operations); shuffled.addAll(operations);
            Collections.shuffle(shuffled, new Random(seed));
            DocState replica = new DocState("random"); shuffled.forEach(replica::apply);
            assertEquals(expected.canonicalHash(), replica.canonicalHash());
            DocState merged = new DocState("snapshot"); merged.mergeState(replica);
            assertEquals(expected.canonicalHash(), merged.canonicalHash());
        }
    }
    @Test void concurrentWriteReplacesWholeElementAndOperationIdBreaksEqualClock() {
        Op a = Op.state("image", ElementType.IMAGE, Map.of("assetId", "a", "x", 10), "a", new LamportClock("r", 1));
        Op b = Op.state("image", ElementType.IMAGE, Map.of("assetId", "b"), "b", new LamportClock("r", 1));
        DocState left = new DocState("left"), right = new DocState("right");
        left.apply(a); left.apply(b); right.apply(b); right.apply(a);
        assertEquals(left.canonicalHash(), right.canonicalHash());
        assertFalse(left.element("image").fields().containsKey("x"));
        assertEquals("b", left.element("image").fields().get("assetId").value());
    }
    @Test void newStateMigratesLegacyFieldStateAndDeletesRemainVersioned() {
        DocState state = new DocState("legacy");
        state.apply(Op.put("p", ElementType.TEXT, "obsolete", "old", new LamportClock("old", 1)));
        state.apply(Op.state("p", ElementType.TEXT, Map.of("text", "new"), "s2", new LamportClock("new", 2)));
        state.apply(Op.put("p", ElementType.TEXT, "late-legacy", "ignored", new LamportClock("old", 999)));
        assertFalse(state.element("p").fields().containsKey("late-legacy"));
        assertFalse(state.element("p").fields().containsKey("obsolete"));
        state.apply(Op.state("p", ElementType.TEXT, Map.of(Element.TOMBSTONE_KEY, true), "s3", new LamportClock("new", 3)));
        state.apply(Op.state("p", ElementType.TEXT, Map.of("text", "stale"), "s2", new LamportClock("new", 2)));
        assertTrue(state.element("p").isTombstone());
    }
}
