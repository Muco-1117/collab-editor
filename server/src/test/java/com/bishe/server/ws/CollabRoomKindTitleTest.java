package com.bishe.server.ws;

import com.bishe.engine.ElementType;
import com.bishe.server.store.OpStore;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Regression coverage for metadata-aware room initialization and title projection. */
class CollabRoomKindTitleTest {

    @Test
    void documentRoomSeedsOnlyDocumentProjectionWithPersistedTitle() {
        OpStore store = emptyStore();

        CollabRoom room = new CollabRoom("doc-kind", "doc", "毕业设计正文", store);
        try {
            assertEquals("doc", room.kind());
            assertEquals(4, room.currentRev());
            assertEquals(2, room.state().size());
            assertEquals(ElementType.DOC, room.state().element(CollabRoom.ROOT_ID).type());
            assertEquals("毕业设计正文", room.currentTitle());
        } finally {
            room.closeNow();
        }
    }

    @Test
    void boardAndKanbanRoomsStartEmptyAndDoNotWriteDocumentSeed() {
        OpStore store = emptyStore();

        CollabRoom board = new CollabRoom("board-kind", "board", "项目白板", store);
        CollabRoom kanban = new CollabRoom("kanban-kind", "kanban", "研发看板", store);
        try {
            assertEquals(0, board.currentRev());
            assertEquals(0, board.state().size());
            assertNull(board.currentTitle());
            assertEquals(0, kanban.currentRev());
            assertEquals(0, kanban.state().size());
            assertNull(kanban.currentTitle());
            verify(store, never()).appendBatch(eq("board-kind"), any());
            verify(store, never()).appendBatch(eq("kanban-kind"), any());
        } finally {
            board.closeNow();
            kanban.closeNow();
        }
    }

    @Test
    void titleSynchronizationWritesAProjectionOnlyWhenItChanges() {
        OpStore store = emptyStore();
        CollabRoom room = new CollabRoom("title-kind", "doc", "初始标题", store);
        try {
            room.synchronizeTitle("初始标题");
            assertEquals(4, room.currentRev());

            room.synchronizeTitle("更新标题");
            assertEquals(5, room.currentRev());
            assertEquals("更新标题", room.currentTitle());
            verify(store).appendBatch(eq("title-kind"), org.mockito.ArgumentMatchers.argThat(entries ->
                    entries.size() == 1
                            && entries.get(0).op().elementType() == ElementType.DOC
                            && "title".equals(entries.get(0).op().field())
                            && "更新标题".equals(entries.get(0).op().value())));
        } finally {
            room.closeNow();
        }
    }

    private static OpStore emptyStore() {
        OpStore store = mock(OpStore.class);
        when(store.latestSnapshot(anyString())).thenAnswer(invocation ->
                new OpStore.Snapshot(invocation.getArgument(0), 0, null, false));
        when(store.loadOpsAfterWithSeq(anyString(), eq(0L))).thenReturn(List.of());
        when(store.maxSeq(anyString())).thenReturn(0L);
        return store;
    }
}
