'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch {}
  if (!session?.token) { location.replace('admin-login.html'); return; }
  const ERR = {
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

  const EVENT = { login_ok: 'Đăng nhập', admin_login_fail: 'Đăng nhập sai', admin_password_changed: 'Đổi mật khẩu', admin_totp_changed: 'Đổi Authenticator', admin_sessions_revoked: 'Đăng xuất máy khác', totp_enabled: 'Bật Authenticator' };
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
    $('#sessions').innerHTML = me.sessions.map((s) => `<tr><td>${esc(s.device)}${s.current ? ' <span class="tag">phiên này</span>' : ''}</td><td>${when(s.lastSeen)}</td><td></td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>';
    $('#history').innerHTML = me.history.map((h) => `<tr><td>${when(h.ts)}</td><td>${esc(EVENT[h.event] || h.event)}${h.event === 'admin_login_fail' ? ` <span class="tag bad">${esc(h.detail)}</span>` : ''}</td><td>${esc(h.ip)}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>';
    $('#server').innerHTML = SERVER.map(([k, f, warn]) => `<tr><td>${k}</td><td>${warn(me.server) ? '⚠ ' : ''}<b>${esc(f(me.server))}</b></td></tr>`).join('');
  }

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
