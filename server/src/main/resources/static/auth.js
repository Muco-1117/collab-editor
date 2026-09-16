/* 认证公共库：token 存取 / 登录态 / WS 地址 */
(function (w) {
  const KEY = 'collab_token';
  const UKEY = 'collab_user';

  w.auth = {
    token: () => localStorage.getItem(KEY) || '',
    user: () => { try { return JSON.parse(localStorage.getItem(UKEY) || 'null'); } catch { return null; } },
    save: (token, user) => { localStorage.setItem(KEY, token); if (user) localStorage.setItem(UKEY, JSON.stringify(user)); },
    clear: () => { localStorage.removeItem(KEY); localStorage.removeItem(UKEY); },

    /** 从服务端刷新当前用户（token 失效返回 null）。 */
    me: async () => {
      const tk = w.auth.token();
      if (!tk) return null;
      try {
        const r = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + tk } });
        if (!r.ok) { w.auth.clear(); return null; }
        const body = await r.json();
        const u = body.user;
        w.auth.save(tk, u);
        return u;
      } catch { return null; }
    },

    /** 登录守卫：无 token → 跳登录页。 */
    guard: () => {
      if (!w.auth.token()) { location.href = '/login.html'; return false; }
      return true;
    },

    /** 带 token 的 WS 地址（浏览器 WebSocket 无法自定义 header，用 query 传）。 */
    wsUrl: (path) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${location.host}${path}?token=${encodeURIComponent(w.auth.token())}`;
    },
  };
})(window);