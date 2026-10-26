package com.bishe.server.ws;

import com.bishe.engine.DocState;
import com.bishe.engine.Element;
import com.bishe.engine.ElementType;
import com.bishe.engine.FieldValue;
import com.bishe.engine.LamportClock;
import com.bishe.engine.Op;
import com.bishe.server.store.OpStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.CloseStatus;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** A durable, single-writer collaboration room for one persisted document. */
public final class CollabRoom {

    private static final Logger log = LoggerFactory.getLogger(CollabRoom.class);

    static final int SNAPSHOT_INTERVAL = 64;
    static final int MAX_WRITE_BATCH = 128;
    static final int MAX_QUEUED_COMMANDS = 8192;
    static final long WRITE_BATCH_DELAY_MILLIS = 1;

    public static final String ROOT_ID = "doc-root";

    private static final AtomicInteger FALLBACK_THREAD_ID = new AtomicInteger();
    private static final ScheduledExecutorService FALLBACK_WRITER =
            Executors.newScheduledThreadPool(2, daemonFactory("room-writer-fallback-", FALLBACK_THREAD_ID));

    public enum ApplyStatus {APPLIED, DUPLICATE, IGNORED}

    public record ApplyResult(ApplyStatus status, long rev, Op op, String opId) {
    }

    private record AcceptedOperation(Op op, long rev, String operationId) {
    }

    private record QueuedOperation(Op op, String opId, CollabSession session) {
    }

    private static final class WriteCommand {
        private final List<QueuedOperation> operations;
        private final boolean externalBatch;
        private final CompletableFuture<List<ApplyResult>> completion = new CompletableFuture<>();

        private WriteCommand(List<QueuedOperation> operations, boolean externalBatch) {
            this.operations = operations;
            this.externalBatch = externalBatch;
        }
    }

    private record PlannedOperation(QueuedOperation request, ApplyStatus status, long rev,
                                    AcceptedOperation duplicateOf) {
    }

    private record PlannedCommand(WriteCommand command, List<PlannedOperation> operations) {
    }

    public static final class OperationRejected extends IllegalArgumentException {
        private final String code;

        public OperationRejected(String code, String message) {
            super(message);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    public static final class JoinRejected extends IllegalStateException {
        private final String code;

        public JoinRejected(String code, String message) {
            super(message);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    private final String docId;
    /** document.kind 元数据；仅 doc 类型拥有 DOC/TEXT 初始投影。 */
    private final String kind;
    /** document.title 的协同投影（数据库元数据仍是权威来源）。 */
    private final String initialTitle;
    /** Authoritative REST metadata, including kinds that have no DOC element. */
    private volatile String metadataTitle;
    private final OpStore store;
    private final ScheduledExecutorService writerExecutor;
    private final DocState state;
    private final NavigableMap<Long, Op> opsByRev = new TreeMap<>();
    private final Map<String, AcceptedOperation> acceptedClocks = new HashMap<>();
    private final Map<String, AcceptedOperation> acceptedOpIds = new HashMap<>();
    private final Map<String, Long> maxCounterByReplica = new HashMap<>();
    private final Object applyLock = new Object();
    private final Object submissionLock = new Object();
    private final AtomicLong revSeq = new AtomicLong();
    private final ConcurrentHashMap<String, CollabSession> sessions = new ConcurrentHashMap<>();
    private final ArrayBlockingQueue<WriteCommand> writeQueue =
            new ArrayBlockingQueue<>(MAX_QUEUED_COMMANDS);
    private final AtomicBoolean drainScheduled = new AtomicBoolean();
    private final AtomicLong serverClockCounter = new AtomicLong();
    private volatile boolean closed;

    public CollabRoom(String docId, OpStore store) {
        this(docId, "doc", defaultTitle(docId), store, FALLBACK_WRITER);
    }

    /** Creates a room with persisted document metadata. */
    public CollabRoom(String docId, String kind, String title, OpStore store) {
        this(docId, kind, title, store, FALLBACK_WRITER);
    }

    /** Compatibility-friendly argument order for adapters created before metadata was added. */
    public CollabRoom(String docId, OpStore store, String kind, String title) {
        this(docId, kind, title, store, FALLBACK_WRITER);
    }

    CollabRoom(String docId, OpStore store, ScheduledExecutorService writerExecutor) {
        this(docId, "doc", defaultTitle(docId), store, writerExecutor);
    }

    CollabRoom(String docId, String kind, String title, OpStore store,
               ScheduledExecutorService writerExecutor) {
        this.docId = Objects.requireNonNull(docId, "docId");
        this.kind = normalizeKind(kind);
        this.initialTitle = normalizeTitle(title, docId);
        this.metadataTitle = this.initialTitle;
        this.store = Objects.requireNonNull(store, "store");
        this.writerExecutor = Objects.requireNonNull(writerExecutor, "writerExecutor");

        DocState restored = new DocState("server:" + docId);
        long restoredFrom = 0;
        OpStore.Snapshot snap = store.latestSnapshot(docId);
        boolean hasSnapshot = snap != null && snap.present();
        List<Element> snapshotElements = List.of();
        if (hasSnapshot) {
            snapshotElements = snap.elements() == null ? List.of() : snap.elements();
            snapshotElements.forEach(restored::putRestoredElement);
            restoredFrom = snap.rev();
            log.info("恢复[{}]：快照 rev={} elements={}", docId, snap.rev(), snapshotElements.size());
        }

        List<OpStore.LoadOp> persisted = store.loadOpsAfterWithSeq(docId, 0);
        if (persisted == null) {
            persisted = List.of();
        }
        for (OpStore.LoadOp row : persisted) {
            if (row.seq() > restoredFrom) {
                restored.apply(row.op());
            }
            opsByRev.put(row.seq(), row.op());
            indexAccepted(row.op(), row.seq(), row.operationId());
        }
        for (Element element : snapshotElements) {
            indexSnapshotOperationClocks(element, snap.rev());
        }
        this.state = restored;
        long persistedMax = store.maxSeq(docId);
        long indexedMax = opsByRev.isEmpty() ? 0 : opsByRev.lastKey();
        revSeq.set(Math.max(Math.max(persistedMax, indexedMax), restoredFrom));
        long maxClock = maxCounterByReplica.values().stream().mapToLong(Long::longValue).max().orElse(0L);
        serverClockCounter.set(maxClock);

        if (!persisted.isEmpty() || restoredFrom > 0) {
            log.info("恢复房间[{}]：日志={}，当前 rev={}", docId, persisted.size(), revSeq.get());
        }
        if (revSeq.get() == 0 && !hasSnapshot && "doc".equals(this.kind)) {
            seedEmptyDocument();
        }
    }

    public String docId() {
        return docId;
    }

    public String kind() {
        return kind;
    }

    public String metadataTitle() {
        return metadataTitle;
    }

    /** Current DOC.title projection, or null for board/kanban rooms. */
    public String currentTitle() {
        if (!"doc".equals(kind)) {
            return null;
        }
        synchronized (applyLock) {
            Element root = state.element(ROOT_ID);
            if (root == null || root.fields().get("title") == null) {
                return null;
            }
            Object value = root.fields().get("title").value();
            return value == null ? null : String.valueOf(value);
        }
    }

    /**
     * Called after an authoritative REST metadata update. All kinds publish
     * metadata; only documents keep the legacy DOC.title projection.
     */
    public synchronized void synchronizeTitle(String title) {
        String normalized = normalizeTitle(title, docId);
        synchronized (applyLock) {
            if (!Objects.equals(metadataTitle, normalized)) {
                metadataTitle = normalized;
                String frame = CollabMessage.metadata(this);
                sessions.values().forEach(session -> session.send(frame));
            }
        }
        synchronizeTitleProjection();
    }

    /** History restore must repair the projection without restoring stale metadata. */
    public synchronized void synchronizeTitleProjection() {
        if (!"doc".equals(kind)) {
            return;
        }
        String normalized = metadataTitle;
        if (Objects.equals(normalized, currentTitle())) {
            return;
        }
        String replica = "server:" + docId;
        long counter = nextServerCounter();
        applyExternal(List.of(Op.put(ROOT_ID, ElementType.DOC, "title", normalized,
                new LamportClock(replica, counter))));
    }

    public DocState state() {
        return state;
    }

    public long currentRev() {
        return revSeq.get();
    }

    public ApplyResult applyOp(Op op) {
        return submit(List.of(new QueuedOperation(Objects.requireNonNull(op), null, null)), false).get(0);
    }

    public ApplyResult applyClientOp(Op op, String opId, CollabSession session) {
        return submit(List.of(new QueuedOperation(Objects.requireNonNull(op), opId,
                Objects.requireNonNull(session))), false).get(0);
    }

    /** History restore is one queue command, so no user operation can interleave its diff. */
    public void applyExternal(List<Op> operations) {
        if (operations.isEmpty()) {
            return;
        }
        List<QueuedOperation> queued = operations.stream()
                .map(op -> new QueuedOperation(Objects.requireNonNull(op), null, null))
                .toList();
        submit(queued, true);
    }

    private List<ApplyResult> submit(List<QueuedOperation> operations, boolean externalBatch) {
        WriteCommand command = new WriteCommand(operations, externalBatch);
        synchronized (submissionLock) {
            if (closed) {
                throw new OperationRejected("ROOM_CLOSED", "协同房间已关闭，请重新连接");
            }
            if (!writeQueue.offer(command)) {
                throw new OperationRejected("ROOM_BUSY", "写入队列已满，请稍后重试");
            }
        }
        scheduleDrain();
        try {
            return command.completion.join();
        } catch (CompletionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw new IllegalStateException("协同写入失败", cause);
        }
    }

    private void scheduleDrain() {
        if (!drainScheduled.compareAndSet(false, true)) {
            return;
        }
        try {
            writerExecutor.schedule(this::drainOnce, WRITE_BATCH_DELAY_MILLIS, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            drainScheduled.set(false);
            failQueued(e);
        }
    }

    private void drainOnce() {
        List<WriteCommand> commands = new ArrayList<>(MAX_WRITE_BATCH);
        try {
            writeQueue.drainTo(commands, MAX_WRITE_BATCH);
            if (!commands.isEmpty()) {
                processCommands(commands);
            }
        } catch (Throwable e) {
            log.error("房间写队列异常 doc={}", docId, e);
            commands.forEach(command -> command.completion.completeExceptionally(e));
        } finally {
            drainScheduled.set(false);
            if (!writeQueue.isEmpty() && !closed) {
                scheduleDrain();
            }
        }
    }

    private void processCommands(List<WriteCommand> commands) {
        String snapshotJson = null;
        long snapshotRev = 0;
        List<PlannedCommand> plannedCommands = new ArrayList<>(commands.size());

        synchronized (applyLock) {
            if (closed) {
                OperationRejected failure = new OperationRejected("ROOM_CLOSED", "协同房间已关闭，请重新连接");
                commands.forEach(command -> command.completion.completeExceptionally(failure));
                return;
            }

            long initialRev = revSeq.get();
            PlanningContext context = new PlanningContext(initialRev);
            for (WriteCommand command : commands) {
                PlanningContext target = command.externalBatch ? new PlanningContext(context) : context;
                List<PlannedOperation> commandPlan = new ArrayList<>(command.operations.size());
                try {
                    for (QueuedOperation operation : command.operations) {
                        commandPlan.add(planOne(target, operation));
                    }
                    if (command.externalBatch) {
                        context = target;
                    }
                    plannedCommands.add(new PlannedCommand(command, commandPlan));
                } catch (RuntimeException e) {
                    command.completion.completeExceptionally(e);
                }
            }

            List<OpStore.AppendEntry> durable = new ArrayList<>();
            for (PlannedCommand command : plannedCommands) {
                for (PlannedOperation operation : command.operations()) {
                    if (operation.status() == ApplyStatus.APPLIED) {
                        QueuedOperation request = operation.request();
                        durable.add(new OpStore.AppendEntry(request.op(), operationIdentity(request),
                                request.session() == null ? null : request.session().userId(), operation.rev()));
                    }
                }
            }

            try {
                if (!durable.isEmpty()) {
                    store.appendBatch(docId, durable);
                }
            } catch (RuntimeException e) {
                plannedCommands.forEach(command -> command.command().completion.completeExceptionally(e));
                return;
            }

            long finalRev = context.nextRev;
            for (PlannedCommand command : plannedCommands) {
                List<ApplyResult> results = new ArrayList<>(command.operations().size());
                for (PlannedOperation planned : command.operations()) {
                    QueuedOperation request = planned.request();
                    if (planned.status() == ApplyStatus.APPLIED) {
                        commitApplied(request, planned.rev());
                        String frame = CollabMessage.applied(planned.rev(), request.op(),
                                request.opId(), false, false);
                        sessions.values().forEach(session -> session.send(frame));
                        results.add(new ApplyResult(ApplyStatus.APPLIED, planned.rev(),
                                request.op(), request.opId()));
                    } else if (planned.status() == ApplyStatus.IGNORED) {
                        commitIgnored(request, finalRev);
                        results.add(new ApplyResult(ApplyStatus.IGNORED, finalRev,
                                request.op(), request.opId()));
                    } else {
                        commitDuplicateAlias(request, planned.duplicateOf());
                        if (request.session() != null) {
                            request.session().recordAccepted(request.op());
                        }
                        results.add(new ApplyResult(ApplyStatus.DUPLICATE, finalRev,
                                request.op(), request.opId()));
                    }
                }
                command.command().completion.complete(results);
            }

            if (finalRev / SNAPSHOT_INTERVAL > initialRev / SNAPSHOT_INTERVAL) {
                snapshotRev = finalRev;
                snapshotJson = OpStore.encodeElements(new ArrayList<>(state.elements().values()));
            }
        }

        if (snapshotJson != null) {
            scheduleSnapshot(snapshotRev, snapshotJson);
        }
    }

    private PlannedOperation planOne(PlanningContext context, QueuedOperation request) {
        if (request.session() != null) {
            CollabSession session = request.session();
            if (session.userId() > 0 && sessions.get(session.clientId()) != session) {
                throw new OperationRejected("MEMBERSHIP_REVOKED", "此协同会话已失效，请重新进入内容");
            }
            if (!session.canWrite()) {
                throw new OperationRejected("READ_ONLY", "只读成员（viewer）不可编辑");
            }
        }
        Op op = request.op();
        AcceptedOperation byClock = context.clock(op.clock().toString());
        if (byClock != null) {
            if (!sameOperation(byClock.op(), op)) {
                throw new OperationRejected("CLOCK_CONFLICT", "同一 clock 不得复用于不同操作");
            }
            if (request.opId() != null) {
                context.alias(request.opId(), byClock);
            }
            return new PlannedOperation(request, ApplyStatus.DUPLICATE, context.nextRev, byClock);
        }

        if (request.opId() != null) {
            AcceptedOperation byId = context.operationId(request.opId());
            if (byId != null) {
                if (!sameOperation(byId.op(), op)) {
                    throw new OperationRejected("OP_ID_CONFLICT", "同一 opId 不得复用于不同操作");
                }
                return new PlannedOperation(request, ApplyStatus.DUPLICATE, context.nextRev, byId);
            }
        }

        validateEngineOperation(op);
        long currentMax = context.maxCounter(op.clock().replicaId());
        if (request.session() != null) {
            currentMax = Math.max(currentMax, request.session().lastAcceptedCounter());
        }
        if (op.clock().counter() <= currentMax) {
            throw new OperationRejected("CLOCK_OUT_OF_ORDER", "clock.counter 必须严格递增");
        }

        Element stagedElement = context.element(op.elementId());
        if (op.type() != Op.Type.STATE && stagedElement != null && stagedElement.fields().containsKey("#version")) {
            throw new OperationRejected("UPGRADE_REQUIRED", "该元素已使用新版协同协议，请刷新客户端");
        }
        if (op.type() != Op.Type.STATE && !wouldChangeState(stagedElement, op)) {
            AcceptedOperation ignored = new AcceptedOperation(op, context.nextRev, operationIdentity(request));
            context.accept(ignored);
            return new PlannedOperation(request, ApplyStatus.IGNORED, context.nextRev, null);
        }

        long nextRev = Math.addExact(context.nextRev, 1);
        context.nextRev = nextRev;
        context.apply(op);
        AcceptedOperation accepted = new AcceptedOperation(op, nextRev, operationIdentity(request));
        context.accept(accepted);
        return new PlannedOperation(request, ApplyStatus.APPLIED, nextRev, null);
    }

    private void commitApplied(QueuedOperation request, long rev) {
        Op op = request.op();
        state.apply(op);
        opsByRev.put(rev, op);
        revSeq.set(rev);
        AcceptedOperation accepted = new AcceptedOperation(op, rev, operationIdentity(request));
        acceptedClocks.put(op.clock().toString(), accepted);
        acceptedOpIds.put(accepted.operationId(), accepted);
        maxCounterByReplica.merge(op.clock().replicaId(), op.clock().counter(), Math::max);
        if (request.session() != null) {
            request.session().recordAccepted(op);
        }
    }

    private void commitIgnored(QueuedOperation request, long rev) {
        Op op = request.op();
        AcceptedOperation ignored = new AcceptedOperation(op, rev, operationIdentity(request));
        acceptedClocks.put(op.clock().toString(), ignored);
        acceptedOpIds.put(ignored.operationId(), ignored);
        maxCounterByReplica.merge(op.clock().replicaId(), op.clock().counter(), Math::max);
        if (request.session() != null) {
            request.session().recordAccepted(op);
        }
    }

    private void commitDuplicateAlias(QueuedOperation request, AcceptedOperation duplicateOf) {
        if (request.opId() != null) {
            acceptedOpIds.putIfAbsent(request.opId(), duplicateOf);
        }
    }

    private void scheduleSnapshot(long rev, String json) {
        try {
            writerExecutor.execute(() -> {
                try {
                    store.saveSnapshot(docId, rev, json);
                } catch (RuntimeException e) {
                    log.error("保存快照失败 doc={} rev={}", docId, rev, e);
                }
            });
        } catch (RejectedExecutionException e) {
            log.warn("快照任务被拒绝 doc={} rev={}", docId, rev);
        }
    }

    private void failQueued(Throwable cause) {
        List<WriteCommand> failed = new ArrayList<>();
        writeQueue.drainTo(failed);
        failed.forEach(command -> command.completion.completeExceptionally(cause));
    }

    /** Returns null when the requested revision is outside the retained contiguous window. */
    public List<Op> opsAfter(long lastRev) {
        synchronized (applyLock) {
            return incrementalAfter(lastRev);
        }
    }

    /** Snapshot/delta enqueue and session registration share the same commit lock as room writes. */
    public void joinAndSync(CollabSession session, long lastRev) {
        joinAndSync(session, lastRev, null);
    }

    /** Revalidate membership inside registration to close a concurrent removal/join race. */
    public synchronized void joinAndSync(CollabSession session, long lastRev, Supplier<String> currentRole) {
        synchronized (applyLock) {
            ensureOpenForJoin();
            if (currentRole != null) {
                String role = currentRole.get();
                if (role == null) {
                    throw new JoinRejected("MEMBERSHIP_REVOKED", "你已不再是该空间成员");
                }
                session.updateRole(role);
            }
            CollabSession existing = sessions.get(session.clientId());
            if (existing != null && existing != session
                    && existing.userId() > 0 && session.userId() > 0
                    && existing.userId() != session.userId()) {
                throw new JoinRejected("CLIENT_ID_IN_USE", "clientId 已被其他成员使用");
            }

            session.initializeCounter(maxCounterByReplica.getOrDefault(session.clientId(), 0L));
            sessions.put(session.clientId(), session);
            if (existing != null && existing != session) {
                existing.forceClose();
            }

            List<Op> delta = lastRev > 0 && lastRev <= revSeq.get()
                    ? incrementalAfter(lastRev) : null;
            String sync = delta == null
                    ? CollabMessage.welcome(session, this)
                    : CollabMessage.incremental(lastRev, revSeq.get(), delta, session, this);
            if (!session.send(sync)) {
                sessions.remove(session.clientId(), session);
                throw new JoinRejected("SYNC_FAILED", "初始同步发送失败");
            }
            broadcastPresenceLocked();
        }
    }

    public void join(CollabSession session) {
        synchronized (applyLock) {
            ensureOpenForJoin();
            CollabSession old = sessions.put(session.clientId(), session);
            if (old != null && old != session) {
                old.forceClose();
            }
            broadcastPresenceLocked();
        }
    }

    public int occupantCount() {
        return sessions.size();
    }

    int queuedWriteCount() {
        return writeQueue.size();
    }

    public void leave(CollabSession session) {
        synchronized (applyLock) {
            if (sessions.remove(session.clientId(), session)) {
                broadcastPresenceLocked();
            }
        }
    }

    /** Refresh every tab for one member while excluding concurrent room commits. */
    public void refreshMemberAccess(long userId, Supplier<String> currentRole) {
        synchronized (applyLock) {
            if (closed || sessions.values().stream().noneMatch(session -> session.userId() == userId)) {
                return;
            }
            String role = currentRole.get();
            boolean removed = false;
            for (CollabSession session : new ArrayList<>(sessions.values())) {
                if (session.userId() != userId) continue;
                if (role == null) {
                    sessions.remove(session.clientId(), session);
                    session.send(CollabMessage.error("MEMBERSHIP_REVOKED", "空间所有者已将你移出此空间", true));
                    session.close(CloseStatus.POLICY_VIOLATION);
                    removed = true;
                } else if (!Objects.equals(session.role(), role)) {
                    session.updateRole(role);
                    session.send(CollabMessage.access(session));
                }
            }
            if (removed) broadcastPresenceLocked();
        }
    }

    /** Called by RoomRegistry while evicting an unoccupied, fully drained room. */
    boolean closeIfIdle() {
        synchronized (applyLock) {
            synchronized (submissionLock) {
                if (closed || !sessions.isEmpty() || !writeQueue.isEmpty() || drainScheduled.get()) {
                    return false;
                }
                closed = true;
                return true;
            }
        }
    }

    void closeNow() {
        synchronized (applyLock) {
            stopAcceptingWrites(new OperationRejected("ROOM_CLOSED", "协同房间已关闭，请重新连接"));
            sessions.values().forEach(CollabSession::forceClose);
            sessions.clear();
        }
    }

    /**
     * Serialize soft deletion with durable commits and joins. Already committed
     * edits precede deletion; queued edits are rejected, and every open client
     * receives a terminal reason instead of waiting for their next write.
     */
    boolean deleteIf(BooleanSupplier delete) {
        synchronized (applyLock) {
            if (!delete.getAsBoolean()) {
                return false;
            }
            stopAcceptingWrites(new OperationRejected("DOCUMENT_DELETED", "此内容已被空间所有者删除"));
            String error = CollabMessage.error("DOCUMENT_DELETED", "此内容已被空间所有者删除", true);
            sessions.values().forEach(session -> {
                session.send(error);
                session.close(CloseStatus.POLICY_VIOLATION);
            });
            sessions.clear();
            return true;
        }
    }

    private void stopAcceptingWrites(OperationRejected reason) {
        synchronized (submissionLock) {
            closed = true;
            failQueued(reason);
        }
    }

    private void ensureOpenForJoin() {
        if (closed) {
            throw new JoinRejected("ROOM_CLOSED", "协同房间已关闭，请重新连接");
        }
    }

    private List<Op> incrementalAfter(long lastRev) {
        long current = revSeq.get();
        if (lastRev < 0 || lastRev > current) {
            return null;
        }
        if (lastRev == current) {
            return List.of();
        }
        if (opsByRev.isEmpty()) {
            return null;
        }
        long expectedFirst = lastRev + 1;
        Long actualFirst = opsByRev.higherKey(lastRev);
        if (actualFirst == null || actualFirst != expectedFirst) {
            return null;
        }
        NavigableMap<Long, Op> tail = opsByRev.tailMap(expectedFirst, true);
        long expected = expectedFirst;
        List<Op> result = new ArrayList<>(tail.size());
        for (Map.Entry<Long, Op> entry : tail.entrySet()) {
            if (entry.getKey() != expected++) {
                return null;
            }
            result.add(entry.getValue());
        }
        return expected - 1 == current ? result : null;
    }

    private void broadcastPresenceLocked() {
        String message = CollabMessage.presence(sessions.values());
        sessions.values().forEach(session -> session.send(message));
    }

    private static void validateEngineOperation(Op op) {
        if (op.type() == Op.Type.ADD && op.elementType() == null) {
            throw new OperationRejected("INVALID_OP", "ADD 必须声明 elementType");
        }
        if (op.type() == Op.Type.PUT && (op.field() == null || op.field().isBlank())) {
            throw new OperationRejected("INVALID_OP", "PUT 必须声明 field");
        }
    }

    private static boolean wouldChangeState(Element element, Op op) {
        if (element == null) {
            return true;
        }
        boolean identityChanges = op.elementType() != null
                && (op.clock().compareTo(element.rootClock()) > 0
                || (op.clock().compareTo(element.rootClock()) == 0
                && op.elementType().name().compareTo(element.type().name()) > 0));
        if (op.type() == Op.Type.ADD) {
            return identityChanges;
        }
        String field = op.type() == Op.Type.DELETE ? Element.TOMBSTONE_KEY : op.field();
        FieldValue previous = element.fields().get(field);
        return identityChanges || previous == null || op.clock().compareTo(previous.writtenAt()) > 0;
    }

    private void seedEmptyDocument() {
        long counter = 1;
        String replica = "server:" + docId;
        applyExternal(List.of(
                Op.add(ROOT_ID, ElementType.DOC, new LamportClock(replica, counter++)),
                Op.put(ROOT_ID, ElementType.DOC, "title",
                        initialTitle,
                        new LamportClock(replica, counter++)),
                Op.add("seg-root-01", ElementType.TEXT, new LamportClock(replica, counter++)),
                Op.put("seg-root-01", ElementType.TEXT, "order", 1,
                        new LamportClock(replica, counter))));
        log.info("新文档[{}]：已播种 doc-root + 首个段落（rev={}）", docId, revSeq.get());
    }

    private void indexSnapshotOperationClocks(Element element, long snapshotRev) {
        if (element.fields().containsKey("#version")) return; // v2 identities are restored from durable logs.
        element.fields().forEach((field, value) -> {
            Op op = Element.TOMBSTONE_KEY.equals(field)
                    ? Op.delete(element.id(), element.type(), value.writtenAt())
                    : Op.put(element.id(), element.type(), field, value.value(), value.writtenAt());
            indexAccepted(op, snapshotRev, null);
        });
        indexAccepted(Op.add(element.id(), element.type(), element.rootClock()), snapshotRev, null);
    }

    private void indexAccepted(Op op, long rev, String operationId) {
        String identity = operationId == null || operationId.isBlank()
                ? op.clock().toString() : operationId;
        AcceptedOperation accepted = new AcceptedOperation(op, rev, identity);
        AcceptedOperation previous = acceptedClocks.putIfAbsent(op.clock().toString(), accepted);
        if (previous != null && !sameOperation(previous.op(), op)) {
            log.warn("历史日志存在 clock 冲突 doc={} clock={}", docId, op.clock());
        }
        if (operationId != null && !operationId.isBlank()) {
            acceptedOpIds.putIfAbsent(operationId, accepted);
        }
        maxCounterByReplica.merge(op.clock().replicaId(), op.clock().counter(), Math::max);
    }

    private static String operationIdentity(QueuedOperation request) {
        return request.opId() == null || request.opId().isBlank()
                ? request.op().clock().toString() : request.opId();
    }

    private static boolean sameOperation(Op left, Op right) {
        return left.type() == right.type()
                && Objects.equals(left.elementId(), right.elementId())
                && left.elementType() == right.elementType()
                && Objects.equals(left.field(), right.field())
                && equivalentValue(left.value(), right.value())
                && Objects.equals(left.clock(), right.clock());
    }

    private static boolean equivalentValue(Object left, Object right) {
        if (left instanceof Map<?, ?> a && right instanceof Map<?, ?> b) {
            if (!a.keySet().equals(b.keySet())) return false;
            return a.keySet().stream().allMatch(key -> equivalentValue(a.get(key), b.get(key)));
        }
        if (left instanceof Number a && right instanceof Number b) {
            return Double.compare(a.doubleValue(), b.doubleValue()) == 0;
        }
        return Objects.equals(left, right);
    }

    private static ThreadFactory daemonFactory(String prefix, AtomicInteger ids) {
        return task -> {
            Thread thread = new Thread(task, prefix + ids.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }

    private long nextServerCounter() {
        synchronized (applyLock) {
            long observedMax = maxCounterByReplica.values().stream()
                    .mapToLong(Long::longValue).max().orElse(0L);
            long current = serverClockCounter.get();
            long next = Math.max(current, observedMax);
            if (next == Long.MAX_VALUE) {
                throw new OperationRejected("CLOCK_EXHAUSTED", "服务端 Lamport 时钟已耗尽");
            }
            next++;
            serverClockCounter.set(next);
            return next;
        }
    }

    private static String normalizeKind(String kind) {
        String value = kind == null ? "doc" : kind.trim();
        return switch (value) {
            case "board", "kanban" -> value;
            default -> "doc";
        };
    }

    private static String defaultTitle(String docId) {
        return docId.length() > 8 ? docId.substring(0, 8) : docId;
    }

    private static String normalizeTitle(String title, String docId) {
        if (title == null || title.isBlank()) {
            return defaultTitle(docId);
        }
        return title.trim();
    }

    /** Overlay used to plan a whole JDBC batch without exposing state before commit. */
    private final class PlanningContext {
        private final DocState stagedState = new DocState("server:plan:" + docId);
        private final Set<String> loadedElements = new HashSet<>();
        private final Map<String, AcceptedOperation> clockOverlay = new HashMap<>();
        private final Map<String, AcceptedOperation> operationIdOverlay = new HashMap<>();
        private final Map<String, Long> maxCounterOverlay = new HashMap<>();
        private long nextRev;

        private PlanningContext(long nextRev) {
            this.nextRev = nextRev;
        }

        private PlanningContext(PlanningContext source) {
            this.nextRev = source.nextRev;
            this.loadedElements.addAll(source.loadedElements);
            source.stagedState.elements().values().forEach(stagedState::putRestoredElement);
            this.clockOverlay.putAll(source.clockOverlay);
            this.operationIdOverlay.putAll(source.operationIdOverlay);
            this.maxCounterOverlay.putAll(source.maxCounterOverlay);
        }

        private Element element(String id) {
            if (loadedElements.add(id)) {
                Element existing = state.element(id);
                if (existing != null) {
                    stagedState.putRestoredElement(existing);
                }
            }
            return stagedState.element(id);
        }

        private void apply(Op op) {
            element(op.elementId());
            stagedState.apply(op);
        }

        private AcceptedOperation clock(String clock) {
            AcceptedOperation staged = clockOverlay.get(clock);
            return staged != null ? staged : acceptedClocks.get(clock);
        }

        private AcceptedOperation operationId(String operationId) {
            AcceptedOperation staged = operationIdOverlay.get(operationId);
            return staged != null ? staged : acceptedOpIds.get(operationId);
        }

        private long maxCounter(String replicaId) {
            return maxCounterOverlay.getOrDefault(replicaId,
                    maxCounterByReplica.getOrDefault(replicaId, 0L));
        }

        private void accept(AcceptedOperation accepted) {
            clockOverlay.put(accepted.op().clock().toString(), accepted);
            operationIdOverlay.put(accepted.operationId(), accepted);
            maxCounterOverlay.merge(accepted.op().clock().replicaId(),
                    accepted.op().clock().counter(), Math::max);
        }

        private void alias(String operationId, AcceptedOperation accepted) {
            AcceptedOperation previous = operationId(operationId);
            if (previous != null && !sameOperation(previous.op(), accepted.op())) {
                throw new OperationRejected("OP_ID_CONFLICT", "同一 opId 不得复用于不同操作");
            }
            operationIdOverlay.putIfAbsent(operationId, accepted);
        }
    }
}
