package com.bishe.server.auth;

import com.bishe.server.store.DocRepo;
import com.bishe.server.store.SpaceRepo;
import org.springframework.stereotype.Service;

/** 空间、文档与成员角色的统一权限判定。 */
@Service
public class AccessService {

    public record DocumentAccess(long spaceId, String role) {
        public boolean canWrite() {
            return "owner".equals(role) || "admin".equals(role) || "editor".equals(role);
        }

        public boolean isOwner() {
            return "owner".equals(role) || "admin".equals(role);
        }
    }

    private final DocRepo docs;
    private final SpaceRepo spaces;

    public AccessService(DocRepo docs, SpaceRepo spaces) {
        this.docs = docs;
        this.spaces = spaces;
    }

    /** 文档不存在或用户不是空间成员时返回 null。 */
    public DocumentAccess document(String docKey, AuthService.UserPub user) {
        if (user == null || docKey == null || docKey.isBlank()) {
            return null;
        }
        long spaceId = docs.spaceIdOf(docKey);
        if (spaceId < 0) {
            return null;
        }
        String role = spaces.roleOf(spaceId, user.id());
        return role == null ? null : new DocumentAccess(spaceId, role);
    }

    public static boolean canWriteRole(String role) {
        return "owner".equals(role) || "admin".equals(role) || "editor".equals(role);
    }

    public static boolean isOwnerRole(String role) {
        return "owner".equals(role) || "admin".equals(role);
    }
}
