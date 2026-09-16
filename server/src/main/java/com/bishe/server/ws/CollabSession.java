package com.bishe.server.ws;

import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.TextMessage;

import java.io.IOException;

/**
 * 一个客户端连接的会话包装：持有底层 WS 会话与其 clientId。
 */
public final class CollabSession {

    private final String clientId;
    private final String hostname;
    private final WebSocketSession socket;

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

    /** 幂等发送：连接已关闭时静默忽略。 */
    public void send(String json) {
        if (socket.isOpen()) {
            try {
                socket.sendMessage(new TextMessage(json));
            } catch (IOException ignored) {
                // 对端已不可达，发送失败不致命（重连增量兜底）
            }
        }
    }
}