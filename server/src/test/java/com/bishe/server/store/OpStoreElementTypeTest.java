package com.bishe.server.store;

import com.bishe.engine.Element;
import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.ws.CollabRoom;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

@SpringBootTest
@ActiveProfiles("test")
class OpStoreElementTypeTest {

    @Autowired
    OpStore store;

    @Autowired
    JdbcTemplate jdbc;

    private final String prefix = "type-store-" + UUID.randomUUID().toString().substring(0, 8);

    @AfterEach
    void clean() {
        jdbc.update("DELETE FROM operation_log WHERE doc_id LIKE ?", prefix + "%");
        jdbc.update("DELETE FROM element_snapshot WHERE doc_id LIKE ?", prefix + "%");
    }

    @Test
    void preservesTypesBeforeSnapshotAndInSnapshotTail() {
        String doc = prefix + "-restart";
        CollabRoom first = new CollabRoom(doc, store);
        first.applyOp(Op.add("early-card", ElementType.CARD, new LamportClock("u", 10)));
        first.applyOp(Op.add("early-column", ElementType.COLUMN, new LamportClock("u", 11)));

        CollabRoom beforeSnapshot = new CollabRoom(doc, store);
        assertEquals(ElementType.CARD, beforeSnapshot.state().element("early-card").type());
        assertEquals(ElementType.COLUMN, beforeSnapshot.state().element("early-column").type());

        long counter = 20;
        while (beforeSnapshot.currentRev() < 64) {
            beforeSnapshot.applyOp(Op.put("filler", ElementType.TEXT, "text",
                    "v" + counter, new LamportClock("u", counter++)));
        }
        beforeSnapshot.applyOp(Op.add("tail-card", ElementType.CARD, new LamportClock("u", counter++)));
        beforeSnapshot.applyOp(Op.add("tail-column", ElementType.COLUMN, new LamportClock("u", counter)));

        CollabRoom afterSnapshot = new CollabRoom(doc, store);
        assertEquals(ElementType.CARD, afterSnapshot.state().element("early-card").type());
        assertEquals(ElementType.COLUMN, afterSnapshot.state().element("early-column").type());
        assertEquals(ElementType.CARD, afterSnapshot.state().element("tail-card").type());
        assertEquals(ElementType.COLUMN, afterSnapshot.state().element("tail-column").type());
    }

    @Test
    void roundTripsNullAndKeepsLegacyRowsReadable() {
        String typedDoc = prefix + "-typed";
        List<Op> written = List.of(
                Op.add("card", ElementType.CARD, new LamportClock("u", 1)),
                Op.put("card", ElementType.CARD, "text", null, new LamportClock("u", 2)));
        store.appendOps(typedDoc, written, 1);

        List<Op> loaded = store.loadOpsAfter(typedDoc, 0);
        assertEquals(ElementType.CARD, loaded.get(0).elementType());
        assertEquals(ElementType.CARD, loaded.get(1).elementType());
        assertNull(loaded.get(1).value());

        String legacyDoc = prefix + "-legacy";
        Element legacyCard = new Element("legacy-card", ElementType.CARD, new LamportClock("old", 1));
        store.saveSnapshot(legacyDoc, 0, OpStore.encodeElements(List.of(legacyCard)));
        jdbc.update("""
                INSERT INTO operation_log(doc_id, element_id, element_type, field, value_json, clock, seq)
                VALUES(?, ?, NULL, ?, ?, ?, ?)
                """, legacyDoc, "legacy-card", "text", "\"旧日志仍可回放\"", "PUT|old:2", 1);

        CollabRoom restored = new CollabRoom(legacyDoc, store);
        assertEquals(ElementType.CARD, restored.state().element("legacy-card").type());
        assertEquals("旧日志仍可回放",
                restored.state().element("legacy-card").fields().get("text").value());
    }
}
