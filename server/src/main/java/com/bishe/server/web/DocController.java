package com.bishe.server.web;

import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.AccessService;
import com.bishe.server.auth.CurrentUser;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.SpaceRepo;
import com.bishe.server.validation.TextRules;
import com.bishe.server.ws.RoomRegistry;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 文档 CRUD（REST）。T0+9：所有操作按空间成员资格过滤。
 * - 列表：只返回我所在空间的文档（?spaceId= 可选按空间过滤）
 * - 创建：必须落在我的空间（缺省取我第一个空间）
 * - 读/删：仅空间成员
 */
@RestController
@RequestMapping("/api/docs")
public class DocController {

    private final DocRepo repo;
    private final SpaceRepo spaces;
    private final AccessService access;
    private final CurrentUser currentUser;
    private final RoomRegistry registry;

    /** Constructor retained for focused controller tests that do not open rooms. */
    public DocController(DocRepo repo, SpaceRepo spaces, AccessService access, CurrentUser currentUser) {
        this(repo, spaces, access, currentUser, null);
    }

    @Autowired
    public DocController(DocRepo repo, SpaceRepo spaces, AccessService access,
                         CurrentUser currentUser, RoomRegistry registry) {
        this.repo = repo;
        this.spaces = spaces;
        this.access = access;
        this.currentUser = currentUser;
        this.registry = registry;
    }

    private AuthService.UserPub me() {
        return currentUser.get();
    }

    @GetMapping
    public ResponseEntity<?> list(@RequestParam(value = "spaceId", required = false) Long spaceId,
                                  @RequestParam(value = "kind", required = false) String kind) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        if (kind != null && !Set.of("doc", "board", "kanban").contains(kind)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "kind 仅支持 doc|board|kanban"));
        }
        if (spaceId != null) {
            if (spaceId <= 0) {
                return ResponseEntity.badRequest().body(Map.of("msg", "spaceId 必须为正整数"));
            }
            if (spaces.roleOf(spaceId, u.id()) == null) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "不是该空间成员"));
            }
            return ResponseEntity.ok(repo.listBySpace(spaceId, u.id(), kind));
        }
        return ResponseEntity.ok(repo.listVisible(u.id(), kind));
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody(required = false) Map<String, String> body) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        String rawTitle = body == null ? null : body.get("title");
        String title = rawTitle == null ? "" : rawTitle.trim();
        if (title.length() > 256 || TextRules.containsControl(title)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "标题最长 256 字且不能包含控制字符"));
        }
        String kind = body == null ? "doc" : body.getOrDefault("kind", "doc");
        if (kind == null || !Set.of("doc", "board", "kanban").contains(kind)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "kind 仅支持 doc|board|kanban"));
        }
        if (title.isBlank()) {
            title = switch (kind) {
                case "board" -> "未命名白板";
                case "kanban" -> "未命名看板";
                default -> "未命名文档";
            };
        }
        Long spaceId = null;
        if (body != null && body.containsKey("spaceId")) {
            String rawSpaceId = body.get("spaceId");
            try {
                spaceId = rawSpaceId == null ? null : Long.parseLong(rawSpaceId.trim());
            } catch (NumberFormatException ignored) {
                return ResponseEntity.badRequest().body(Map.of("msg", "spaceId 必须为正整数"));
            }
            if (spaceId == null || spaceId <= 0) {
                return ResponseEntity.badRequest().body(Map.of("msg", "spaceId 必须为正整数"));
            }
        }
        if (spaceId == null) {
            // 缺省：取我加入的最近一个空间
            List<Map<String, Object>> mine = spaces.listForUser(u.id());
            if (mine.isEmpty()) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN)
                        .body(Map.of("msg", "请先创建或加入一个空间"));
            }
            spaceId = ((Number) mine.get(0).get("id")).longValue();
        }
        String role = spaces.roleOf(spaceId, u.id());
        if (role == null) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "不是该空间成员"));
        }
        if (!AccessService.canWriteRole(role)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "只读成员（viewer）不可创建文档"));
        }
        String key = repo.create(title, spaceId, kind, u.id());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("docKey", key);
        out.put("title", title);
        out.put("kind", kind);
        out.put("spaceId", spaceId);
        return ResponseEntity.ok(out);
    }

    @GetMapping("/{docKey}")
    public ResponseEntity<?> get(@PathVariable("docKey") String docKey) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        Map<String, Object> m = repo.get(docKey);
        if (m == null) return ResponseEntity.notFound().build();
        AccessService.DocumentAccess permission = access.document(docKey, u);
        if (permission == null) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "不是该空间成员"));
        }
        Map<String, Object> result = new LinkedHashMap<>(m);
        result.put("my_role", permission.role());
        return ResponseEntity.ok(result);
    }

    @PutMapping("/{docKey}")
    public ResponseEntity<?> update(@PathVariable("docKey") String docKey,
                                    @RequestBody(required = false) Map<String, String> body) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        if (repo.spaceIdOf(docKey) < 0) return ResponseEntity.notFound().build();
        AccessService.DocumentAccess permission = access.document(docKey, u);
        if (permission == null) return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("msg", "无权访问该空间"));
        if (!permission.canWrite()) return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("msg", "只读成员（viewer）不可修改文档"));
        String rawTitle = body == null ? null : body.get("title");
        String title = rawTitle == null ? "" : rawTitle.trim();
        if (title.isBlank() || title.length() > 256 || TextRules.containsControl(title)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "标题长度需为 1-256 字"));
        }
        boolean updated = registry == null ? repo.updateTitle(docKey, title)
                : registry.renameDocument(docKey, title, () -> repo.updateTitle(docKey, title));
        if (!updated) return ResponseEntity.notFound().build();
        return ResponseEntity.ok(Map.of("docKey", docKey, "title", title));
    }

    @DeleteMapping("/{docKey}")
    public ResponseEntity<?> delete(@PathVariable("docKey") String docKey) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        if (repo.spaceIdOf(docKey) < 0) return ResponseEntity.notFound().build();
        AccessService.DocumentAccess permission = access.document(docKey, u);
        if (permission == null) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "无权访问该空间"));
        }
        if (!permission.isOwner()) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "仅空间所有者可删除文档"));
        }
        boolean ok = registry == null ? repo.delete(docKey)
                : registry.deleteDocument(docKey, () -> repo.delete(docKey));
        return ok ? ResponseEntity.ok(Map.of("deleted", true)) : ResponseEntity.notFound().build();
    }
}
