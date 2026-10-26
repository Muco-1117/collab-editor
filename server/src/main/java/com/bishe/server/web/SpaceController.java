package com.bishe.server.web;

import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.AccessService;
import com.bishe.server.auth.CurrentUser;
import com.bishe.server.store.SpaceRepo;
import com.bishe.server.validation.TextRules;
import com.bishe.server.ws.RoomRegistry;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 空间接口：创建 / 我的空间 / 成员管理（邀请与角色调整仅限 owner）。
 */
@RestController
@RequestMapping("/api/spaces")
public class SpaceController {

    private final SpaceRepo repo;
    private final AuthService auth;
    private final CurrentUser currentUser;
    private final RoomRegistry registry;

    public SpaceController(SpaceRepo repo, AuthService auth, CurrentUser currentUser) {
        this(repo, auth, currentUser, null);
    }

    @Autowired
    public SpaceController(SpaceRepo repo, AuthService auth, CurrentUser currentUser, RoomRegistry registry) {
        this.repo = repo;
        this.auth = auth;
        this.currentUser = currentUser;
        this.registry = registry;
    }

    private AuthService.UserPub me() {
        return currentUser.get();
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
        String rawName = body == null ? null : body.get("name");
        String name = rawName == null ? "" : rawName.trim();
        if (name.isBlank() || name.length() > 128 || TextRules.containsControl(name)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "空间名长度需为 1-128 字"));
        }
        long sid = repo.create(name, u.id());
        return ResponseEntity.ok(Map.of("spaceId", sid, "name", name, "msg", "创建成功"));
    }

    @GetMapping("/{id}/members")
    public ResponseEntity<?> members(@PathVariable("id") long id) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        if (repo.roleOf(id, u.id()) == null) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "不是该空间成员"));
        }
        return ResponseEntity.ok(Map.of("members", repo.members(id)));
    }

    @PostMapping("/{id}/members")
    public ResponseEntity<?> invite(@PathVariable("id") long id, @RequestBody Map<String, String> body) {
        AuthService.UserPub u = me();
        if (u == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        String myRole = repo.roleOf(id, u.id());
        if (!AccessService.isOwnerRole(myRole)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "仅空间所有者可邀请成员"));
        }
        String rawUsername = body == null ? null : body.get("username");
        String username = rawUsername == null ? "" : rawUsername.trim();
        String rawRole = body == null ? "editor" : body.getOrDefault("role", "editor");
        String role = rawRole == null ? "" : rawRole.trim();
        if (username.isBlank()) return ResponseEntity.badRequest().body(Map.of("msg", "用户名不能为空"));
        if (!role.matches("editor|viewer")) {
            return ResponseEntity.badRequest().body(Map.of("msg", "成员角色仅支持 editor 或 viewer"));
        }
        AuthService.UserPub target = auth.byUsername(username);
        if (target == null) return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("msg", "用户不存在"));
        if (AccessService.isOwnerRole(repo.roleOf(id, target.id()))) {
            return ResponseEntity.badRequest().body(Map.of("msg", "不能修改空间所有者角色"));
        }
        repo.addMember(id, target.id(), role);
        refreshAccess(id, target.id());
        return ResponseEntity.ok(Map.of("msg", "已邀请 " + username, "role", role));
    }

    @PutMapping("/{id}/members/{userId}")
    public ResponseEntity<?> updateMember(@PathVariable("id") long id, @PathVariable("userId") long userId,
                                           @RequestBody Map<String, String> body) {
        AuthService.UserPub user = me();
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        if (id <= 0 || userId <= 0) return ResponseEntity.badRequest().body(Map.of("msg", "空间或成员 ID 无效"));
        if (!AccessService.isOwnerRole(repo.roleOf(id, user.id()))) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "仅空间所有者可调整成员权限"));
        }
        String existingRole = repo.roleOf(id, userId);
        if (existingRole == null) return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("msg", "该成员已不在此空间"));
        if (AccessService.isOwnerRole(existingRole)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "不能修改空间所有者角色"));
        }
        String role = body == null ? null : body.get("role");
        if (!"editor".equals(role) && !"viewer".equals(role)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "成员角色仅支持 editor 或 viewer"));
        }
        if (!repo.updateMemberRole(id, userId, role)) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("msg", "该成员已不在此空间"));
        }
        refreshAccess(id, userId);
        return ResponseEntity.ok(Map.of("userId", userId, "role", role, "msg", "成员权限已更新"));
    }

    @DeleteMapping("/{id}/members/{userId}")
    public ResponseEntity<?> removeMember(@PathVariable("id") long id, @PathVariable("userId") long userId) {
        AuthService.UserPub user = me();
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        if (id <= 0 || userId <= 0) return ResponseEntity.badRequest().body(Map.of("msg", "空间或成员 ID 无效"));
        if (!AccessService.isOwnerRole(repo.roleOf(id, user.id()))) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("msg", "仅空间所有者可移除成员"));
        }
        String existingRole = repo.roleOf(id, userId);
        if (existingRole == null) return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("msg", "该成员已不在此空间"));
        if (AccessService.isOwnerRole(existingRole)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "不能移除空间所有者"));
        }
        if (!repo.removeMember(id, userId)) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("msg", "该成员已不在此空间"));
        }
        refreshAccess(id, userId);
        return ResponseEntity.ok(Map.of("userId", userId, "removed", true, "msg", "成员已移出空间"));
    }

    private void refreshAccess(long spaceId, long userId) {
        if (registry != null) {
            registry.refreshMemberAccess(spaceId, userId, () -> repo.roleOf(spaceId, userId));
        }
    }
}
