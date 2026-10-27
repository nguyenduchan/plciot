'use strict';
/* Gate index.html: require a downloaded user bundle (or local demo session). */
(function () {
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  };

  function toLogin(qs) {
    location.replace('login.html' + (qs || ''));
  }

  async function activeCacheName(session) {
    if (session?.cacheName) return session.cacheName;
    if (!('caches' in window)) return null;
    try {
      const meta = await caches.open('plc-meta');
      const res = await meta.match('/active');
      if (!res) return null;
      const j = await res.json();
      return j.cacheName || null;
    } catch { return null; }
  }

  /** Tải bundle mới vào cache riêng rồi mới chuyển cache đang dùng, để mất mạng giữa chừng không làm hỏng bản cũ. */
  async function silentUpdate(session, me) {
    try {
      const next = { ...session, version: me.version };
      if (session.online || !('caches' in window)) { // HTTP không có Cache API: file luôn lấy từ mạng
        localStorage.setItem('session', JSON.stringify(next));
        return true;
      }
      const base = session.apiBase || location.origin;
      const cacheName = `plc-${session.userId}-${me.version}`;
      await caches.delete(cacheName);
      const cache = await caches.open(cacheName);
      for (const f of me.files || []) {
        const res = await fetch(`${base}/api/bundle/${f.path.split('/').map(encodeURIComponent).join('/')}`, {
          headers: { Authorization: `Bearer ${session.token}` },
        });
        if (!res.ok) throw new Error(f.path);
        const stored = new Response(await res.arrayBuffer(), { status: 200, headers: res.headers });
        await cache.put(new URL(f.path, location.origin).href, stored.clone());
        if (f.path === 'index.html') {
          await cache.put(new URL('./', location.origin).href, stored.clone());
          await cache.put(new URL('/', location.origin).href, stored.clone());
        }
      }
      const meta = await caches.open('plc-meta');
      await meta.put('/active', new Response(JSON.stringify({ cacheName, userId: session.userId, version: me.version }), {
        headers: { 'Content-Type': 'application/json' },
      }));
      localStorage.setItem('session', JSON.stringify({ ...next, cacheName }));
      for (const k of await caches.keys()) if (k.startsWith('plc-') && k !== cacheName && k !== 'plc-meta') await caches.delete(k);
      return true;
    } catch { return false; }
  }

  async function run() {
    const session = LS.get('session', null);
    if (session?.demo) return; // local trial without server bundle

    if (!session?.userId && !session?.cacheName) {
      toLogin();
      return;
    }

    // HTTP (không có Cache API): phiên chỉ dựa vào token, không cần gói offline.
    if (!session.online) {
      const name = await activeCacheName(session);
      if (!name || !('caches' in window) || !(await caches.has(name))) {
        toLogin();
        return;
      }
    } else if (!session.token) {
      toLogin();
      return;
    }

    if (navigator.onLine && session.token) {
      try {
        const base = session.apiBase || location.origin;
        const r = await fetch(`${base}/api/me`, {
          headers: { Authorization: `Bearer ${session.token}` },
        });
        if (r.status === 401) {
          const j = await r.json().catch(() => ({}));
          if (j.error === 'session_revoked') {
            // Phone changed / account recovered elsewhere: this device must sign in again.
            try { localStorage.removeItem('session'); } catch {}
            toLogin('?revoked=1');
            return;
          }
          // Token expired: still allow offline app, but flag for re-login on next update
          return;
        }
        if (r.ok) {
          const me = await r.json();
          if (me.version !== session.version) {
            // PC có mã nguồn mới: tự tải bằng phiên hiện tại (không bắt đăng nhập lại); lỗi mới quay về đăng nhập.
            if (await silentUpdate(session, me)) location.reload();
            else toLogin('?update=1');
          }
        }
      } catch {
        // offline / network error — continue with cached app
      }
    }
  }

  run();
})();
