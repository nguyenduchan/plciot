/* GENERATED từ packages/security/client/debug-trace.js bằng "npm run sync-client". KHÔNG sửa ở đây. */
'use strict';
/*
 * Debug overlay Passkey/Face ID — chỉ hoạt động khi server cho phép SĐT của bạn.
 * Bật ý định: ?debug=1  |  Tắt: ?debug=0
 * SĐT: lấy từ ô đăng nhập / session / ?phone= / localStorage.plcDebugPhone
 */
(function () {
  const KEY = 'plcDebug';
  const PHONE_KEY = 'plcDebugPhone';
  const q = new URLSearchParams(location.search);
  if (q.get('debug') === '1') try { localStorage.setItem(KEY, '1'); } catch {}
  if (q.get('debug') === '0') {
    try { localStorage.removeItem(KEY); } catch {}
  }
  if (q.get('phone')) {
    try { localStorage.setItem(PHONE_KEY, String(q.get('phone')).replace(/\D/g, '')); } catch {}
  }

  function wantDebug() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  }

  function readPhone() {
    try {
      const stored = localStorage.getItem(PHONE_KEY);
      if (stored) return stored.replace(/\D/g, '');
    } catch {}
    try {
      const s = JSON.parse(localStorage.getItem('session') || 'null');
      if (s?.phone) return String(s.phone).replace(/\D/g, '');
    } catch {}
    const el = document.querySelector('#phone');
    if (el?.value) {
      let p = String(el.value).replace(/\D/g, '');
      if (p.length === 9) p = '0' + p;
      if (p.length === 10 && p.startsWith('0')) p = '84' + p.slice(1);
      return p;
    }
    return '';
  }

  function savePhone(p) {
    const n = String(p || '').replace(/\D/g, '');
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
  let checking = false;

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'plc-debug';
    panel.innerHTML = `
      <style>
        #plc-debug{position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;max-height:42vh;
          background:#0b1220ee;color:#e2e8f0;border-radius:12px;font:12px/1.4 ui-monospace,Menlo,monospace;
          box-shadow:0 8px 28px #0008;display:flex;flex-direction:column;overflow:hidden}
        #plc-debug header{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1e293b;font-weight:700;flex-wrap:wrap}
        #plc-debug header button{font:inherit;padding:4px 8px;border-radius:8px;border:0;background:#334155;color:#fff}
        #plc-debug ol{margin:0;padding:8px 10px;overflow:auto;flex:1;list-style:none}
        #plc-debug li{padding:4px 0;border-bottom:1px solid #33415555;word-break:break-word}
        #plc-debug .ok{color:#4ade80}.err{color:#f87171}.warn{color:#fbbf24}.mut{color:#94a3b8}
        #plc-debug .gate{padding:8px 10px;border-top:1px solid #334155}
        #plc-debug .gate input{width:100%;box-sizing:border-box;margin:6px 0;padding:8px;border-radius:8px;border:0}
      </style>
      <header>DEBUG Face ID <span class="mut" id="plc-dbg-n">0</span>
        <span class="mut" id="plc-dbg-st">…</span>
        <button type="button" id="plc-dbg-clr">Xoá</button>
        <button type="button" id="plc-dbg-off">Tắt</button>
      </header>
      <div class="gate" id="plc-dbg-gate">
        <div class="mut">Chỉ SĐT của bạn (allow-list server). Nhập số rồi Xác nhận.</div>
        <input id="plc-dbg-phone" inputmode="tel" placeholder="09xxxxxxxx">
        <button type="button" id="plc-dbg-go">Xác nhận SĐT debug</button>
      </div>
      <ol id="plc-dbg-list"></ol>`;
    document.documentElement.appendChild(panel);
    list = panel.querySelector('#plc-dbg-list');
    statusEl = panel.querySelector('#plc-dbg-st');
    const phoneInput = panel.querySelector('#plc-dbg-phone');
    phoneInput.value = (() => {
      const p = readPhone();
      if (p.startsWith('84') && p.length === 11) return '0' + p.slice(2);
      return p;
    })();
    panel.querySelector('#plc-dbg-go').onclick = async () => {
      savePhone(phoneInput.value);
      await refreshAllow();
    };
    panel.querySelector('#plc-dbg-clr').onclick = () => {
      queue.length = 0;
      list.innerHTML = '';
      panel.querySelector('#plc-dbg-n').textContent = '0';
    };
    panel.querySelector('#plc-dbg-off').onclick = () => {
      try { localStorage.removeItem(KEY); } catch {}
      panel.remove();
      allowed = false;
      window.PlcDebug.enabled = () => false;
    };
    // đồng bộ khi gõ SĐT login
    document.querySelector('#phone')?.addEventListener('change', () => {
      savePhone(document.querySelector('#phone').value);
    });
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
      if (phone) url.searchParams.set('phone', phone);
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
        statusEl.textContent = `OK ${j.phone || phone}`;
        statusEl.className = 'ok';
        gate.hidden = true;
        log('env', 'Debug được phép cho SĐT này', { phone: j.phone }, 'ok');
        snapshotEnv();
      } else {
        statusEl.textContent = j.needPhone ? 'cần SĐT' : 'SĐT bị từ chối';
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
    if (!allowed && action !== 'env') {
      // vẫn hiện local để biết đang bị chặn
      paint({ ts: Date.now(), action, message: `[chưa allow] ${message}`, level: 'warn', detail });
      return;
    }
    if (!allowed) return;
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
          'X-Debug-Phone': phone,
        },
        body: JSON.stringify({ phone, events: batch }),
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
