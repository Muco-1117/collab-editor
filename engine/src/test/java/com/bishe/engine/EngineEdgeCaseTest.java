package com.bishe.engine;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;

class EngineEdgeCaseTest {

    @Test
    void nullIsAClockedClearThatOlderWritesCannotResurrect() {
        Op value = Op.put("e1", ElementType.TEXT, "text", "before", new LamportClock("a", 1));
        Op clear = Op.put("e1", ElementType.TEXT, "text", null, new LamportClock("a", 2));

        DocState ordered = new DocState("ordered");
        List.of(value, clear).forEach(ordered::apply);
        DocState reversed = new DocState("reversed");
        List.of(clear, value).forEach(reversed::apply);

        assertNull(ordered.element("e1").fields().get("text").value());
        assertEquals(new LamportClock("a", 2), ordered.element("e1").fields().get("text").writtenAt());
        assertEquals(ordered.canonicalHash(), reversed.canonicalHash());
    }

    @Test
    void conflictingElementTypesConvergeInAnyArrivalOrder() {
        List<Op> ops = List.of(
                Op.add("same-id", ElementType.TEXT, new LamportClock("a", 1)),
                Op.add("same-id", ElementType.CARD, new LamportClock("b", 1)),
                Op.put("same-id", ElementType.COLUMN, "title", "最终类型", new LamportClock("a", 2)));

        DocState forward = new DocState("forward");
        ops.forEach(forward::apply);
        DocState reverse = new DocState("reverse");
        for (int i = ops.size() - 1; i >= 0; i--) {
            reverse.apply(ops.get(i));
        }

        assertEquals(ElementType.COLUMN, forward.element("same-id").type());
        assertEquals(forward.canonicalHash(), reverse.canonicalHash());
    }

    @Test
    void mergeStateCopiesElementsInsteadOfSharingMutableReferences() {
        DocState remote = new DocState("remote");
        remote.apply(Op.put("e1", ElementType.TEXT, "text", "v1", new LamportClock("r", 1)));

        DocState local = new DocState("local");
        local.mergeState(remote);
        assertNotSame(remote.element("e1"), local.element("e1"));

        remote.apply(Op.put("e1", ElementType.TEXT, "text", "v2", new LamportClock("r", 2)));
        assertEquals("v1", local.element("e1").fields().get("text").value());
        assertEquals("v2", remote.element("e1").fields().get("text").value());
    }
}
