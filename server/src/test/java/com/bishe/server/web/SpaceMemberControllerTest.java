package com.bishe.server.web;

import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.CurrentUser;
import com.bishe.server.store.SpaceRepo;
import com.bishe.server.ws.RoomRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class SpaceMemberControllerTest {

    private final SpaceRepo spaces = mock(SpaceRepo.class);
    private final AuthService auth = mock(AuthService.class);
    private final CurrentUser currentUser = mock(CurrentUser.class);
    private final RoomRegistry rooms = mock(RoomRegistry.class);
    private final SpaceController controller = new SpaceController(spaces, auth, currentUser, rooms);

    @BeforeEach
    void owner() {
        when(currentUser.get()).thenReturn(new AuthService.UserPub(7, "owner", "所有者", "editor"));
        when(spaces.roleOf(9, 7)).thenReturn("owner");
        when(spaces.roleOf(9, 8)).thenReturn("editor");
    }

    @Test
    void ownerCanChangeRoleAndRemoveAndEachChangeRefreshesLiveRooms() {
        when(spaces.updateMemberRole(9, 8, "viewer")).thenReturn(true);
        var changed = controller.updateMember(9, 8, Map.of("role", "viewer"));
        assertEquals(200, changed.getStatusCode().value());
        assertEquals("viewer", ((Map<?, ?>) changed.getBody()).get("role"));
        verify(rooms).refreshMemberAccess(eq(9L), eq(8L), any());

        when(spaces.removeMember(9, 8)).thenReturn(true);
        var removed = controller.removeMember(9, 8);
        assertEquals(200, removed.getStatusCode().value());
        assertEquals(true, ((Map<?, ?>) removed.getBody()).get("removed"));
        verify(rooms, times(2)).refreshMemberAccess(eq(9L), eq(8L), any());
    }

    @ParameterizedTest
    @ValueSource(strings = {"editor", "viewer", ""})
    void ordinaryMembersCannotManageOtherMembers(String role) {
        when(spaces.roleOf(9, 7)).thenReturn(role.isEmpty() ? null : role);
        assertEquals(403, controller.updateMember(9, 8, Map.of("role", "viewer")).getStatusCode().value());
        assertEquals(403, controller.removeMember(9, 8).getStatusCode().value());
        verify(spaces, never()).updateMemberRole(anyLong(), anyLong(), any());
        verify(spaces, never()).removeMember(anyLong(), anyLong());
        verifyNoInteractions(rooms);
    }

    @Test
    void ownerAndMissingMemberAreProtected() {
        assertEquals(400, controller.updateMember(9, 7, Map.of("role", "viewer")).getStatusCode().value());
        assertEquals(400, controller.removeMember(9, 7).getStatusCode().value());
        assertEquals(404, controller.updateMember(9, 999, Map.of("role", "viewer")).getStatusCode().value());
        assertEquals(404, controller.removeMember(9, 999).getStatusCode().value());
        assertEquals(400, controller.updateMember(9, -1, Map.of("role", "viewer")).getStatusCode().value());
        assertEquals(400, controller.removeMember(0, 8).getStatusCode().value());
        verify(spaces, never()).updateMemberRole(anyLong(), anyLong(), any());
        verify(spaces, never()).removeMember(anyLong(), anyLong());
        verifyNoInteractions(rooms);
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"", "owner", "admin", "EDITOR", " viewer "})
    void invalidRolesAreRejectedWithoutMutation(String role) {
        Map<String, String> body = new HashMap<>();
        body.put("role", role);
        assertEquals(400, controller.updateMember(9, 8, body).getStatusCode().value());
        verify(spaces, never()).updateMemberRole(anyLong(), anyLong(), any());
        verifyNoInteractions(rooms);
    }

    @Test
    void mutationsRequireAuthentication() {
        when(currentUser.get()).thenReturn(null);
        assertEquals(401, controller.updateMember(9, 8, Map.of("role", "viewer")).getStatusCode().value());
        assertEquals(401, controller.removeMember(9, 8).getStatusCode().value());
        verify(spaces, never()).updateMemberRole(anyLong(), anyLong(), any());
        verify(spaces, never()).removeMember(anyLong(), anyLong());
    }
}
