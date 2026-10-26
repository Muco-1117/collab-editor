package com.bishe.server.web;

import com.bishe.server.auth.AccessService;
import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.CurrentUser;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.SpaceRepo;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Explicit bad input must not crash or silently target another space. */
class ContentInputValidationTest {

    private final DocRepo docs = mock(DocRepo.class);
    private final SpaceRepo spaces = mock(SpaceRepo.class);
    private final AccessService access = mock(AccessService.class);
    private final CurrentUser currentUser = mock(CurrentUser.class);
    private final AuthService auth = mock(AuthService.class);
    private final AuthService.UserPub user = new AuthService.UserPub(7, "alice", "Alice", "editor");

    private DocController documents() {
        when(currentUser.get()).thenReturn(user);
        return new DocController(docs, spaces, access, currentUser);
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"", " ", "abc", "1.5", "0", "-1", "9223372036854775808"})
    void explicitInvalidSpaceNeverFallsBackToAnotherSpace(String spaceId) {
        Map<String, String> body = new HashMap<>();
        body.put("spaceId", spaceId);
        body.put("title", "应留在原空间");

        assertEquals(400, documents().create(body).getStatusCode().value());
        verify(spaces, never()).listForUser(anyLong());
        verify(docs, never()).create(anyString(), anyLong(), anyString(), anyLong());
    }

    @Test
    void nullOptionalTitleUsesUntitledAndNullKindIsRejected() {
        DocController controller = documents();
        when(spaces.roleOf(9, 7)).thenReturn("editor");
        when(docs.create("未命名白板", 9, "board", 7)).thenReturn("board-key");
        Map<String, String> body = new HashMap<>();
        body.put("spaceId", "9");
        body.put("title", null);
        body.put("kind", "board");

        var response = controller.create(body);
        assertEquals(200, response.getStatusCode().value());
        assertEquals("未命名白板", ((Map<?, ?>) response.getBody()).get("title"));

        body.put("kind", null);
        assertEquals(400, controller.create(body).getStatusCode().value());
    }

    @Test
    void nullRenameTitleIsAValidationErrorWithoutMetadataWrite() {
        DocController controller = documents();
        when(docs.spaceIdOf("doc")).thenReturn(9L);
        when(access.document("doc", user)).thenReturn(new AccessService.DocumentAccess(9, "editor"));
        Map<String, String> body = new HashMap<>();
        body.put("title", null);

        assertEquals(400, controller.update("doc", body).getStatusCode().value());
        verify(docs, never()).updateTitle(anyString(), any());
    }

    @Test
    void nullSpaceNameAndInviteFieldsReturnValidationErrors() {
        when(currentUser.get()).thenReturn(user);
        when(spaces.roleOf(9, 7)).thenReturn("owner");
        SpaceController controller = new SpaceController(spaces, auth, currentUser);
        Map<String, String> body = new HashMap<>();
        body.put("name", null);
        assertEquals(400, controller.create(body).getStatusCode().value());
        verify(spaces, never()).create(any(), anyLong());

        body.put("username", null);
        assertEquals(400, controller.invite(9, body).getStatusCode().value());
        body.put("username", "bob");
        body.put("role", null);
        assertEquals(400, controller.invite(9, body).getStatusCode().value());
        verify(auth, never()).byUsername(anyString());
        verify(spaces, never()).addMember(eq(9L), anyLong(), any());
    }
}
