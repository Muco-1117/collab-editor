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
    /** 空间成员角色：admin/editor 可写；viewer 只读（WS op 帧由 handler 校验）。 */
    private final String role;
    private final WebSocketSession socket;
    private final Object sendLock = new Object();

    public CollabSession(String clientId, String hostname, WebSocketSession socket) {
        this(clientId, hostname, socket, "editor");
    }

    public CollabSession(String clientId, String hostname, WebSocketSession socket, String role) {
        this.clientId = clientId;
        this.hostname = hostname;
        this.role = role == null ? "editor" : role;
        this.socket = socket;
    }

    public String clientId() {
        return clientId;
    }

    public String hostname() {
        return hostname;
    }

    public String role() {
        return role;
    }

    /** 是否允许写入（viewer 仅读）。 */
    public boolean canWrite() {
        return !"viewer".equals(role);
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

    /** 连接被同 clientId 的新会话顶替时调用：尽力关闭底层连接。 */
    public void forceClose() {
        try {
            if (socket.isOpen()) {
                socket.close(org.springframework.web.socket.CloseStatus.POLICY_VIOLATION);
            }
        } catch (Exception ignored) {
        }
    }
}