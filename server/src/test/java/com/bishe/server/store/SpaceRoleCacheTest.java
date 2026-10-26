package com.bishe.server.store;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class SpaceRoleCacheTest {

    @Test
    void stalePermissionReadCannotRepopulateTheCacheAfterRemoval() throws Exception {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        SpaceRepo spaces = new SpaceRepo(jdbc);
        AtomicReference<String> persistedRole = new AtomicReference<>("editor");
        CountDownLatch readStarted = new CountDownLatch(1);
        CountDownLatch releaseRead = new CountDownLatch(1);
        when(jdbc.queryForList(anyString(), eq(String.class), eq(9L), eq(7L))).thenAnswer(ignored -> {
            String captured = persistedRole.get();
            readStarted.countDown();
            assertTrue(releaseRead.await(5, TimeUnit.SECONDS));
            return captured == null ? List.of() : List.of(captured);
        });
        when(jdbc.update(anyString(), eq(9L), eq(7L))).thenAnswer(ignored -> {
            persistedRole.set(null);
            return 1;
        });
        var executor = Executors.newFixedThreadPool(2);
        try {
            var reading = executor.submit(() -> spaces.roleOf(9, 7));
            assertTrue(readStarted.await(5, TimeUnit.SECONDS));
            var removing = executor.submit(() -> spaces.removeMember(9, 7));
            assertThrows(TimeoutException.class, () -> removing.get(50, TimeUnit.MILLISECONDS));
            releaseRead.countDown();
            assertEquals("editor", reading.get(5, TimeUnit.SECONDS));
            assertTrue(removing.get(5, TimeUnit.SECONDS));
            assertNull(spaces.roleOf(9, 7));
        } finally {
            releaseRead.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void roleChangeReplacesCachedWriterAndDatabaseFailureDoesNotPretendSuccess() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        SpaceRepo spaces = new SpaceRepo(jdbc);
        when(jdbc.queryForList(anyString(), eq(String.class), eq(9L), eq(7L))).thenReturn(List.of("editor"));
        when(jdbc.update(anyString(), eq("viewer"), eq(9L), eq(7L))).thenReturn(1);
        assertEquals("editor", spaces.roleOf(9, 7));
        assertTrue(spaces.updateMemberRole(9, 7, "viewer"));
        assertEquals("viewer", spaces.roleOf(9, 7));
        when(jdbc.update(anyString(), eq("editor"), eq(9L), eq(7L)))
                .thenThrow(new IllegalStateException("database unavailable"));
        assertThrows(IllegalStateException.class, () -> spaces.updateMemberRole(9, 7, "editor"));
        assertEquals("viewer", spaces.roleOf(9, 7));
    }
}
