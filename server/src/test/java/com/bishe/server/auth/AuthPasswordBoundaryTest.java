package com.bishe.server.auth;

import com.bishe.server.store.SpaceRepo;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class AuthPasswordBoundaryTest {

    @Test
    void rejectsMultibytePasswordsBeforeBcryptCanSilentlyDiscardTheirSuffix() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        AuthService auth = new AuthService(jdbc, mock(JwtUtil.class), mock(SpaceRepo.class));
        for (String password : new String[]{"密".repeat(25), "密".repeat(24) + "A", "a".repeat(73), "😀".repeat(19)}) {
            var error = assertThrows(IllegalArgumentException.class,
                    () -> auth.register("valid_user", password, "测试用户"));
            assertTrue(error.getMessage().contains("72 字节"));
        }
        verifyNoInteractions(jdbc);
    }

    @Test
    void overLimitLoginCannotMatchAValid72BytePasswordsPrefix() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        AuthService auth = new AuthService(jdbc, mock(JwtUtil.class), mock(SpaceRepo.class));
        var error = assertThrows(IllegalArgumentException.class,
                () -> auth.login("valid_user", "密".repeat(24) + "different suffix"));
        assertEquals("用户名或密码错误", error.getMessage());
        verifyNoInteractions(jdbc);
    }
}
