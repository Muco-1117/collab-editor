package com.bishe.server.web;

import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.CurrentUser;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.SpaceRepo;
import com.bishe.server.ws.RoomRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.ResponseEntity;

import java.sql.Timestamp;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** 权限和幂等恢复不依赖数据库；真实 SQL 和内容持久化由 TrashApiTest 验证。 */
class TrashControllerTest {

    private final DocRepo documents = mock(DocRepo.class);
    private final SpaceRepo spaces = mock(SpaceRepo.class);
    private final CurrentUser currentUser = mock(CurrentUser.class);
    private final RoomRegistry registry = mock(RoomRegistry.class);
    private final TrashController controller = new TrashController(documents, spaces, currentUser, registry);
    private final AuthService.UserPub user = new AuthService.UserPub(7, "alice", "Alice", "editor");

    @BeforeEach
    void setup() {
        when(currentUser.get()).thenReturn(user);
        when(documents.getVisibleIncludingDeleted(anyString(), anyLong())).thenReturn(null);
        when(registry.restoreDocument(anyString(), any())).thenAnswer(invocation ->
                ((Supplier<?>) invocation.getArgument(1)).get());
    }

    @Test
    void unauthenticatedRequestsDoNotInspectDocumentsOrSpaces() {
        when(currentUser.get()).thenReturn(null);
        assertEquals(401, controller.list(9).getStatusCode().value());
        assertEquals(401, controller.restore("secret").getStatusCode().value());
        verifyNoInteractions(documents, spaces, registry);
    }

    @Test
    void nonMembersAndMissingContentsHaveTheSameEmptyNotFoundResponse() {
        ResponseEntity<?> space = controller.list(999);
        ResponseEntity<?> outsider = controller.restore("another-space");
        ResponseEntity<?> missing = controller.restore("missing");
        for (ResponseEntity<?> response : List.of(space, outsider, missing)) {
            assertEquals(404, response.getStatusCode().value());
            assertNull(response.getBody());
        }
        verify(documents, never()).listDeletedBySpace(anyLong(), anyLong());
        verify(documents, never()).restoreDeleted(anyString(), anyLong());
        verify(documents, never()).get(anyString());
    }

    @ParameterizedTest
    @ValueSource(strings = {"viewer", "editor"})
    void ordinaryMembersCannotListOrRestoreTrash(String role) {
        when(spaces.roleOf(9, 7)).thenReturn(role);
        when(documents.getVisibleIncludingDeleted("doc", 7)).thenReturn(metadata(role, true));
        assertEquals(403, controller.list(9).getStatusCode().value());
        assertEquals(403, controller.restore("doc").getStatusCode().value());
        verify(documents, never()).listDeletedBySpace(anyLong(), anyLong());
        verify(documents, never()).restoreDeleted(anyString(), anyLong());
    }

    @ParameterizedTest
    @ValueSource(strings = {"owner", "admin"})
    void spaceManagersListAndRestoreOriginalMetadata(String role) {
        Map<String, Object> deleted = metadata(role, true), active = metadata(role, false);
        when(spaces.roleOf(9, 7)).thenReturn(role);
        when(documents.listDeletedBySpace(9, 7)).thenReturn(List.of(deleted));
        when(documents.getVisibleIncludingDeleted("doc", 7)).thenReturn(deleted).thenReturn(active);
        when(documents.restoreDeleted("doc", 7)).thenReturn(true);

        assertEquals(Map.of("documents", List.of(deleted)), controller.list(9).getBody());
        ResponseEntity<?> response = controller.restore("doc");
        assertEquals(200, response.getStatusCode().value());
        assertEquals(Map.of("docKey", "doc", "kind", "board", "title", "删除前白板", "spaceId", 9L), response.getBody());
        verify(documents).restoreDeleted("doc", 7);
        verify(registry).restoreDocument(eq("doc"), any());
    }

    @Test
    void repeatedRestoreDoesNotRewriteActiveMetadata() {
        when(documents.getVisibleIncludingDeleted("doc", 7)).thenReturn(metadata("owner", false));
        assertEquals(200, controller.restore("doc").getStatusCode().value());
        assertEquals(200, controller.restore("doc").getStatusCode().value());
        verify(documents, never()).restoreDeleted(anyString(), anyLong());
    }

    @Test
    void revokedMembershipDuringRestoreDoesNotReturnMetadata() {
        when(documents.getVisibleIncludingDeleted("doc", 7)).thenReturn(metadata("owner", true)).thenReturn(null);
        var response = controller.restore("doc");
        assertEquals(404, response.getStatusCode().value());
        assertNull(response.getBody());
    }

    @Test
    void failedMutationCannotReportContentAsRestored() {
        when(documents.getVisibleIncludingDeleted("doc", 7)).thenReturn(metadata("owner", true));
        assertEquals(409, controller.restore("doc").getStatusCode().value());
    }

    @Test
    void invalidSpaceIdsCannotQueryTheRepository() {
        assertEquals(400, controller.list(0).getStatusCode().value());
        assertEquals(400, controller.list(-1).getStatusCode().value());
        verifyNoInteractions(documents, spaces);
    }

    private static Map<String, Object> metadata(String role, boolean deleted) {
        Map<String, Object> metadata = new LinkedHashMap<>(Map.of(
                "doc_key", "doc", "kind", "board", "title", "删除前白板", "space_id", 9L, "my_role", role));
        metadata.put("deleted_at", deleted ? Timestamp.valueOf("2026-10-22 08:00:00") : null);
        return metadata;
    }
}
