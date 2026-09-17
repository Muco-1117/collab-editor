package com.bishe.server.web;

import com.bishe.engine.Op;
import com.bishe.server.auth.AuthService;
import com.bishe.server.history.HistoryService;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.OpStore;
import com.bishe.server.store.SpaceRepo;
import com.bishe.server.ws.CollabRoom;
import com.bishe.server.ws.RoomRegistry;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * T0+10 产品能力：历史（时间线/回放/恢复）、Markdown 导出、搜索、统计。
 */
@RestController
@RequestMapping("/api")
public class ProductController {

    private final HistoryService history;
    private final DocRepo docs;
    private final SpaceRepo spaces;
    private final OpStore store;
    private final RoomRegistry registry;

    public ProductController(HistoryService history, DocRepo docs, SpaceRepo spaces,
                             OpStore store, RoomRegistry registry) {
        this.history = history;
        this.docs = docs;
        this.spaces = spaces;
        this.store = store;
        this.registry = registry;
    }

    private AuthService.UserPub me() {
        var a = SecurityContextHolder.getContext().getAuthentication();
        return a != null && a.getPrincipal() instanceof AuthService.UserPub u ? u : null;
    }

    /** 空间成员校验；非成员返回 null。 */
    private AuthService.UserPub guard(String docKey) {
        AuthService.UserPub u = me();
        if (u == null) return null;
        long sid = docs.spaceIdOf(docKey);
        if (sid < 0) return u;
        return spaces.roleOf(sid, u.id()) == null ? null : u;
    }

    private ResponseEntity<Map<String, String>> forbidden() {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "无权访问该文档"));
    }

    /* ---------- 历史 ---------- */

    @GetMapping("/docs/{docKey}/history")
    public ResponseEntity<?> history(@PathVariable("docKey") String docKey,
                                     @RequestParam(value = "limit", defaultValue = "20") int limit) {
        if (guard(docKey) == null) return forbidden();
        return ResponseEntity.ok(Map.of(
                "rev", store.maxSeq(docKey),
                "ops", history.timeline(docKey, limit)));
    }

    @GetMapping("/docs/{docKey}/replay")
    public ResponseEntity<?> replay(@PathVariable("docKey") String docKey, @RequestParam(value = "rev") int rev) {
        if (guard(docKey) == null) return forbidden();
        long max = store.maxSeq(docKey);
        if (rev < 0 || rev > max) {
            return ResponseEntity.badRequest().body(Map.of("msg", "rev 超界 [0," + max + "]"));
        }
        return ResponseEntity.ok(Map.of("rev", rev, "elements", history.replay(docKey, rev)));
    }

    @PostMapping("/docs/{docKey}/restore")
    public ResponseEntity<?> restore(@PathVariable("docKey") String docKey,
                                     @RequestBody Map<String, Object> body) {
        if (guard(docKey) == null) return forbidden();
        int rev = body.get("rev") instanceof Number n ? n.intValue() : -1;
        long max = store.maxSeq(docKey);
        if (rev < 0 || rev > max) {
            return ResponseEntity.badRequest().body(Map.of("msg", "rev 超界 [0," + max + "]"));
        }
        List<Op> ops = history.restoreOps(docKey, rev);
        CollabRoom room = registry.get(docKey);
        if (room != null) {
            room.applyExternal(ops);
        } else {
            long seq = store.maxSeq(docKey);
            for (Op op : ops) {
                store.appendOps(docKey, List.of(op), ++seq);
            }
        }
        return ResponseEntity.ok(Map.of("msg", "已恢复到 rev=" + rev, "ops", ops.size(),
                "rev", store.maxSeq(docKey)));
    }

    /* ---------- Markdown 导出 ---------- */

    @GetMapping(value = "/docs/{docKey}/export", produces = "text/markdown; charset=UTF-8")
    public ResponseEntity<?> export(@PathVariable("docKey") String docKey) {
        if (guard(docKey) == null) return forbidden();
        StringBuilder sb = new StringBuilder();
        Map<String, Object> meta = docs.get(docKey);
        if (meta != null) {
            sb.append("# ").append(meta.get("title")).append("\n\n");
            sb.append("> 空间：").append(meta.get("space_name")).append(" · 导出：")
                    .append(java.time.LocalDate.now()).append("\n\n");
        }
        int rev = (int) store.maxSeq(docKey);
        for (JsonNode el : history.replay(docKey, rev)) {
            var f = el.path("fields");
            switch (el.path("type").asText()) {
                case "DOC" -> {
                    String t = f.path("text").path("value").asText("");
                    if (!t.isBlank()) sb.append(t).append("\n\n");
                }
                case "TEXT" -> {
                    String t = f.path("text").path("value").asText("");
                    if (!t.isBlank()) sb.append(t).append("\n\n");
                }
                case "COLUMN" -> sb.append("\n#### 列：").append(f.path("title").path("value").asText("")).append("\n");
                case "CARD" -> {
                    String text = f.path("text").path("value").asText("");
                    sb.append("- ").append(text.isBlank() ? "（空白卡片）" : text).append("\n");
                }
                default -> { }
            }
        }
        return ResponseEntity.ok()
                .header("Content-Disposition", "attachment; filename=\"doc-" + docKey.substring(0, 8) + ".md\"")
                .body(sb.toString());
    }

    /* ---------- 搜索（标题/正文，限我的空间） ---------- */

    @GetMapping("/docs/search")
    public ResponseEntity<?> search(@RequestParam(value = "q") String q) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        String like = "%" + q.trim() + "%";
        List<Map<String, Object>> out = new ArrayList<>();
        out.addAll(docs.searchTitle(u.id(), like));
        out.addAll(docs.searchBody(u.id(), like));
        return ResponseEntity.ok(out);
    }

    /* ---------- 统计 ---------- */

    @GetMapping("/stats")
    public ResponseEntity<?> stats() {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        int mySpaces = spaces.listForUser(u.id()).size();
        List<Map<String, Object>> mine = docs.listVisible(u.id(), null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("mySpaces", mySpaces);
        out.put("myDocs", mine.size());
        out.put("platform", docs.platformCounts());
        return ResponseEntity.ok(out);
    }
}