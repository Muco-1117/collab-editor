package com.bishe.server.auth;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 账号接口：/api/auth/register · /api/auth/login · /api/auth/me
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService svc;
    private final CurrentUser currentUser;

    public AuthController(AuthService svc, CurrentUser currentUser) {
        this.svc = svc;
        this.currentUser = currentUser;
    }

    @PostMapping("/register")
    public ResponseEntity<?> register(@RequestBody Map<String, String> body) {
        try {
            var user = svc.register(body.get("username"), body.get("password"), body.get("nickname"));
            return ResponseEntity.ok(Map.of("token", svcLogin(body.get("username"), body.get("password")),
                    "user", user, "msg", "注册成功"));
        } catch (IllegalArgumentException e) {
            HttpStatus status = "用户名已存在".equals(e.getMessage())
                    ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
            return ResponseEntity.status(status).body(Map.of("msg", e.getMessage()));
        }
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody Map<String, String> body) {
        try {
            return ResponseEntity.ok(Map.of("token", svcLogin(body.get("username"), body.get("password"))));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("msg", e.getMessage()));
        }
    }

    @GetMapping("/me")
    public ResponseEntity<?> me() {
        var u = currentUser.get();
        if (u == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("msg", "未登录"));
        }
        // 实时查库返回（昵称修改后立即生效，不依赖 JWT 载荷）
        return svc.byIdOrNull(u.id()) == null
                ? ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("msg", "未登录"))
                : ResponseEntity.ok(Map.of("user", svc.byIdOrNull(u.id()), "msg", "ok"));
    }

    /** 仅修改当前用户的显示昵称，登录名与角色不可由此修改。 */
    @PutMapping("/me")
    public ResponseEntity<?> updateProfile(@RequestBody Map<String, String> body) {
        var user = currentUser.get();
        if (user == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        try {
            return ResponseEntity.ok(Map.of("user", svc.updateNickname(user.id(), body.get("nickname")), "msg", "昵称已更新"));
        } catch (IllegalArgumentException error) {
            return ResponseEntity.badRequest().body(Map.of("msg", error.getMessage()));
        }
    }

    /** 有效会话换发新 token，旧 token 到期后自然失效。 */
    @PostMapping("/refresh")
    public ResponseEntity<?> refresh() {
        var u = currentUser.get();
        if (u == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("msg", "未登录"));
        }
        return ResponseEntity.ok(Map.of("token", svc.issueToken(u), "user", u));
    }

    private String svcLogin(String username, String password) {
        if (username == null || password == null) throw new IllegalArgumentException("用户名或密码错误");
        return svc.login(username, password);
    }
}
