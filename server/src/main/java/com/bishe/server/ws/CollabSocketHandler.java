package com.bishe.server.ws;

import com.bishe.engine.ElementType;
import com.bishe.engine.Op;
import com.bishe.server.auth.AuthService;
import com.bishe.server.store.DocRepo;
import com.bishe.server.store.OpStore;
import com.bishe.server.store.SpaceRepo;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.Map;
import java.util.Objects;

/** Authenticated WebSocket endpoint for document collaboration protocol v1. */
@Component
public class CollabSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(CollabSocketHandler.class);
    private static final int MAX_FRAME_BYTES = 64 * 1024;
    private static final String ATTR_ROOM = "room";
    private static final String ATTR_SESSION = "session";
    private static final String ATTR_JOINING = "joining";
    private static final String ATTR_JOINED = "joined";

    private final ObjectMapper mapper = new ObjectMapper();
    private final OpStore store;
    private final DocRepo docs;
    private final SpaceRepo spaces;
    private final RoomRegistry registry;
    @org.springframework.beans.factory.annotation.Autowired
    private com.bishe.server.store.ImageAssetRepo images;

    public CollabSocketHandler(OpStore store, DocRepo docs, SpaceRepo spaces, RoomRegistry registry) {
        this.store = store;
        this.docs = docs;
        this.spaces = spaces;
        this.registry = registry;
    }

    @Override
    protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
        if (message.getPayloadLength() > MAX_FRAME_BYTES) {
            failAndClose(socket, "FRAME_TOO_LARGE", "消息帧超过 64 KiB", CloseStatus.TOO_BIG_TO_PROCESS);
            return;
        }

        final ObjectNode frame;
        try {
            JsonNode parsed = mapper.readTree(message.getPayload());
            if (!(parsed instanceof ObjectNode object)) {
                failAndClose(socket, "MALFORMED_FRAME", "消息帧必须是 JSON 对象", CloseStatus.BAD_DATA);
                return;
            }
            frame = object;
        } catch (Exception e) {
            failAndClose(socket, "MALFORMED_FRAME", "消息帧不是有效 JSON", CloseStatus.BAD_DATA);
            return;
        }

        JsonNode typeNode = frame.get("type");
        if (typeNode == null || !typeNode.isTextual() || typeNode.textValue().isBlank()) {
            sendError(socket, "MISSING_TYPE", "缺少消息类型", false);
            return;
        }

        try {
            switch (typeNode.textValue()) {
                case "hello" -> handleHello(socket, frame);
                case "op" -> handleOperation(socket, frame);
                case "ping" -> handlePing(socket, frame);
                case "pong" -> markHeartbeat(socket);
                default -> sendError(socket, "UNKNOWN_TYPE", "未知帧类型: " + typeNode.textValue(), false);
            }
        } catch (CollabRoom.JoinRejected e) {
            failAndClose(socket, e.code(), e.getMessage(), CloseStatus.POLICY_VIOLATION);
        } catch (CollabMessage.ProtocolException e) {
            boolean fatal = "INVALID_HELLO".equals(e.code());
            if (fatal) {
                failAndClose(socket, e.code(), e.getMessage(), CloseStatus.BAD_DATA);
            } else {
                sendError(socket, e.code(), e.getMessage(), false);
            }
        } catch (RuntimeException e) {
            log.error("处理 WebSocket 帧失败 session={} type={}", socket.getId(), typeNode.textValue(), e);
            if ("hello".equals(typeNode.textValue())) {
                failAndClose(socket, "SERVER_ERROR", "服务暂时不可用", CloseStatus.SERVER_ERROR);
            } else {
                sendError(socket, "SERVER_ERROR", "服务暂时不可用", false);
            }
        }
    }

    private void handleHello(WebSocketSession socket, ObjectNode frame) {
        CollabMessage.JoinRequest request = CollabMessage.parseJoin(frame);
        Map<String, Object> attributes = socket.getAttributes();
        synchronized (attributes) {
            if (attributes.containsKey(ATTR_JOINING) || attributes.containsKey(ATTR_JOINED)) {
                failAndClose(socket, "ALREADY_JOINED", "重复握手，请重连", CloseStatus.POLICY_VIOLATION);
                return;
            }
            attributes.put(ATTR_JOINING, Boolean.TRUE);
        }

        AuthService.UserPub user = authenticatedUser(socket);
        if (user == null) {
            failAndClose(socket, "AUTH_REQUIRED", "登录状态无效", CloseStatus.POLICY_VIOLATION);
            return;
        }

        /* Load metadata once; it also carries the space id used for access. */
        Map<String, Object> metadata = docs.get(request.docId());
        long spaceId = metadata != null && metadata.get("space_id") instanceof Number n
                ? n.longValue() : docs.spaceIdOf(request.docId());
        if (spaceId < 0) {
            failAndClose(socket, "DOCUMENT_NOT_FOUND", "文档不存在", CloseStatus.POLICY_VIOLATION);
            return;
        }
        String role = spaces.roleOf(spaceId, user.id());
        if (role == null) {
            failAndClose(socket, "DOC_ACCESS_DENIED", "无权访问该文档空间", CloseStatus.POLICY_VIOLATION);
            return;
        }

        /*
         * document.title/kind is the metadata authority. Keep the old
         * roomFor(docId, store) path for lightweight protocol tests/adapters
         * that only stub spaceIdOf; a real persisted document always supplies
         * metadata here.
         */
        CollabRoom room;
        if (metadata == null) {
            room = registry.roomFor(request.docId(), store);
        } else {
            String kind = metadataText(metadata, "kind", "doc");
            String title = metadataText(metadata, "title", "");
            room = registry.roomFor(request.docId(), kind, title, store);
            // Mockito-based protocol adapters may only stub the legacy
            // overload; a real RoomRegistry never returns null here.
            if (room == null) {
                room = registry.roomFor(request.docId(), store);
            }
        }
        String displayName = user.nickname() == null || user.nickname().isBlank()
                ? user.username() : user.nickname();
        CollabSession session = new CollabSession(request.clientId(), request.hostname(), socket,
                user.id(), displayName, role);
        attributes.put(ATTR_ROOM, room);
        attributes.put(ATTR_SESSION, session);

        try {
            room.joinAndSync(session, request.lastRev(), () -> spaces.roleOf(spaceId, user.id()));
        } catch (CollabRoom.JoinRejected e) {
            room.leave(session);
            failAndClose(socket, e.code(), e.getMessage(), CloseStatus.POLICY_VIOLATION);
            return;
        } catch (RuntimeException e) {
            room.leave(session);
            throw e;
        }

        synchronized (attributes) {
            attributes.remove(ATTR_JOINING);
            attributes.put(ATTR_JOINED, Boolean.TRUE);
        }
        log.info("join doc={} client={} user={} #occupants={}", request.docId(), request.clientId(),
                user.id(), room.occupantCount());
    }

    private void handleOperation(WebSocketSession socket, ObjectNode frame) {
        CollabRoom room = (CollabRoom) socket.getAttributes().get(ATTR_ROOM);
        CollabSession session = (CollabSession) socket.getAttributes().get(ATTR_SESSION);
        if (room == null || session == null || !Boolean.TRUE.equals(socket.getAttributes().get(ATTR_JOINED))) {
            sendError(socket, "NOT_JOINED", "请先发送 hello 加入文档", false);
            return;
        }

        AuthService.UserPub user = authenticatedUser(socket);
        long spaceId = docs.spaceIdOf(room.docId());
        if (user == null || spaceId < 0) {
            revokeAndClose(socket, room, session, "MEMBERSHIP_REVOKED", "文档不存在或成员身份已失效");
            return;
        }
        String currentRole = spaces.roleOf(spaceId, user.id());
        if (currentRole == null) {
            revokeAndClose(socket, room, session, "MEMBERSHIP_REVOKED", "你已不再是该空间成员");
            return;
        }
        if (!canWrite(currentRole)) {
            sendError(socket, "READ_ONLY", "只读成员（viewer）不可编辑", false);
            return;
        }

        CollabMessage.ParsedOp parsed = CollabMessage.parseOperation(frame, session.clientId());
        validateImageReferences(room, parsed.op());
        if (parsed.op().type() == Op.Type.STATE && parsed.op().elementType() == ElementType.DOC) {
            sendError(socket, "INVALID_OP", "文档标题请使用 REST 接口修改", false);
            return;
        }
        if (isDocumentTitle(parsed.op())) {
            sendError(socket, "INVALID_OP", "内容标题请使用 REST 接口修改", false);
            return;
        }
        try {
            CollabRoom.ApplyResult result = room.applyClientOp(parsed.op(), parsed.opId(), session);
            if (result.status() == CollabRoom.ApplyStatus.DUPLICATE) {
                session.send(CollabMessage.applied(result.rev(), result.op(), result.opId(),
                        true, false));
            } else if (result.status() == CollabRoom.ApplyStatus.IGNORED) {
                sendError(socket, "STALE_OP", "操作时钟早于当前状态，服务端未应用该操作", false);
            }
        } catch (CollabRoom.OperationRejected e) {
            sendError(socket, e.code(), e.getMessage(), false);
        } catch (RuntimeException e) {
            log.error("op 持久化失败 doc={} client={}", room.docId(), session.clientId(), e);
            sendError(socket, "PERSIST_FAILED", "操作未保存，请稍后重试", false);
        }
    }

    private void handlePing(WebSocketSession socket, ObjectNode frame) {
        CollabSession session = (CollabSession) socket.getAttributes().get(ATTR_SESSION);
        if (session != null) {
            session.markHeartbeat();
            session.send(CollabMessage.pong(frame));
        } else {
            sendRaw(socket, CollabMessage.pong(frame));
        }
    }

    private void validateImageReferences(CollabRoom room, Op op) {
        if (op.type() != Op.Type.STATE) return;
        @SuppressWarnings("unchecked") Map<String, Object> fields = (Map<String, Object>) op.value();
        if (Boolean.TRUE.equals(fields.get("#tombstone"))) return;
        String idKey = op.elementType() == ElementType.IMAGE ? "assetId" : "coverId";
        Object rawId = fields.get(idKey);
        if (rawId == null || String.valueOf(rawId).isBlank()) {
            if (op.elementType() == ElementType.IMAGE) throw new CollabMessage.ProtocolException("INVALID_IMAGE", "图片元素缺少资源 ID");
            return;
        }
        String id = String.valueOf(rawId);
        var asset = images == null ? null : images.find(id);
        if (asset == null || !room.docId().equals(asset.docId())) {
            throw new CollabMessage.ProtocolException("INVALID_IMAGE", "图片资源不属于当前内容");
        }
        String urlKey = op.elementType() == ElementType.IMAGE ? "url" : "coverUrl";
        if (fields.containsKey(urlKey) && !Objects.equals(fields.get(urlKey), "/api/assets/" + id)) {
            throw new CollabMessage.ProtocolException("INVALID_IMAGE", "图片引用地址无效");
        }
    }

    private void markHeartbeat(WebSocketSession socket) {
        CollabSession session = (CollabSession) socket.getAttributes().get(ATTR_SESSION);
        if (session != null) {
            session.markHeartbeat();
        }
    }

    private void revokeAndClose(WebSocketSession socket, CollabRoom room, CollabSession session,
                                String code, String message) {
        sendError(socket, code, message, true);
        room.leave(session);
        session.close(CloseStatus.POLICY_VIOLATION);
    }

    private AuthService.UserPub authenticatedUser(WebSocketSession socket) {
        Object value = socket.getAttributes().get(TokenHandshakeInterceptor.ATTR_USER);
        return value instanceof AuthService.UserPub user ? user : null;
    }

    private static boolean canWrite(String role) {
        return "owner".equals(role) || "admin".equals(role) || "editor".equals(role);
    }

    private static boolean isDocumentTitle(Op op) {
        return op.type() == Op.Type.PUT
                && CollabRoom.ROOT_ID.equals(op.elementId())
                && op.elementType() == ElementType.DOC
                && "title".equals(op.field());
    }

    private static String metadataText(Map<String, Object> metadata, String key, String fallback) {
        Object value = metadata.get(key);
        return value == null ? fallback : String.valueOf(value);
    }

    private void sendError(WebSocketSession socket, String code, String message, boolean fatal) {
        CollabSession session = (CollabSession) socket.getAttributes().get(ATTR_SESSION);
        String json = CollabMessage.error(code, message, fatal);
        if (session != null) {
            session.send(json);
        } else {
            sendRaw(socket, json);
        }
    }

    private void failAndClose(WebSocketSession socket, String code, String message, CloseStatus status) {
        sendError(socket, code, message, true);
        CollabSession session = (CollabSession) socket.getAttributes().get(ATTR_SESSION);
        if (session != null) {
            session.close(status);
        } else {
            try {
                if (socket.isOpen()) {
                    socket.close(status);
                }
            } catch (Exception ignored) {
                // The peer may already have disconnected.
            }
        }
    }

    private void sendRaw(WebSocketSession socket, String json) {
        synchronized (socket) {
            try {
                if (socket.isOpen()) {
                    socket.sendMessage(new TextMessage(json));
                }
            } catch (Exception ignored) {
                // Initial protocol errors are best-effort because there is no CollabSession yet.
            }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
        CollabSession session = (CollabSession) socket.getAttributes().get(ATTR_SESSION);
        CollabRoom room = (CollabRoom) socket.getAttributes().get(ATTR_ROOM);
        if (session != null && room != null) {
            room.leave(session);
            if (room.occupantCount() == 0) {
                registry.scheduleEviction(room.docId());
            }
            log.info("leave client={} doc={} status={}", session.clientId(), room.docId(), status);
        }
    }
}
