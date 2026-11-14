'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch {}
  if (!session?.token) { location.replace('admin-login.html'); return; }
  const ERR = {
    faceid_failed: 'Không xác nhận được Face ID. Thử lại.', last_faceid: 'Không xoá được Face ID cuối cùng khi đang bắt buộc Face ID.',
    invalid_credentials: 'Sai mật khẩu.', totp_invalid: 'Mã Authenticator sai hoặc đã dùng.', locked: 'Sai quá nhiều lần, thử lại sau 15 phút.',
    password_weak: 'Mật khẩu mới yếu: cần ≥ 10 ký tự, có chữ và số, không chứa tên đăng nhập.', totp_not_pending: 'Chưa tạo khoá mới.',
    admin_session_required: 'Hãy đăng nhập lại bằng trang đăng nhập quản trị.', unauthorized: 'Phiên hết hạn, đăng nhập lại.',
    session_revoked: 'Phiên đã bị thu hồi, đăng nhập lại.', rate_limited: 'Thao tác quá nhanh, chờ một chút.',
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (t) => new Date(t).toLocaleString('vi-VN');
  const msg = (t, cls) => { const m = $('#msg'); m.textContent = t || ''; m.className = cls || ''; };

  async function api(path, method = 'GET', body) {
    const r = await fetch(path, { method, headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && ['unauthorized', 'session_revoked', 'admin_session_required', 'app_locked'].includes(j.error)) {
      try { localStorage.removeItem('session'); } catch {}
      location.replace('admin-login.html');
    }
    if (!r.ok) throw new Error(ERR[j.error] || j.error || `Lỗi ${r.status}`);
    return j;
  }

  const EVENT = { login_ok: 'Đăng nhập', admin_login_fail: 'Đăng nhập sai', admin_password_changed: 'Đổi mật khẩu', admin_totp_changed: 'Đổi Authenticator', admin_sessions_revoked: 'Đăng xuất máy khác', totp_enabled: 'Bật Authenticator', admin_faceid_registered: 'Đăng ký Face ID', admin_faceid_removed: 'Xoá Face ID' };
  const SERVER = [
    ['Tên miền admin', (s) => s.adminHost || '— (chưa đặt ADMIN_HOST)', () => false],
    ['Thời hạn phiên', (s) => `${s.sessionHours} giờ`, () => false],
    ['Giới hạn IP admin', (s) => s.adminOnlyCidrs || 'không giới hạn', (s) => !s.adminOnlyCidrs],
    ['Tài khoản admin từ Internet', (s) => s.adminInternetUsers || 'không ai', () => false],
    ['Bỏ xác thực lại (REAUTH_DISABLED)', (s) => (s.reauthDisabled ? 'ĐANG BẬT' : 'tắt'), (s) => s.reauthDisabled],
    ['Bỏ khoá phiên rảnh (APP_LOCK_DISABLED)', (s) => (s.appLockDisabled ? 'ĐANG BẬT' : 'tắt'), (s) => s.appLockDisabled],
    ['Vào admin qua đường hầm SSH không đăng nhập', (s) => (s.sshLogin ? 'bật' : 'tắt'), () => false],
  ];

  async function load() {
    const me = await api('/api/admin-site/me');
    $('#who').textContent = me.username;
    const t = $('#totp-state'); t.textContent = me.totpEnabled ? 'đã bật' : 'chưa bật'; t.className = `tag ${me.totpEnabled ? 'ok' : 'bad'}`;
    document.querySelectorAll('.totp-need').forEach((e) => { e.style.display = me.totpEnabled ? '' : 'none'; });
    const fs = $('#face-state'); fs.textContent = me.faceIds.length ? `${me.faceIds.length} máy` : (me.requireFaceId ? 'chưa đăng ký' : 'chưa bật'); fs.className = `tag ${me.faceIds.length ? 'ok' : 'bad'}`;
    $('#faces').innerHTML = me.faceIds.map((f) => `<tr><td>${esc(f.name || 'Thiết bị')}</td><td>${when(f.createdAt)}</td><td>${f.lastUsedAt ? when(f.lastUsedAt) : '—'}</td><td><button class="fit" type="button" data-face-del="${f.id}">Xoá</button></td></tr>`).join('') || '<tr><td colspan="4">—</td></tr>';
    $('#sessions').innerHTML = me.sessions.map((s) => `<tr><td>${esc(s.device)}${s.current ? ' <span class="tag">phiên này</span>' : ''}</td><td>${when(s.lastSeen)}</td><td></td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>';
    $('#history').innerHTML = me.history.map((h) => `<tr><td>${when(h.ts)}</td><td>${esc(EVENT[h.event] || h.event)}${h.event === 'admin_login_fail' ? ` <span class="tag bad">${esc(h.detail)}</span>` : ''}</td><td>${esc(h.ip)}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>';
    $('#server').innerHTML = SERVER.map(([k, f, warn]) => `<tr><td>${k}</td><td>${warn(me.server) ? '⚠ ' : ''}<b>${esc(f(me.server))}</b></td></tr>`).join('');
  }

  const b64uToBuf = (x) => { const t = String(x).replace(/-/g, '+').replace(/_/g, '/'); const b = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer; };
  const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  $('#btn-face-add')?.addEventListener('click', async () => {
    msg('');
    try {
      if (!window.PublicKeyCredential) throw new Error('Trình duyệt này không hỗ trợ Face ID / vân tay.');
      const o = await api('/api/admin-site/faceid/add/options', 'POST', { password: $('#face-pw').value });
      let cred;
      try {
        cred = await navigator.credentials.create({ publicKey: { ...o, challenge: b64uToBuf(o.challenge), user: { ...o.user, id: b64uToBuf(o.user.id) }, hints: ['client-device'], excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) } });
      } catch (e) { throw new Error(e?.name === 'NotAllowedError' ? 'Chưa xác nhận được Face ID / vân tay.' : `Không dùng được Face ID (${e?.name || 'lỗi'}).`); }
      await api('/api/admin-site/faceid/add/verify', 'POST', { name: `Thiết bị ${new Date().toLocaleDateString('vi-VN')}`, credential: { id: cred.id, type: cred.type, response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject) } } });
      $('#face-pw').value = '';
      msg('Đã thêm Face ID cho máy này.', 'ok'); await load();
    } catch (e) { msg(e.message, 'err'); }
  });

  $('#faces')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-face-del]');
    if (!b || !confirm('Xoá Face ID của máy này?')) return;
    run(async () => { await api(`/api/admin-site/faceid/${b.dataset.faceDel}`, 'DELETE'); msg('Đã xoá.', 'ok'); await load(); })();
  });

  const run = (fn) => async () => { msg(''); try { await fn(); } catch (e) { msg(e.message, 'err'); } };

  $('#btn-pw').addEventListener('click', run(async () => {
    await api('/api/admin-site/password', 'POST', { current: $('#pw-cur').value, next: $('#pw-new').value, code: $('#pw-code').value.trim() });
    ['#pw-cur', '#pw-new', '#pw-code'].forEach((i) => { $(i).value = ''; });
    msg('Đã đổi mật khẩu; các phiên khác đã bị đăng xuất.', 'ok'); await load();
  }));

  $('#btn-tc').addEventListener('click', run(async () => {
    const j = await api('/api/admin-site/totp/change/start', 'POST', { password: $('#tc-pw').value, code: $('#tc-code').value.trim() });
    $('#tc-start').classList.add('hidden'); $('#tc-finish').classList.remove('hidden');
    $('#secret').textContent = j.secret; $('#qr').innerHTML = '';
    try { const c = document.createElement('canvas'); $('#qr').appendChild(c); window.QRCode.toCanvas(c, j.uri, { width: 220, margin: 2 }); } catch {}
  }));

  $('#btn-tc-ok').addEventListener('click', run(async () => {
    await api('/api/admin-site/totp/change/finish', 'POST', { code: $('#tc-new').value.trim() });
    $('#tc-finish').classList.add('hidden'); $('#tc-start').classList.remove('hidden');
    ['#tc-pw', '#tc-code', '#tc-new'].forEach((i) => { $(i).value = ''; });
    msg('Đã đổi Authenticator.', 'ok'); await load();
  }));

  $('#btn-revoke').addEventListener('click', run(async () => {
    const r = await api('/api/admin-site/sessions/revoke-others', 'POST', {});
    msg(`Đã đăng xuất ${r.revoked} phiên khác.`, 'ok'); await load();
  }));

  load().catch((e) => msg(e.message, 'err'));
})();
