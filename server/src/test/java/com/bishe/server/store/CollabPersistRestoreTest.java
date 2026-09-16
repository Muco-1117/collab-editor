package com.bishe.server.store;

import com.bishe.engine.Element;
import com.bishe.engine.ElementType;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.ws.CollabRoom;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * M2 持久化验收核心：杀服务 → 重建 → 文档状态完整。
 *
 * <p>模拟「进程重启」= 用同一 OpStore 重新构造 CollabRoom（构造器即
 * 快照恢复 + 日志回放），断言状态哈希与 rev 与停机前完全一致。
 */
@SpringBootTest
@ActiveProfiles("local")
class CollabPersistRestoreTest {

    @Autowired
    OpStore store;

    @Autowired
    JdbcTemplate jdbc;

    final String doc = "m2-restore-test";

    @BeforeEach
    void clean() {
        jdbc.update("DELETE FROM operation_log WHERE doc_id=?", doc);
        jdbc.update("DELETE FROM element_snapshot WHERE doc_id=?", doc);
    }

    @Test
    void restoreAfterSimulatedRestart() {
        // ---- 1) 第一代 Room：写入一批操作 ----
        CollabRoom first = new CollabRoom(doc, store);
        long c = 0;
        Op put1 = Op.put("el-1", ElementType.TEXT, "text", "第一行内容", new LamportClock("user-a", ++c));
        Op put2 = Op.put("el-1", ElementType.TEXT, "text", "第二版内容", new LamportClock("user-b", ++c));
        Op add = Op.add("el-2", ElementType.CARD, new LamportClock("user-a", ++c));
        Op move = Op.put("el-2", ElementType.CARD, "x", 42, new LamportClock("user-b", ++c));
        for (Op op : List.of(put1, put2, add, move)) {
            first.applyOp(op);
        }
        // 压到快照阈值 ×2，强制产出快照
        for (int i = 0; i < 70; i++) {
            first.applyOp(Op.put("b-" + i, ElementType.TEXT, "text", "填充" + i,
                    new LamportClock("user-a", 1000 + i)));
        }
        long revBefore = first.currentRev();
        String hashBefore = first.state().canonicalHash();
        assertEquals(74, revBefore, "rev=操作总数");
        String snapCount = jdbc.queryForObject(
                "SELECT COUNT(*) FROM element_snapshot WHERE doc_id=?", String.class, doc);
        assertTrue(Integer.parseInt(snapCount) >= 1, "快照已落库（rev=64 阈值已触发）");

        // ---- 2) 模拟进程重启：全新构造（走快照 + 日志回放） ----
        CollabRoom second = new CollabRoom(doc, store);

        assertEquals(revBefore, second.currentRev(), "重启后 rev 恢复");
        assertEquals(hashBefore, second.state().canonicalHash(), "重启后状态完全一致");
        assertEquals("第二版内容",
                second.state().element("el-1").fields().get("text").value(), "字段值完整恢复");
        assertEquals(42L,
                ((Number) second.state().element("el-2").fields().get("x").value()).longValue(),
                "数字字段恢复");

        // ---- 3) 增量续传窗口在重启后仍完整（最后 3 条可补） ----
        assertEquals(3, second.opsAfter(revBefore - 3).size(), "重启后增量窗口可用");
    }
}