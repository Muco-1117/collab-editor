package com.bishe.server.web;

import com.bishe.server.auth.AuthService;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.SpaceRepo;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.context.SecurityContextHolder;
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

    public DocController(DocRepo repo, SpaceRepo spaces) {
        this.repo = repo;
        this.spaces = spaces;
    }

    private AuthService.UserPub me() {
        var a = SecurityContextHolder.getContext().getAuthentication();
        return a != null && a.getPrincipal() instanceof AuthService.UserPub u ? u : null;
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
            if (spaces.roleOf(spaceId, u.id()) == null) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "不是该空间成员"));
            }
            return ResponseEntity.ok(repo.listBySpace(spaceId, kind));
        }
        return ResponseEntity.ok(repo.listVisible(u.id(), kind));
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody(required = false) Map<String, String> body) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        String title = body == null ? "" : body.getOrDefault("title", "");
        String kind = body == null ? "doc" : body.getOrDefault("kind", "doc");
        if (!Set.of("doc", "board", "kanban").contains(kind)) kind = "doc";
        Long spaceId = null;
        if (body != null && body.get("spaceId") != null) {
            try {
                spaceId = Long.parseLong(body.get("spaceId"));
            } catch (NumberFormatException ignored) {}
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
        if (spaces.roleOf(spaceId, u.id()) == null) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "不是该空间成员"));
        }
        if ("viewer".equals(spaces.roleOf(spaceId, u.id()))) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "只读成员（viewer）不可创建文档"));
        }
        String key = repo.create(title, spaceId, kind);
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
        long spaceId = ((Number) m.get("space_id")).longValue();
        if (spaces.roleOf(spaceId, u.id()) == null) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "不是该空间成员"));
        }
        return ResponseEntity.ok(m);
    }

    @DeleteMapping("/{docKey}")
    public ResponseEntity<?> delete(@PathVariable("docKey") String docKey) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        long spaceId = repo.spaceIdOf(docKey);
        if (spaceId < 0) return ResponseEntity.notFound().build();
        if (spaces.roleOf(spaceId, u.id()) == null) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "无权访问该空间"));
        }
        if ("viewer".equals(spaces.roleOf(spaceId, u.id()))) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "只读成员（viewer）不可删除文档"));
        }
        boolean ok = repo.delete(docKey);
        return ok ? ResponseEntity.ok(Map.of("deleted", true)) : ResponseEntity.notFound().build();
    }
}