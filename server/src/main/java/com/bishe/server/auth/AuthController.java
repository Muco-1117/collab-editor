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

    public AuthController(AuthService svc) {
        this.svc = svc;
    }

    private record AuthResp(String token, AuthService.UserPub user) {}

    @PostMapping("/register")
    public ResponseEntity<?> register(@RequestBody Map<String, String> body) {
        try {
            var user = svc.register(body.get("username"), body.get("password"), body.get("nickname"));
            return ResponseEntity.ok(Map.of("token", svcLogin(body.get("username"), body.get("password")),
                    "user", user, "msg", "注册成功"));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("msg", e.getMessage()));
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
        var auth = org.springframework.security.core.context.SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof AuthService.UserPub u)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("msg", "未登录"));
        }
        return ResponseEntity.ok(Map.of("user", u, "msg", "ok"));
    }

    private String svcLogin(String username, String password) {
        if (username == null || password == null) throw new IllegalArgumentException("用户名或密码错误");
        return svc.login(username, password);
    }
}