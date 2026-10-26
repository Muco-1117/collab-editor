package com.bishe.server.history;

import com.bishe.engine.Element;
import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.store.OpStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest
@ActiveProfiles("test")
class HistoryServiceRestoreTest {

    @Autowired
    HistoryService history;

    @Autowired
    OpStore store;

    @Autowired
    JdbcTemplate jdbc;

    private final String doc = "history-restore-" + UUID.randomUUID().toString().substring(0, 8);

    @AfterEach
    void clean() {
        jdbc.update("DELETE FROM operation_log WHERE doc_id=?", doc);
        jdbc.update("DELETE FROM element_snapshot WHERE doc_id=?", doc);
    }

    @Test
    void clearsFieldsResurrectsTombstonesAndCanRestoreBackAndForth() {
        append(List.of(
                Op.add("e1", ElementType.TEXT, new LamportClock("user", 1)),
                Op.put("e1", ElementType.TEXT, "text", "v1", new LamportClock("user", 2))));
        int revV1 = 2;

        append(List.of(
                Op.put("e1", ElementType.TEXT, "text", "v2", new LamportClock("user", 3)),
                Op.put("e1", ElementType.TEXT, "extra", "later", new LamportClock("user", 4)),
                Op.delete("e1", ElementType.TEXT, new LamportClock("user", 5))));
        int revDeleted = 5;

        List<Op> firstRestore = history.restoreOps(doc, revV1);
        assertTrue(firstRestore.stream().allMatch(op -> op.clock().counter() > 5));
        assertTrue(firstRestore.stream().allMatch(op -> op.clock().counter() < 1_000));
        append(firstRestore);
        assertVisibleVersion("v1", false);

        List<Op> secondRestore = history.restoreOps(doc, revDeleted);
        long firstMax = firstRestore.stream().mapToLong(op -> op.clock().counter()).max().orElseThrow();
        assertTrue(secondRestore.stream().allMatch(op -> op.clock().counter() > firstMax));
        append(secondRestore);
        assertVisibleVersion("v2", true);

        List<Op> thirdRestore = history.restoreOps(doc, revV1);
        long secondMax = secondRestore.stream().mapToLong(op -> op.clock().counter()).max().orElseThrow();
        assertTrue(thirdRestore.stream().allMatch(op -> op.clock().counter() > secondMax));
        append(thirdRestore);
        assertVisibleVersion("v1", false);
    }

    private void append(List<Op> ops) {
        long seq = store.maxSeq(doc);
        for (Op op : ops) {
            store.appendOps(doc, List.of(op), ++seq);
        }
    }

    private void assertVisibleVersion(String text, boolean deleted) {
        JsonNode element = null;
        for (JsonNode candidate : history.replay(doc, (int) store.maxSeq(doc))) {
            if ("e1".equals(candidate.path("id").asText())) {
                element = candidate;
                break;
            }
        }
        assertTrue(element != null, "回放应包含 e1");
        assertEquals(text, element.path("fields").path("text").path("value").asText());
        JsonNode extra = element.path("fields").path("extra").path("value");
        JsonNode tombstone = element.path("fields").path(Element.TOMBSTONE_KEY).path("value");
        if (deleted) {
            assertEquals("later", extra.asText());
            assertTrue(tombstone.asBoolean());
        } else {
            assertTrue(extra.isNull(), "旧版本中不存在的字段应被显式清除");
            assertTrue(tombstone.isNull(), "恢复删除前版本应清除墓碑");
            assertFalse(tombstone.asBoolean());
        }
    }
}
