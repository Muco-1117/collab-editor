package com.bishe.server.ws;

import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.JwtUtil;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;

/**
 * WS 握手守卫：?token=xxx 校验 JWT，失败拒绝（403）；成功把登录主体放进 session attributes。
 */
@Component
public class TokenHandshakeInterceptor implements HandshakeInterceptor {

    public static final String ATTR_USER = "authUser";

    private final JwtUtil jwt;
    private final AuthService svc;

    public TokenHandshakeInterceptor(JwtUtil jwt, AuthService svc) {
        this.jwt = jwt;
        this.svc = svc;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Map<String, Object> attributes) {
        String q = request.getURI().getQuery();
        if (q == null || !q.contains("token=")) {
            response.setStatusCode(org.springframework.http.HttpStatus.FORBIDDEN);
            return false;
        }
        try {
            String token = null;
            for (String pair : q.split("&")) {
                if (pair.startsWith("token=")) token = pair.substring(6);
            }
            if (token == null || token.isBlank()) {
                response.setStatusCode(org.springframework.http.HttpStatus.FORBIDDEN);
                return false;
            }
            JwtUtil.JwtClaims claims = jwt.parse(token);
            AuthService.UserPub user = svc.byIdOrNull(claims.uid());
            if (user == null || !user.username().equals(claims.subject())) {
                response.setStatusCode(org.springframework.http.HttpStatus.FORBIDDEN);
                return false;
            }
            attributes.put(ATTR_USER, user);
            return true;
        } catch (Exception e) {
            response.setStatusCode(org.springframework.http.HttpStatus.FORBIDDEN);
            return false;
        }
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               WebSocketHandler wsHandler, Exception exception) {
    }
}
