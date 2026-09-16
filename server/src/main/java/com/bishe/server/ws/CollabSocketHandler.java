package com.bishe.server.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.concurrent.ConcurrentHashMap;

/**
 * WebSocket 实时层入口：/ws/collab?doc=&clientId=
 *
 * <p>握手协议（参考全案 4.2 协议 v1 的精简化）：
 * 连接建立后客户端先发 hello → 服务端回 welcome（快照+rev）并按需补发增量；
 * 此后每帧 op → 服务端应用并广播 applied。
 */
@Component
public class CollabSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(CollabSocketHandler.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final ConcurrentHashMap<String, CollabRoom> rooms = new ConcurrentHashMap<>();

    /** 任意连接：按 room 挂载。doc 未开房则自动创建。 */
    @Override
    protected void handleTextMessage(WebSocketSession ws, TextMessage message) throws Exception {
        ObjectNode n = (ObjectNode) mapper.readTree(message.getPayload());
        String type = n.path("type").asText();
        CollabRoom room = (CollabRoom) ws.getAttributes().get("room");

        switch (type) {
            case "hello" -> {
                CollabMessage.JoinRequest req = CollabMessage.parseJoin(n);
                synchronized (ws.getAttributes()) {
                    if (ws.getAttributes().containsKey("joined")) {
                        ws.sendMessage(new TextMessage(CollabMessage.error("重复握手，请重连")));
                        return;
                    }
                    ws.getAttributes().put("joined", Boolean.TRUE);
                }
                String clientId = req.clientId().isBlank() ? ws.getId() : req.clientId();
                room = rooms.computeIfAbsent(req.docId(), CollabRoom::new);
                ws.getAttributes().put("room", room);

                CollabSession ses = new CollabSession(clientId, req.hostname(), ws);
                ws.getAttributes().put("session", ses);
                long rev0 = room.currentRev();
                long lastRev = req.lastRev();
                if (lastRev > 0) {
                    // 断线续传：只补 (lastRev, rev0] 增量（不发全量快照，避免重复应用）
                    ws.sendMessage(new TextMessage(
                            CollabMessage.incremental(lastRev, room.opsAfter(lastRev))));
                } else {
                    // 全新进入：全量快照 + 当前 rev
                    ws.sendMessage(new TextMessage(CollabMessage.welcome(clientId, room)));
                }
                room.join(ses);
                log.info("join doc={} client={} #occupants={}", req.docId(), clientId, room.occupantCount());
            }
            case "op" -> {
                if (room == null) {
                    ws.sendMessage(new TextMessage(CollabMessage.error("未加入任何房间")));
                    return;
                }
                try {
                    room.applyOp(CollabMessage.parseOp(n));
                } catch (Exception e) {
                    log.warn("bad op frame: {}", message.getPayload());
                    ws.sendMessage(new TextMessage(CollabMessage.error("op 解析失败: " + e.getMessage())));
                }
            }
            default -> ws.sendMessage(new TextMessage(CollabMessage.error("未知帧类型: " + type)));
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession ws, CloseStatus status) {
        CollabSession ses = (CollabSession) ws.getAttributes().get("session");
        CollabRoom room = (CollabRoom) ws.getAttributes().get("room");
        if (ses != null && room != null) {
            room.leave(ses.clientId());
            log.info("leave client={} doc={}", ses.clientId(), room.docId());
        }
    }

    public int occupantCount00() {
        return rooms.values().stream().mapToInt(CollabRoom::occupantCount).sum();
    }
}