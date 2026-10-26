package com.bishe.server.web;

import com.bishe.engine.Op;
import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.AccessService;
import com.bishe.server.auth.CurrentUser;
import com.bishe.server.history.HistoryService;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.OpStore;
import com.bishe.server.store.StatsRepo;
import com.bishe.server.ws.CollabRoom;
import com.bishe.server.ws.RoomRegistry;
import com.bishe.server.validation.TextRules;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 产品能力：历史（时间线/回放/恢复）、按内容类型导出、搜索、统计。
 */
@RestController
@RequestMapping("/api")
public class ProductController {

    private static final Logger log = LoggerFactory.getLogger(ProductController.class);

    private final HistoryService history;
    private final DocRepo docs;
    private final OpStore store;
    private final StatsRepo stats;
    private final RoomRegistry registry;
    private final AccessService access;
    private final CurrentUser currentUser;
    @org.springframework.beans.factory.annotation.Autowired
    private ContentExportService exports;

    public ProductController(HistoryService history, DocRepo docs, OpStore store,
                             StatsRepo stats, RoomRegistry registry, AccessService access,
                             CurrentUser currentUser) {
        this.history = history;
        this.docs = docs;
        this.store = store;
        this.stats = stats;
        this.registry = registry;
        this.access = access;
        this.currentUser = currentUser;
    }

    private AuthService.UserPub me() {
        return currentUser.get();
    }

    /** 空间成员校验；非成员返回 null。 */
    private AccessService.DocumentAccess guard(String docKey) {
        AuthService.UserPub u = me();
        return access.document(docKey, u);
    }

    private ResponseEntity<Map<String, String>> forbidden() {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "无权访问该文档"));
    }

    /* ---------- 历史 ---------- */

    @GetMapping("/docs/{docKey}/history")
    public ResponseEntity<?> history(@PathVariable("docKey") String docKey,
                                     @RequestParam(value = "limit", defaultValue = "20") int limit) {
        AccessService.DocumentAccess permission = guard(docKey);
        if (permission == null) return forbidden();
        return ResponseEntity.ok(Map.of(
                "rev", store.maxSeq(docKey),
                "ops", history.timeline(docKey, limit)));
    }

    @GetMapping("/docs/{docKey}/replay")
    public ResponseEntity<?> replay(@PathVariable("docKey") String docKey, @RequestParam(value = "rev") long rev) {
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
        AccessService.DocumentAccess permission = guard(docKey);
        if (permission == null) return forbidden();
        if (!permission.canWrite()) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "只读成员不可恢复历史版本"));
        }
        long rev = body.get("rev") instanceof Number n ? n.longValue() : -1;
        long max = store.maxSeq(docKey);
        if (rev < 0 || rev > max) {
            return ResponseEntity.badRequest().body(Map.of("msg", "rev 超界 [0," + max + "]"));
        }
        List<Op> ops = history.restoreOps(docKey, rev);
        Map<String, Object> meta = docs.get(docKey);
        CollabRoom room;
        if (meta == null) {
            // Compatibility path for callers that only expose a bare room id.
            room = registry.roomFor(docKey, store);
        } else {
            String kind = metadataText(meta, "kind", "doc");
            String title = metadataText(meta, "title", "");
            room = registry.roomFor(docKey, kind, title, store);
            if (room == null) {
                // Compatibility with narrow controller tests/adapters that
                // still stub only the legacy overload.
                room = registry.roomFor(docKey, store);
            }
        }
        if (room == null) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("msg", "协同房间暂不可用"));
        }
        synchronized (room) {
            if (meta != null) {
                // Keep the metadata title authoritative even when the target
                // revision removes or contains an older DOC.title field.
                synchronizeTitleProjection(room, docKey);
            }
            room.applyExternal(ops);
            if (meta != null) {
                synchronizeTitleProjection(room, docKey);
            }
        }
        if (room.occupantCount() == 0) {
            registry.scheduleEviction(docKey);
        }
        return ResponseEntity.ok(Map.of("msg", "已恢复到 rev=" + rev, "ops", ops.size(),
                "rev", store.maxSeq(docKey)));
    }

    private void synchronizeTitleProjection(CollabRoom room, String docKey) {
        try {
            room.synchronizeTitleProjection();
        } catch (RuntimeException e) {
            // The document metadata remains authoritative; a later join will
            // retry projection if an idle room is concurrently being evicted.
            log.warn("标题协同投影稍后重试 doc={}", docKey, e);
        }
    }

    private static String metadataText(Map<String, Object> metadata, String key, String fallback) {
        Object value = metadata.get(key);
        return value == null ? fallback : String.valueOf(value);
    }

    /* ---------- 多格式导出 ---------- */

    @GetMapping(value = "/docs/{docKey}/export")
    public ResponseEntity<?> export(@PathVariable("docKey") String docKey,
                                    @RequestParam(value = "format", defaultValue = "md") String format) {
        if (guard(docKey) == null) return forbidden();
        Map<String, Object> meta = docs.get(docKey);
        ContentExportService.Export result;
        try {
            result = exports.generate(docKey, metadataText(meta, "title", "未命名"),
                    metadataText(meta, "kind", "doc"), format, history.replay(docKey, store.maxSeq(docKey)));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("msg", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(409).body(Map.of("msg", "导出失败，请检查图片资源是否完整"));
        }
        String prefix = docKey.length() > 8 ? docKey.substring(0, 8) : docKey;
        return ResponseEntity.ok()
                .header("Content-Type", result.mime())
                .header("Content-Disposition", "attachment; filename=\"document-" + prefix + "." + result.extension() + "\"")
                .header("Cache-Control", "no-store")
                .body(result.bytes());
    }

    /* ---------- 搜索（标题/正文，限我的空间） ---------- */

    @GetMapping("/docs/search")
    public ResponseEntity<?> search(@RequestParam(value = "q") String q) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        String term = q == null ? "" : q.trim();
        if (term.isBlank() || term.length() > 100 || TextRules.containsControl(term)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "搜索词长度需为 1-100 字"));
        }
        List<Map<String, Object>> out = new ArrayList<>();
        String needle = term.toLowerCase(Locale.ROOT);
        for (Map<String, Object> doc : docs.listVisible(u.id(), null)) {
            String docKey = String.valueOf(doc.get("doc_key"));
            String title = String.valueOf(doc.getOrDefault("title", ""));
            String hit = title.toLowerCase(Locale.ROOT).contains(needle) ? "title" : null;
            String matchedText = "";
            if (hit == null) {
                for (JsonNode element : visibleElements(history.replay(docKey, store.maxSeq(docKey)))) {
                    for (String field : List.of("title", "text", "name", "coverName")) {
                        String value = fieldText(element, field);
                        if (value.toLowerCase(Locale.ROOT).contains(needle)) {
                            hit = "body";
                            matchedText = value;
                            break;
                        }
                    }
                    if (hit != null) break;
                }
            }
            if (hit != null) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("doc_key", docKey);
                item.put("title", title);
                item.put("kind", doc.get("kind"));
                item.put("space_name", doc.get("space_name"));
                item.put("my_role", doc.get("my_role"));
                item.put("hit", hit);
                item.put("snippet", "body".equals(hit) ? snippet(matchedText, term) : title);
                out.add(item);
                if (out.size() == 50) break;
            }
        }
        return ResponseEntity.ok(out);
    }

    /* ---------- 统计 ---------- */

    @GetMapping("/stats")
    public ResponseEntity<?> stats() {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        return ResponseEntity.ok(stats.forUser(u.id()));
    }

    private static List<JsonNode> visibleElements(JsonNode snapshot) {
        List<JsonNode> result = new ArrayList<>();
        snapshot.forEach(el -> {
            if (!el.path("fields").path("#tombstone").path("value").asBoolean(false)) {
                result.add(el);
            }
        });
        return result;
    }

    private static String fieldText(JsonNode element, String name) {
        JsonNode value = element.path("fields").path(name).path("value");
        return value.isValueNode() && !value.isNull() ? value.asText("") : "";
    }

    private static String snippet(String text, String term) {
        if (text == null || text.isBlank()) return "";
        int at = text.toLowerCase(Locale.ROOT).indexOf(term.toLowerCase(Locale.ROOT));
        int from = Math.max(0, at - 24);
        int to = Math.min(text.length(), Math.max(at, 0) + term.length() + 36);
        return (from > 0 ? "…" : "") + text.substring(from, to) + (to < text.length() ? "…" : "");
    }
}
