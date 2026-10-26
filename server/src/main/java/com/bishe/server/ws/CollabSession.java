package com.bishe.server.ws;

import com.bishe.engine.Op;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/** Per-connection identity, ordered outbound queue and Lamport sequencing state. */
public final class CollabSession {

    static final int MAX_PENDING_FRAMES = 4096;
    static final long MAX_PENDING_CHARS = 8L * 1024 * 1024;

    private sealed interface Outbound permits OutboundText, OutboundClose {
    }

    private record OutboundText(String json) implements Outbound {
    }

    private record OutboundClose(CloseStatus status) implements Outbound {
    }

    private final String clientId;
    private final String hostname;
    private final long userId;
    private final String displayName;
    private volatile String role;
    private final WebSocketSession socket;
    private final Object enqueueLock = new Object();
    private final Object clockLock = new Object();
    private final ArrayBlockingQueue<Outbound> outbound = new ArrayBlockingQueue<>(MAX_PENDING_FRAMES);
    private final AtomicLong lastHeartbeatAt = new AtomicLong(System.currentTimeMillis());
    private long pendingChars;
    private long lastAcceptedCounter;
    private boolean senderStarted;
    private volatile boolean closing;
    private volatile boolean terminal;

    public CollabSession(String clientId, String hostname, WebSocketSession socket) {
        this(clientId, hostname, socket, 0,
                hostname == null || hostname.isBlank() ? clientId : hostname, "editor");
    }

    public CollabSession(String clientId, String hostname, WebSocketSession socket, String role) {
        this(clientId, hostname, socket, 0,
                hostname == null || hostname.isBlank() ? clientId : hostname, role);
    }

    public CollabSession(String clientId, String hostname, WebSocketSession socket,
                         long userId, String displayName, String role) {
        this.clientId = Objects.requireNonNull(clientId, "clientId");
        this.hostname = hostname == null ? "" : hostname;
        this.socket = socket;
        this.userId = userId;
        this.displayName = displayName == null || displayName.isBlank() ? clientId : displayName;
        this.role = role == null ? "viewer" : role;
    }

    public String clientId() {
        return clientId;
    }

    public String hostname() {
        return hostname;
    }

    public long userId() {
        return userId;
    }

    public String displayName() {
        return displayName;
    }

    /** Current room access hint; REST member changes update it under the room commit lock. */
    public String role() {
        return role;
    }

    void updateRole(String role) {
        this.role = role == null ? "viewer" : role;
    }

    public boolean canWrite() {
        return canWriteRole(role);
    }

    public boolean isOpen() {
        return !closing && !terminal && socket != null && socket.isOpen();
    }

    /**
     * Enqueues one frame without blocking a room writer. A full queue is treated as a failed
     * transport: the socket is closed explicitly so the client resumes from its last revision.
     */
    public boolean send(String json) {
        Objects.requireNonNull(json, "json");
        boolean overflow = false;
        synchronized (enqueueLock) {
            if (closing || terminal || socket == null || !socket.isOpen()) {
                return false;
            }
            long nextChars = pendingChars + json.length();
            if (nextChars > MAX_PENDING_CHARS || !outbound.offer(new OutboundText(json))) {
                closing = true;
                terminal = true;
                overflow = true;
            } else {
                pendingChars = nextChars;
                startSenderLocked();
            }
        }
        if (overflow) {
            abortSocket(CloseStatus.SESSION_NOT_RELIABLE);
            return false;
        }
        return true;
    }

    void assertClockAdvances(Op op) {
        synchronized (clockLock) {
            if (op.clock().counter() <= lastAcceptedCounter) {
                throw new CollabRoom.OperationRejected("CLOCK_OUT_OF_ORDER",
                        "clock.counter 必须严格递增");
            }
        }
    }

    void recordAccepted(Op op) {
        synchronized (clockLock) {
            lastAcceptedCounter = Math.max(lastAcceptedCounter, op.clock().counter());
        }
    }

    void initializeCounter(long counter) {
        synchronized (clockLock) {
            lastAcceptedCounter = Math.max(lastAcceptedCounter, counter);
        }
    }

    long lastAcceptedCounter() {
        synchronized (clockLock) {
            return lastAcceptedCounter;
        }
    }

    public void markHeartbeat() {
        lastHeartbeatAt.set(System.currentTimeMillis());
    }

    public long lastHeartbeatAt() {
        return lastHeartbeatAt.get();
    }

    public void forceClose() {
        synchronized (enqueueLock) {
            closing = true;
            terminal = true;
            outbound.clear();
            pendingChars = 0;
        }
        abortSocket(CloseStatus.POLICY_VIOLATION);
    }

    /** Queues close after every already accepted text frame, preserving error-before-close order. */
    public void close(CloseStatus status) {
        boolean abort = false;
        synchronized (enqueueLock) {
            if (closing || terminal) {
                return;
            }
            closing = true;
            if (!outbound.offer(new OutboundClose(status))) {
                terminal = true;
                abort = true;
            } else {
                startSenderLocked();
            }
        }
        if (abort) {
            abortSocket(status);
        }
    }

    int pendingFrameCount() {
        return outbound.size();
    }

    private void startSenderLocked() {
        if (senderStarted) {
            return;
        }
        senderStarted = true;
        Thread sender = new Thread(this::sendLoop, "ws-send-" + clientId);
        sender.setDaemon(true);
        sender.start();
    }

    private void sendLoop() {
        try {
            while (!terminal) {
                Outbound next = outbound.poll(1, TimeUnit.SECONDS);
                if (next == null) {
                    if (socket == null || !socket.isOpen()) {
                        terminal = true;
                    }
                    continue;
                }
                if (next instanceof OutboundText text) {
                    synchronized (enqueueLock) {
                        pendingChars = Math.max(0, pendingChars - text.json().length());
                    }
                    if (socket == null || !socket.isOpen()) {
                        failTransport();
                        return;
                    }
                    socket.sendMessage(new TextMessage(text.json()));
                } else if (next instanceof OutboundClose close) {
                    if (socket != null && socket.isOpen()) {
                        socket.close(close.status());
                    }
                    terminal = true;
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            failTransport();
        } catch (Exception | LinkageError e) {
            failTransport();
        } finally {
            synchronized (enqueueLock) {
                terminal = true;
                outbound.clear();
                pendingChars = 0;
            }
        }
    }

    private void failTransport() {
        synchronized (enqueueLock) {
            closing = true;
            terminal = true;
            outbound.clear();
            pendingChars = 0;
        }
        abortSocket(CloseStatus.SESSION_NOT_RELIABLE);
    }

    private void abortSocket(CloseStatus status) {
        try {
            if (socket != null && socket.isOpen()) {
                socket.close(status);
            }
        } catch (Exception ignored) {
            // The peer may already have disappeared.
        }
    }

    private static boolean canWriteRole(String value) {
        return "owner".equals(value) || "admin".equals(value) || "editor".equals(value);
    }
}
