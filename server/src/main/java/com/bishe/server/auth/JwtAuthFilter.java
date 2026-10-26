package com.bishe.server.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Set;

/**
 * 自研 JWT 请求过滤器。静态资源公开，除注册、登录和健康检查外的 REST API 均需登录。
 */
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    public static final String ATTR_USER = JwtAuthFilter.class.getName() + ".user";
    private static final Set<String> PUBLIC_API = Set.of(
            "/api/auth/register", "/api/auth/login", "/api/health", "/actuator/health");

    private final JwtUtil jwt;
    private final AuthService svc;

    public JwtAuthFilter(JwtUtil jwt, AuthService svc) {
        this.jwt = jwt;
        this.svc = svc;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "same-origin");
        AuthService.UserPub user = authenticate(req.getHeader("Authorization"));
        if (user != null) {
            req.setAttribute(ATTR_USER, user);
        }
        String path = req.getRequestURI();
        if (path.startsWith("/api/")) {
            res.setHeader("Cache-Control", "no-store");
        }
        if (path.startsWith("/api/") && !PUBLIC_API.contains(path) && user == null) {
            res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            res.setCharacterEncoding(StandardCharsets.UTF_8.name());
            res.setContentType(MediaType.APPLICATION_JSON_VALUE);
            res.getWriter().write("{\"msg\":\"未登录或登录已过期\"}");
            return;
        }
        chain.doFilter(req, res);
    }

    private AuthService.UserPub authenticate(String header) {
        if (header == null || !header.startsWith("Bearer ")) {
            return null;
        }
        try {
            JwtUtil.JwtClaims claims = jwt.parse(header.substring(7).trim());
            AuthService.UserPub user = svc.byIdOrNull(claims.uid());
            return user != null && user.username().equals(claims.subject()) ? user : null;
        } catch (Exception ignored) {
            return null;
        }
    }
}
