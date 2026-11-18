'use strict';
/* Gate index.html: require a downloaded user bundle (phải đăng nhập). */
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readSession = () => LS.get('session', null);
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

  /** Tải MỘT file của gói: thử lại khi lỗi mạng/429, kiểm đúng kích thước, thêm ?v=<hash> để không lớp cache trung gian nào trả bản của phiên bản khác. */
  async function fetchBundleFile(base, token, f, version) {
    let lastErr = new Error(f.path);
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(`${base}/api/bundle/${enc(f.path)}?v=${encodeURIComponent(f.hash || version)}`, {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
        });
        if (res.status === 401) { const e = new Error('unauthorized'); e.auth = true; throw e; }
        if (res.status === 429) { lastErr = new Error(`429 ${f.path}`); await sleep(Math.min(8000, (Number(res.headers.get('Retry-After')) || 2) * 1000)); continue; }
        if (!res.ok) { lastErr = new Error(`${res.status} ${f.path}`); await sleep(400 * (i + 1)); continue; }
        const buf = await res.arrayBuffer();
        // HTML có thể bị lớp proxy (Cloudflare) chèn thêm mã khi truyền → chỉ coi là hỏng khi NHỎ hơn bản gốc; tệp khác phải đúng từng byte.
        if (typeof f.size === 'number' && (/\.html?$/i.test(f.path) ? buf.byteLength < f.size : buf.byteLength !== f.size)) { lastErr = new Error(`size ${f.path}`); await sleep(400 * (i + 1)); continue; }
        return { buf, type: res.headers.get('Content-Type') || 'application/octet-stream' };
      } catch (e) { if (e.auth) throw e; lastErr = e; await sleep(400 * (i + 1)); }
    }
    throw lastErr;
  }

  /**
   * Tải bundle mới vào cache riêng, kiểm đủ file rồi mới chuyển cache đang dùng: lỗi giữa chừng không làm hỏng bản cũ.
   * Trả 'ok' | 'auth' (token hết hạn → mới cần đăng nhập lại) | 'fail' (lỗi tạm: giữ bản cũ, thử lại sau).
   */
  async function silentUpdate(session, me) {
    try {
      const next = { ...session, version: me.version };
      if (session.online || !('caches' in window)) { // HTTP không có Cache API: file luôn lấy từ mạng
        localStorage.setItem('session', JSON.stringify(next));
        return 'ok';
      }
      const base = session.apiBase || location.origin;
      const files = me.files || [];
      const cacheName = `plc-${session.userId}-${me.version}`;
      await caches.delete(cacheName);
      const cache = await caches.open(cacheName);
      let idx = 0;   // tải song song vài tệp một lúc (68 tệp tuần tự qua đường hầm mất ~30 giây)
      const worker = async () => {
        while (idx < files.length) {
          const f = files[idx++];
          const { buf, type } = await fetchBundleFile(base, session.token, f, me.version);
          const stored = new Response(buf, { status: 200, headers: { 'Content-Type': type } });
          await cache.put(new URL(f.path, location.origin).href, stored.clone());
          if (f.path === 'index.html') {
            await cache.put(new URL('./', location.origin).href, stored.clone());
            await cache.put(new URL('/', location.origin).href, stored.clone());
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
      for (const f of files) {   // đủ file mới được kích hoạt
        if (!(await cache.match(new URL(f.path, location.origin).href))) throw new Error(`thiếu ${f.path}`);
      }
      const meta = await caches.open('plc-meta');
      await meta.put('/active', new Response(JSON.stringify({ cacheName, userId: session.userId, version: me.version }), {
        headers: { 'Content-Type': 'application/json' },
      }));
      localStorage.setItem('session', JSON.stringify({ ...next, cacheName }));
      for (const k of await caches.keys()) if (k.startsWith('plc-') && k !== cacheName && k !== 'plc-meta') await caches.delete(k);
      return 'ok';
    } catch (e) { try { console.warn('[update] tải gói mới lỗi, giữ bản cũ và thử lại:', e && e.message); } catch {} return e && e.auth ? 'auth' : 'fail'; }
  }

  async function run() {
    if (window.AppLock?.isLocked()) return;
    let session = LS.get('session', null);
    if (session?.demo) { try { localStorage.removeItem('session'); } catch {} session = null; }   // phiên "chạy thử" cũ (đã bỏ chế độ này): bắt đăng nhập

    if (!session?.userId && !session?.cacheName) {
      toLogin();
      return;
    }
    // Phiên tạm của bước 2 (đăng ký sinh trắc bắt buộc) chưa hoàn tất: không được vào trang chính bằng cách mở thẳng index.html.
    if (session.gate) {
      try { localStorage.removeItem('session'); } catch {}
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

    await checkVersion(session);
  }

  let updating = false, failCount = 0, retryTimer = null;

  /**
   * Hỏi server bản webapp mới nhất; khác bản đang chạy thì tải ngay (không bắt xoá cache, không bắt đăng nhập lại).
   * Chạy lúc mở app, mỗi khi quay lại foreground/mạng, và định kỳ 60 giây (PWA có thể mở nhiều ngày không tải lại trang).
   * Tải lỗi tạm thời → giữ bản đang chạy và tự thử lại (giãn dần); chỉ khi token hết hạn mới về trang đăng nhập.
   */
  async function checkVersion(session) {
    if (!navigator.onLine || !session?.token || updating) return;
    try {
      const base = session.apiBase || location.origin;
      const r = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${session.token}` },
        cache: 'no-store',
      });
      if (r.status === 401) {
        const j = await r.json().catch(() => ({}));
        if (j.error === 'session_revoked') {
          // Phone changed / account recovered elsewhere: this device must sign in again.
          try { localStorage.removeItem('session'); } catch {}
          toLogin('?revoked=1');
          return;
        }
        // Server trả lời được mà phiên hết hạn: đăng nhập lại (đăng nhập luôn tải bản mới nhất), không ở lại bản cũ.
        if (j.error === 'unauthorized') { window.AppLock?.allowNavigation?.(); toLogin('?update=1'); }
        return;
      }
      if (!r.ok) {   // 429 / 5xx tạm thời: đừng bỏ qua im lặng, hỏi lại sau (giãn dần)
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { const s = readSession(); if (s  && !s.gate) checkVersion(s); }, Math.min(60_000, 3000 * 2 ** failCount++));
        return;
      }
      const me = await r.json();
      if (me.version === session.version) { failCount = 0; return; }
      updating = true;
      const res = await silentUpdate(session, me);
      updating = false;
      if (res === 'ok') { failCount = 0; window.AppLock?.allowNavigation?.(); location.reload(); }
      else if (res === 'auth') { window.AppLock?.allowNavigation?.(); toLogin('?update=1'); }
      else {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { const s = readSession(); if (s  && !s.gate) checkVersion(s); }, Math.min(60_000, 3000 * 2 ** failCount++));
      }
    } catch {
      updating = false;
      // offline / network error — continue with cached app
    }
  }

  function recheck() {
    if (window.AppLock?.isLocked?.()) return;
    const session = readSession();
    if (session  && !session.gate) checkVersion(session);
  }
  let lastCheck = Date.now();
  const throttled = () => { if (Date.now() - lastCheck < 10_000) return; lastCheck = Date.now(); recheck(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') throttled(); });
  window.addEventListener('focus', throttled);
  window.addEventListener('online', throttled);
  window.addEventListener('pageshow', throttled);
  setInterval(() => { if (document.visibilityState === 'visible') throttled(); }, 60_000);

  run();
})();
