package com.bishe.server.ws;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * 实时层端点：ws://host:8080/ws/collab
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final CollabSocketHandler handler;
    private final TokenHandshakeInterceptor tokenGuard;

    public WebSocketConfig(CollabSocketHandler handler, TokenHandshakeInterceptor tokenGuard) {
        this.handler = handler;
        this.tokenGuard = tokenGuard;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/collab")
                .addInterceptors(tokenGuard)
                .setAllowedOriginPatterns("*");
    }
}