package com.bishe.server.ws;

import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.TextMessage;

/**
 * 一个客户端连接的会话包装：持有底层 WS 会话与其 clientId。
 *
 * <p>线程安全：对底层 session 的发送必须串行（Tomcat 状态机非线程安全，
 * 并发 send 会触发 TEXT_PARTIAL_WRITING 并强关连接——多人同时 join/广播时
 * 曾实测崩溃）。所有发送统一走 lock 内部。
 */
public final class CollabSession {

    private final String clientId;
    private final String hostname;
    private final WebSocketSession socket;
    private final Object sendLock = new Object();

    public CollabSession(String clientId, String hostname, WebSocketSession socket) {
        this.clientId = clientId;
        this.hostname = hostname;
        this.socket = socket;
    }

    public String clientId() {
        return clientId;
    }

    public String hostname() {
        return hostname;
    }

    public boolean isOpen() {
        return socket.isOpen();
    }

    /** 幂等发送：连接已关闭时静默忽略；同一连接串行发送。 */
    public void send(String json) {
        synchronized (sendLock) {
            if (!socket.isOpen()) {
                return;
            }
            try {
                socket.sendMessage(new TextMessage(json));
            } catch (Exception ignored) {
                // 对端已不可达/状态机竞态：发送失败不致命（重连增量兜底）
            }
        }
    }
}