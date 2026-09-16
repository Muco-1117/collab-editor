package com.bishe.server.web;

import com.bishe.server.auth.AuthService;
import com.bishe.server.store.SpaceRepo;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 空间接口：创建 / 我的空间 / 成员管理（邀请仅限 admin）。
 */
@RestController
@RequestMapping("/api/spaces")
public class SpaceController {

    private final SpaceRepo repo;
    private final AuthService auth;

    public SpaceController(SpaceRepo repo, AuthService auth) {
        this.repo = repo;
        this.auth = auth;
    }

    private AuthService.UserPub me() {
        var a = SecurityContextHolder.getContext().getAuthentication();
        return a != null && a.getPrincipal() instanceof AuthService.UserPub u ? u : null;
    }

    @GetMapping
    public ResponseEntity<?> list() {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        return ResponseEntity.ok(repo.listForUser(u.id()));
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody Map<String, String> body) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        String name = body.getOrDefault("name", "").trim();
        if (name.isBlank()) return ResponseEntity.badRequest().body(Map.of("msg", "空间名不能为空"));
        long sid = repo.create(name, u.id());
        return ResponseEntity.ok(Map.of("spaceId", sid, "name", name, "msg", "创建成功"));
    }

    @GetMapping("/{id}/members")
    public ResponseEntity<?> members(@PathVariable("id") long id) {
        AuthService.UserPub u = me();
        if (u == null || repo.roleOf(id, u.id()) == null) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "不是该空间成员"));
        }
        return ResponseEntity.ok(Map.of("members", repo.members(id)));
    }

    @PostMapping("/{id}/members")
    public ResponseEntity<?> invite(@PathVariable("id") long id, @RequestBody Map<String, String> body) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        String myRole = repo.roleOf(id, u.id());
        if (!"admin".equals(myRole)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "仅空间管理员可邀请成员"));
        }
        String username = body.getOrDefault("username", "").trim();
        String role = body.getOrDefault("role", "editor").trim();
        if (username.isBlank()) return ResponseEntity.badRequest().body(Map.of("msg", "用户名不能为空"));
        if (!role.matches("admin|editor|viewer")) role = "editor";
        AuthService.UserPub target = auth.byUsername(username);
        if (target == null) return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("msg", "用户不存在"));
        repo.addMember(id, target.id(), role);
        return ResponseEntity.ok(Map.of("msg", "已邀请 " + username, "role", role));
    }
}