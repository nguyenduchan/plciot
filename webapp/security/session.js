/* GENERATED từ packages/security/client/session.js bằng "npm run sync-client". KHÔNG sửa ở đây. */
'use strict';
/*
 * Token đăng nhập ngắn hạn (72 giờ) nhưng gia hạn trượt: khi đang dùng, server gửi token mới trong header
 * X-Renewed-Token và file này cập nhật localStorage. Nạp TRƯỚC mọi script khác.
 */
(function () {
  const orig = window.fetch;
  const readSession = () => { try { return JSON.parse(localStorage.getItem('session')); } catch { return null; } };
  const isApp = location.pathname.endsWith('/index.html') || location.pathname === '/';
  let locked = false;
  let navigating = false;
  let lastActivity = Date.now();
  let hiddenAt = 0;
  let lastPing = 0;
  let hiddenTimer = null;

  function post(path, session, token) {
    return orig.call(window, location.origin + path, {
      method: 'POST', keepalive: true,
      headers: {
        Authorization: `Bearer ${session?.token || ''}`,
        'X-Control-Token': token || '',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  }

  function lock(notify = true) {
    const session = readSession();
    if (locked || !isApp || session?.demo) return;
    locked = true;
    document.documentElement.style.visibility = 'hidden';
    let token = '';
    try { token = JSON.parse(localStorage.getItem('ctl'))?.token || ''; } catch {}
    try {
      if (session) localStorage.setItem('session', JSON.stringify({ ...session, locked: true }));
      localStorage.removeItem('ctl');
      const cfg = JSON.parse(localStorage.getItem('cfg'));
      if (cfg) { delete cfg.user; delete cfg.pass; localStorage.setItem('cfg', JSON.stringify(cfg)); }
    } catch {}
    document.dispatchEvent(new Event('app-locked'));
    if (notify && session?.token) post('/api/login/lock', session, token).catch(() => {});
    location.replace('login.html?locked=1');
  }

  window.AppLock = {
    isLocked: () => locked,
    lock,
    allowNavigation() {
      navigating = true;
      try { sessionStorage.setItem('app-entry', readSession()?.token || ''); } catch {}
    },
  };

  window.fetch = async function renewingFetch(...args) {
    const before = readSession();
    const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
    const api = url.origin === location.origin && url.pathname.startsWith('/api/');
    if (locked && api) return new Response(JSON.stringify({ error: 'app_locked' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const res = await orig.apply(this, args);
    try {
      const t = res.headers.get('X-Renewed-Token');
      if (t) {
        const s = readSession();
        if (s && !s.demo && s.token === before?.token) { s.token = t; localStorage.setItem('session', JSON.stringify(s)); }
      }
      if (isApp && api && res.status === 401) {
        const body = await res.clone().json().catch(() => ({}));
        if (['app_locked', 'unauthorized', 'session_revoked', 'login_step_up_required'].includes(body.error)) lock(false);
      }
    } catch {}
    return res;
  };

  if (!isApp || readSession()?.demo) return;
  let entry = null;
  try { entry = sessionStorage.getItem('app-entry'); sessionStorage.removeItem('app-entry'); } catch {}
  if (!entry || entry !== readSession()?.token) { lock(); return; }

  function activity() {
    if (locked || document.hidden) return;
    lastActivity = Date.now();
    if (lastActivity - lastPing < 30_000) return;
    lastPing = lastActivity;
    post('/api/login/activity', readSession()).then((res) => { if (res.status === 401) lock(false); }).catch(() => {});
  }
  for (const event of ['pointerdown', 'keydown', 'touchstart', 'scroll']) document.addEventListener(event, activity, { passive: true });
  setInterval(() => { if (Date.now() - lastActivity >= 300_000) lock(); }, 5000);
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hiddenTimer);
    if (document.hidden) {
      hiddenAt = Date.now();
      post('/api/login/background', readSession()).catch(() => {});
      hiddenTimer = setTimeout(() => lock(), 60_000);
    } else {
      if (hiddenAt && Date.now() - hiddenAt >= 60_000) return lock();
      hiddenAt = 0;
      post('/api/login/activity', readSession()).then((res) => { if (res.status === 401) lock(false); }).catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => { if (!navigating) lock(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) lock(); });
  window.addEventListener('storage', (event) => {
    if (event.key === 'session' && (!readSession() || readSession().locked)) lock(false);
  });
}());
