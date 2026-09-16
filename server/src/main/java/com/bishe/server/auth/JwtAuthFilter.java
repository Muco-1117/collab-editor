package com.bishe.server.auth;

import io.jsonwebtoken.Claims;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 从 Authorization: Bearer <token> 还原登录主体。无效/过期 → 当作匿名放行，
 * 由 SecurityConfig 的路径规则决定是否 401（/api/** 必登）。
 */
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    private final JwtUtil jwt;
    private final AuthService svc;

    public JwtAuthFilter(JwtUtil jwt, AuthService svc) {
        this.jwt = jwt;
        this.svc = svc;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String h = req.getHeader("Authorization");
        if (h != null && h.startsWith("Bearer ")) {
            try {
                Claims c = jwt.parse(h.substring(7));
                long uid = jwt.uidOr(c);
                String role = c.get("role", String.class);
                AuthService.UserPub user = svc.byId(uid);
                if (user != null) {
                    var token = new UsernamePasswordAuthenticationToken(
                            user, null, List.of(new SimpleGrantedAuthority("ROLE_" + role)));
                    SecurityContextHolder.getContext().setAuthentication(token);
                }
            } catch (Exception ignore) {
                // 无效 token：不注入身份，落到 401/403
            }
        }
        chain.doFilter(req, res);
    }
}