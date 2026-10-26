package com.bishe.server.auth;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class ProfileAvatarController {
    private final CurrentUser currentUser;
    private final AuthService auth;
    private final AvatarService avatars;

    public ProfileAvatarController(CurrentUser currentUser, AuthService auth, AvatarService avatars) {
        this.currentUser = currentUser;
        this.auth = auth;
        this.avatars = avatars;
    }

    @PutMapping(value = "/auth/me/avatar", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> upload(@RequestPart("file") MultipartFile file) {
        var user = currentUser.get();
        if (user == null) return ResponseEntity.status(401).build();
        try {
            avatars.update(user.id(), file);
            return ResponseEntity.ok(Map.of("user", auth.byId(user.id()), "msg", "头像已更新"));
        } catch (IllegalArgumentException error) {
            return ResponseEntity.badRequest().body(Map.of("msg", error.getMessage()));
        }
    }

    @DeleteMapping("/auth/me/avatar")
    public ResponseEntity<?> remove() {
        var user = currentUser.get();
        if (user == null) return ResponseEntity.status(401).build();
        avatars.remove(user.id());
        return ResponseEntity.ok(Map.of("user", auth.byId(user.id()), "msg", "已恢复默认头像"));
    }

    /** 头像向已登录用户展示，不包含账户其他私密信息。 */
    @GetMapping("/users/{uid}/avatar")
    public ResponseEntity<byte[]> read(@PathVariable("uid") long uid) {
        if (currentUser.get() == null) return ResponseEntity.status(401).build();
        byte[] data = avatars.read(uid);
        if (data == null) return ResponseEntity.notFound().build();
        // JwtAuthFilter 已统一设置 Cache-Control: no-store。
        return ResponseEntity.ok().contentType(MediaType.IMAGE_PNG).body(data);
    }
}
