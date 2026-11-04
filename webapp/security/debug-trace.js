/* GENERATED từ packages/security/client/debug-trace.js bằng "npm run sync-client". KHÔNG sửa ở đây. */
'use strict';
/*
 * Debug overlay Passkey/Face ID — chỉ hoạt động khi server cho phép tên đăng nhập của bạn (DEBUG_TRACE_USERS).
 * Bật ý định: ?debug=1  |  Tắt: ?debug=0
 * Tên đăng nhập: lấy từ ô đăng nhập/đăng ký / session / ?user= / localStorage.plcDebugUser
 */
(function () {
  const KEY = 'plcDebug';
  const PHONE_KEY = 'plcDebugUser';
  const q = new URLSearchParams(location.search);
  if (q.get('debug') === '1') try { localStorage.setItem(KEY, '1'); } catch {}
  if (q.get('debug') === '0') {
    try { localStorage.removeItem(KEY); } catch {}
  }
  if (q.get('user')) {
    try { localStorage.setItem(PHONE_KEY, String(q.get('user')).trim().toLowerCase()); } catch {}
  }

  function wantDebug() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  }

  function readPhone() {
    try {
      const stored = localStorage.getItem(PHONE_KEY);
      if (stored) return stored.trim().toLowerCase();
    } catch {}
    try {
      const s = JSON.parse(localStorage.getItem('session') || 'null');
      if (s?.username) return String(s.username).trim().toLowerCase();
    } catch {}
    for (const sel of ['#reg-username', '#username']) {
      const el = document.querySelector(sel);
      if (el?.value) return el.value.trim().toLowerCase();
    }
    return '';
  }

  function savePhone(p) {
    const n = String(p || '').trim().toLowerCase();
    if (!n) return;
    try { localStorage.setItem(PHONE_KEY, n); } catch {}
  }

  window.PlcDebug = {
    enabled: () => false,
    log() {},
    flush() {},
    setPhone(p) { savePhone(p); },
  };

  if (!wantDebug()) return;

  const queue = [];
  let panel; let list; let statusEl;
  let lastId = 0;
  let flushTimer = null;
  let allowed = false;
  const held = []; // sự kiện phát sinh trước khi server xác nhận tên được phép: giữ lại rồi gửi sau
  let checking = false;

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'plc-debug';
    panel.innerHTML = `
      <style>
        #plc-debug{position:fixed;left:8px;right:8px;bottom:8px;z-index:40;max-height:26vh;
          background:#0b1220ee;color:#e2e8f0;border-radius:12px;font:12px/1.4 ui-monospace,Menlo,monospace;
          box-shadow:0 8px 28px #0008;display:flex;flex-direction:column;overflow:hidden}
        #plc-debug header{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1e293b;font-weight:700;flex-wrap:wrap}
        #plc-debug header button{font:inherit;padding:4px 8px;border-radius:8px;border:0;background:#334155;color:#fff}
        #plc-debug ol{margin:0;padding:8px 10px;overflow:auto;flex:1;list-style:none}
        #plc-debug li{padding:4px 0;border-bottom:1px solid #33415555;word-break:break-word}
        #plc-debug .ok{color:#4ade80}.err{color:#f87171}.warn{color:#fbbf24}.mut{color:#94a3b8}
        #plc-debug .gate{padding:8px 10px;border-top:1px solid #334155}
        #plc-debug.min ol,#plc-debug.min .gate{display:none}
        #plc-debug .gate input{width:100%;box-sizing:border-box;margin:6px 0;padding:8px;border-radius:8px;border:0}
      </style>
      <header>DEBUG Face ID <span class="mut" id="plc-dbg-n">0</span>
        <span class="mut" id="plc-dbg-st">…</span>
        <button type="button" id="plc-dbg-min">Thu gọn</button>
        <button type="button" id="plc-dbg-clr">Xoá</button>
        <button type="button" id="plc-dbg-off">Tắt</button>
      </header>
      <div class="gate" id="plc-dbg-gate">
        <div class="mut">Chỉ tên đăng nhập của bạn (allow-list server). Nhập rồi Xác nhận.</div>
        <input id="plc-dbg-phone" autocapitalize="none" placeholder="tên đăng nhập">
        <button type="button" id="plc-dbg-go">Xác nhận tên debug</button>
      </div>
      <ol id="plc-dbg-list"></ol>`;
    document.documentElement.appendChild(panel);
    list = panel.querySelector('#plc-dbg-list');
    statusEl = panel.querySelector('#plc-dbg-st');
    const phoneInput = panel.querySelector('#plc-dbg-phone');
    phoneInput.value = readPhone();
    panel.querySelector('#plc-dbg-go').onclick = async () => {
      savePhone(phoneInput.value);
      await refreshAllow();
    };
    // Chừa chỗ cho bảng ở cuối trang để không che nút (và nằm dưới các hộp thoại của app: z-index < 50).
    const reserve = () => { try { document.body.style.paddingBottom = `${panel.offsetHeight + 8}px`; } catch {} };
    try { new ResizeObserver(reserve).observe(panel); } catch {}
    reserve();
    panel.querySelector('#plc-dbg-min').onclick = (event) => {
      const min = panel.classList.toggle('min');
      event.target.textContent = min ? 'Mở rộng' : 'Thu gọn';
      reserve();
    };
    panel.querySelector('#plc-dbg-clr').onclick = () => {
      queue.length = 0;
      list.innerHTML = '';
      panel.querySelector('#plc-dbg-n').textContent = '0';
    };
    panel.querySelector('#plc-dbg-off').onclick = () => {
      try { localStorage.removeItem(KEY); } catch {}
      panel.remove();
      document.body.style.paddingBottom = '';
      allowed = false;
      window.PlcDebug.enabled = () => false;
    };
    // đồng bộ khi gõ tên đăng nhập / đăng ký
    for (const sel of ['#username', '#reg-username']) {
      document.querySelector(sel)?.addEventListener('change', (event) => savePhone(event.target.value));
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function paint(ev) {
    ensurePanel();
    const li = document.createElement('li');
    const t = new Date(ev.ts || Date.now()).toLocaleTimeString();
    const cls = ev.level === 'error' ? 'err' : ev.level === 'warn' ? 'warn' : ev.level === 'ok' ? 'ok' : '';
    li.innerHTML = `<span class="mut">${t}</span> <b class="${cls}">${esc(ev.action || '')}</b> ${esc(ev.message || '')}`
      + (ev.detail ? ` <span class="mut">${esc(JSON.stringify(ev.detail).slice(0, 160))}</span>` : '');
    list.appendChild(li);
    while (list.children.length > 80) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
    panel.querySelector('#plc-dbg-n').textContent = String(queue.length);
  }

  async function refreshAllow() {
    if (checking) return;
    checking = true;
    ensurePanel();
    const phone = readPhone();
    statusEl.textContent = 'checking…';
    try {
      const url = new URL('/api/debug/allowed', location.origin);
      if (phone) url.searchParams.set('user', phone);
      const r = await fetch(url);
      const j = await r.json();
      allowed = Boolean(j.enabled && j.allowed);
      const gate = panel.querySelector('#plc-dbg-gate');
      if (!j.enabled) {
        statusEl.textContent = 'server OFF';
        statusEl.className = 'warn';
        gate.hidden = false;
        allowed = false;
      } else if (allowed) {
        statusEl.textContent = `OK ${j.user || phone}`;
        statusEl.className = 'ok';
        gate.hidden = true;
        log('env', 'Debug được phép cho tên này', { user: j.user }, 'ok');
        snapshotEnv();
        if (held.length) { queue.push(...held.splice(0)); scheduleFlush(); }
      } else {
        statusEl.textContent = j.needUser ? 'cần tên đăng nhập' : 'tên bị từ chối';
        statusEl.className = 'err';
        gate.hidden = false;
        allowed = false;
      }
    } catch {
      statusEl.textContent = 'offline';
      statusEl.className = 'err';
      allowed = false;
    } finally {
      checking = false;
    }
  }

  async function snapshotEnv() {
    const info = {
      secureContext: Boolean(window.isSecureContext),
      publicKeyCredential: Boolean(window.PublicKeyCredential),
      ua: navigator.userAgent,
    };
    try {
      info.platformAuthenticator = await PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.();
    } catch (e) { info.platformAuthenticatorError = e.message; }
    log('env', 'Môi trường WebAuthn', info, info.platformAuthenticator ? 'ok' : 'warn');
  }

  function log(action, message, detail, level) {
    if (!wantDebug()) return;
    ensurePanel();
    const ev = {
      id: ++lastId,
      ts: Date.now(),
      scope: 'passkey',
      action: String(action || 'event'),
      message: String(message || ''),
      level: level || 'info',
      detail: detail || undefined,
      path: location.pathname,
      deviceId: (() => { try { return JSON.parse(localStorage.getItem('devId')); } catch { return null; } })(),
    };
    if (!allowed && action !== 'env') {
      held.push(ev);
      while (held.length > 100) held.shift();
      paint({ ...ev, message: `[chờ xác nhận tên] ${message}`, level: 'warn' });
      return;
    }
    if (!allowed) return;
    queue.push(ev);
    while (queue.length > 100) queue.shift();
    paint(ev);
    try { console.log('[PlcDebug]', ev.action, ev.message, ev.detail || ''); } catch {}
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 400);
  }

  async function flush() {
    if (!wantDebug() || !allowed || !queue.length) return;
    const phone = readPhone();
    if (!phone) return;
    const batch = queue.slice(-30);
    try {
      await fetch(`${location.origin}/api/debug/trace`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': String(batch[0]?.deviceId || ''),
          'X-Debug-User': phone,
        },
        body: JSON.stringify({ username: phone, events: batch }),
        keepalive: true,
      });
    } catch (e) {
      try { console.warn('[PlcDebug] flush failed', e.message); } catch {}
    }
  }

  window.PlcDebug = {
    enabled: () => wantDebug() && allowed,
    log,
    flush,
    setPhone(p) { savePhone(p); refreshAllow(); },
  };

  ensurePanel();
  refreshAllow();
  window.addEventListener('pagehide', () => { flush(); });
})();
