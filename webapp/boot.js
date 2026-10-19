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

  async function run() {
    const session = LS.get('session', null);
    if (session?.demo) return; // local trial without server bundle

    if (!session?.userId && !session?.cacheName) {
      toLogin();
      return;
    }

    const name = await activeCacheName(session);
    if (!name || !('caches' in window) || !(await caches.has(name))) {
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
            toLogin('?update=1');
          }
        }
      } catch {
        // offline / network error — continue with cached app
      }
    }
  }

  run();
})();
