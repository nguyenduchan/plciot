'use strict';
/* Đăng nhập trang quản trị: mật khẩu + Authenticator. Lưu phiên vào localStorage 'session' (admin.js / console.js dùng chung). */
(function () {
  const $ = (s) => document.querySelector(s);
  const ERR = {
    invalid_credentials: 'Sai tên đăng nhập hoặc mật khẩu.',
    totp_invalid: 'Mã Authenticator sai hoặc đã dùng.',
    locked: 'Sai quá nhiều lần, thử lại sau 15 phút.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
    ticket_invalid: 'Phiên đăng ký đã hết hạn, đăng nhập lại.',
    totp_not_pending: 'Chưa tạo khoá Authenticator.',
  };
  let ticket = null;

  const msg = (t) => { const e = $('#error'); e.textContent = t || ''; e.style.display = t ? 'block' : 'none'; };
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  }
  function done(j) {
    try { localStorage.removeItem('ctl'); localStorage.setItem('session', JSON.stringify({ token: j.token, apiBase: location.origin, admin: true, username: j.username })); } catch {}
    location.replace('admin.html');
  }
  const text = (j, status) => ERR[j.error] || (status === 404 ? 'Không có quyền truy cập từ vị trí này.' : `Lỗi ${status}`);

  $('#step-login').addEventListener('submit', async (ev) => {
    ev.preventDefault(); msg('');
    const btn = $('#btn-login'); btn.disabled = true;
    try {
      const { ok, status, j } = await post('/api/admin-site/login', {
        username: $('#username').value.trim(), password: $('#password').value, code: $('#code').value.trim(),
      });
      if (ok && j.token) return done(j);
      if (ok && j.setupRequired) { ticket = j.ticket; return startSetup(); }
      if (j.error === 'totp_required') { $('#code-row').classList.remove('hidden'); $('#code').focus(); return msg('Nhập mã 6 số từ ứng dụng Authenticator.'); }
      msg(text(j, status));
    } catch { msg('Không kết nối được máy chủ.'); } finally { btn.disabled = false; }
  });

  async function startSetup() {
    const { ok, status, j } = await post('/api/admin-site/totp/setup', { ticket });
    if (!ok) return msg(text(j, status));
    $('#step-login').classList.add('hidden'); $('#step-setup').classList.remove('hidden');
    $('#secret').textContent = j.secret;
    try {
      const c = document.createElement('canvas'); $('#qr').appendChild(c);
      window.QRCode.toCanvas(c, j.uri, { width: 220, margin: 2 });
    } catch { /* vẫn nhập tay bằng khoá */ }
    $('#setup-code').focus();
  }

  $('#btn-enable').addEventListener('click', async () => {
    msg('');
    const { ok, status, j } = await post('/api/admin-site/totp/enable', { ticket, code: $('#setup-code').value.trim() });
    if (ok && j.token) return done(j);
    msg(text(j, status));
  });

  msg('');
})();
