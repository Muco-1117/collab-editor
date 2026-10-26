package com.bishe.server.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ProfileApiTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired AuthService auth;

    private record Account(long id, String username, String token) {}

    private Account account() throws Exception {
        String username = "profile_" + UUID.randomUUID().toString().substring(0, 8);
        var result = mvc.perform(post("/api/auth/register").contentType("application/json")
                .content(json.writeValueAsString(Map.of("username", username, "password", "profile-pass-123", "nickname", "初始昵称"))))
                .andExpect(status().isOk()).andReturn();
        JsonNode data = json.readTree(result.getResponse().getContentAsString());
        return new Account(data.path("user").path("id").asLong(), username, data.path("token").asText());
    }

    private JsonNode me(Account user) throws Exception {
        return json.readTree(mvc.perform(get("/api/auth/me").header("Authorization", "Bearer " + user.token()))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString()).path("user");
    }

    @Test
    void nicknamePersistsWithoutChangingLoginRoleOrAnotherUser() throws Exception {
        Account first = account(), second = account();
        mvc.perform(put("/api/auth/me").header("Authorization", "Bearer " + first.token()).contentType("application/json")
                        .content(json.writeValueAsString(Map.of("nickname", "  新昵称  ", "id", second.id(), "username", "changed", "role", "admin"))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.user.nickname").value("新昵称"));
        assertEquals("新昵称", auth.byId(first.id()).nickname());
        assertEquals(first.username(), me(first).path("username").asText());
        assertEquals("editor", me(first).path("role").asText());
        assertEquals("初始昵称", me(second).path("nickname").asText());
        for (String invalid : new String[]{"", "   ", "a".repeat(33), "bad\u0001name"}) {
            mvc.perform(put("/api/auth/me").header("Authorization", "Bearer " + first.token()).contentType("application/json")
                    .content(json.writeValueAsString(Map.of("nickname", invalid)))).andExpect(status().isBadRequest());
        }
        assertEquals("新昵称", me(first).path("nickname").asText());
        mvc.perform(post("/api/auth/login").contentType("application/json").content(json.writeValueAsString(
                Map.of("username", first.username(), "password", "profile-pass-123")))).andExpect(status().isOk());
    }

    private byte[] picture() throws Exception {
        BufferedImage image = new BufferedImage(600, 400, BufferedImage.TYPE_INT_RGB);
        var g = image.createGraphics();
        g.setColor(Color.GREEN); g.fillRect(0, 0, 600, 400); g.dispose();
        var output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }

    @Test
    void avatarIsNormalizedVersionedPersistentAndIsolated() throws Exception {
        Account first = account(), second = account();
        mvc.perform(multipart("/api/auth/me/avatar").file(new MockMultipartFile("file", "avatar.png", "image/png", picture()))
                .with(request -> { request.setMethod("PUT"); return request; }).header("Authorization", "Bearer " + first.token()))
                .andExpect(status().isOk());
        String initialUrl = me(first).path("avatarUrl").asText();
        assertTrue(initialUrl.startsWith("/api/users/" + first.id() + "/avatar?v="));
        byte[] bytes = mvc.perform(get(initialUrl).header("Authorization", "Bearer " + second.token()))
                .andExpect(status().isOk()).andExpect(content().contentType("image/png"))
                .andExpect(header().string("Cache-Control", "no-store")).andReturn().getResponse().getContentAsByteArray();
        var image = ImageIO.read(new ByteArrayInputStream(bytes));
        assertEquals(256, image.getWidth()); assertEquals(256, image.getHeight());
        assertEquals("", me(second).path("avatarUrl").asText());
        mvc.perform(multipart("/api/auth/me/avatar").file(new MockMultipartFile("file", "new.png", "image/png", picture()))
                .with(request -> { request.setMethod("PUT"); return request; }).header("Authorization", "Bearer " + first.token()))
                .andExpect(status().isOk());
        assertNotEquals(initialUrl, me(first).path("avatarUrl").asText());
        mvc.perform(delete("/api/auth/me/avatar").header("Authorization", "Bearer " + first.token())).andExpect(status().isOk());
        assertEquals("", me(first).path("avatarUrl").asText());
        mvc.perform(get("/api/users/" + first.id() + "/avatar").header("Authorization", "Bearer " + first.token())).andExpect(status().isNotFound());
    }

    @Test
    void invalidAvatarLeavesExistingPictureUnchanged() throws Exception {
        Account user = account();
        mvc.perform(multipart("/api/auth/me/avatar").file(new MockMultipartFile("file", "valid.png", "image/png", picture()))
                .with(request -> { request.setMethod("PUT"); return request; }).header("Authorization", "Bearer " + user.token()))
                .andExpect(status().isOk());
        String original = me(user).path("avatarUrl").asText();
        for (MockMultipartFile file : new MockMultipartFile[]{
                new MockMultipartFile("file", "a.svg", "image/svg+xml", "<svg/>".getBytes()),
                new MockMultipartFile("file", "fake.png", "image/png", "not-an-image".getBytes()),
                new MockMultipartFile("file", "mismatch.jpg", "image/jpeg", picture()),
                new MockMultipartFile("file", "empty.png", "image/png", new byte[0]),
                new MockMultipartFile("file", "large.png", "image/png", new byte[2 * 1024 * 1024 + 1])}) {
            mvc.perform(multipart("/api/auth/me/avatar").file(file)
                    .with(request -> { request.setMethod("PUT"); return request; }).header("Authorization", "Bearer " + user.token()))
                    .andExpect(status().isBadRequest());
        }
        assertEquals(original, me(user).path("avatarUrl").asText());
    }

    @Test
    void allProfileChangesAndAvatarReadsRequireAuthentication() throws Exception {
        mvc.perform(put("/api/auth/me").contentType("application/json").content("{\"nickname\":\"x\"}"))
                .andExpect(status().isUnauthorized());
        mvc.perform(multipart("/api/auth/me/avatar").file(new MockMultipartFile("file", "a.png", "image/png", picture()))
                .with(request -> { request.setMethod("PUT"); return request; })).andExpect(status().isUnauthorized());
        mvc.perform(delete("/api/auth/me/avatar")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/users/1/avatar")).andExpect(status().isUnauthorized());
    }
}
