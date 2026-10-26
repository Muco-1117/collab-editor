package com.bishe.server.auth;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;

/** 当前 HTTP 请求中经 JWT 校验的用户。 */
@Component
public class CurrentUser {

    private final HttpServletRequest request;

    public CurrentUser(HttpServletRequest request) {
        this.request = request;
    }

    public AuthService.UserPub get() {
        Object value = request.getAttribute(JwtAuthFilter.ATTR_USER);
        return value instanceof AuthService.UserPub user ? user : null;
    }
}
