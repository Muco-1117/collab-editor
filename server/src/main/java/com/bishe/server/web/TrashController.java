package com.bishe.server.web;

import com.bishe.server.auth.AccessService;
import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.CurrentUser;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.SpaceRepo;
import com.bishe.server.ws.RoomRegistry;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** 回收站与历史版本恢复独立；只有所属空间的所有者或管理员可恢复误删内容。 */
@RestController
@RequestMapping("/api")
public class TrashController {

    private final DocRepo documents;
    private final SpaceRepo spaces;
    private final CurrentUser currentUser;
    private final RoomRegistry registry;

    public TrashController(DocRepo documents, SpaceRepo spaces, CurrentUser currentUser, RoomRegistry registry) {
        this.documents = documents;
        this.spaces = spaces;
        this.currentUser = currentUser;
        this.registry = registry;
    }

    @GetMapping("/spaces/{spaceId}/trash")
    public ResponseEntity<?> list(@PathVariable("spaceId") long spaceId) {
        AuthService.UserPub user = currentUser.get();
        if (user == null) return ResponseEntity.status(401).build();
        if (spaceId <= 0) return ResponseEntity.badRequest().body(Map.of("msg", "空间 ID 无效"));
        String role = spaces.roleOf(spaceId, user.id());
        if (role == null) return ResponseEntity.notFound().build();
        if (!AccessService.isOwnerRole(role)) {
            return ResponseEntity.status(403).body(Map.of("msg", "仅空间所有者可管理回收站"));
        }
        return ResponseEntity.ok(Map.of("documents", documents.listDeletedBySpace(spaceId, user.id())));
    }

    @PostMapping("/docs/{docKey}/restore-deleted")
    public ResponseEntity<?> restore(@PathVariable("docKey") String docKey) {
        AuthService.UserPub user = currentUser.get();
        if (user == null) return ResponseEntity.status(401).build();
        return registry.restoreDocument(docKey, () -> restoreVisibleDocument(docKey, user.id()));
    }

    private ResponseEntity<?> restoreVisibleDocument(String docKey, long userId) {
        Map<String, Object> metadata = documents.getVisibleIncludingDeleted(docKey, userId);
        if (metadata == null) return ResponseEntity.notFound().build();
        if (!AccessService.isOwnerRole(String.valueOf(metadata.get("my_role")))) {
            return ResponseEntity.status(403).body(Map.of("msg", "仅空间所有者可恢复已删除内容"));
        }
        if (metadata.get("deleted_at") != null) {
            documents.restoreDeleted(docKey, userId);
            metadata = documents.getVisibleIncludingDeleted(docKey, userId);
            if (metadata == null) return ResponseEntity.notFound().build();
            if (!AccessService.isOwnerRole(String.valueOf(metadata.get("my_role")))) {
                return ResponseEntity.status(403).body(Map.of("msg", "仅空间所有者可恢复已删除内容"));
            }
            if (metadata.get("deleted_at") != null) {
                return ResponseEntity.status(409).body(Map.of("msg", "内容状态已变化，请刷新回收站后重试"));
            }
        }
        // Retried restore requests are idempotent: do not touch an active room or its updated_at.
        return ResponseEntity.ok(Map.of(
                "docKey", metadata.get("doc_key"), "title", metadata.get("title"),
                "kind", metadata.get("kind"), "spaceId", metadata.get("space_id")));
    }
}
