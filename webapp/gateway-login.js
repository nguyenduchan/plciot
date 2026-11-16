'use strict';
/* Duyệt đăng nhập cho app Gateway (C#): hiện mã + IP yêu cầu, người dùng đối chiếu rồi Duyệt / Từ chối.
   Cần phiên đăng nhập webapp đầy đủ (đã qua Face ID/TOTP); server kiểm lại ở /api/v1/gateway/login/*. */
(function () {
  const $ = (s) => document.querySelector(s);
  const LOGIN = /^adminplc\./.test(location.hostname) ? 'admin-login.html' : 'login.html';   // tên miền admin có trang đăng nhập riêng
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch { /* chưa đăng nhập */ }
  if (!session?.token || session.demo) { location.replace(LOGIN); return; }
  const code = (new URLSearchParams(location.search).get('code') || '').trim().toUpperCase();
  const rawApi = (m, p, b) => window.Security.api(m, p, b);
  // Ghép gateway cần OTP (Authenticator) hoặc Face ID: chưa có phiên xác thực thứ hai thì mở khoá rồi gọi lại một lần.
  async function api(m, p, b) {
    let r = await rawApi(m, p, b);
    if (r.status === 401 && r.body?.error === 'otp_required') {
      const cs = await rawApi('GET', '/api/control/status');
      const methods = cs.body?.methods || {};
      if (!methods.totp && !methods.passkey) {
        msg('Cần bật Authenticator (OTP) hoặc Face ID trong Cài đặt trước khi ghép gateway.', 'err');
        return r;
      }
      const ok = await window.Security.unlock({ methods: { passkey: !!methods.passkey, totp: !!methods.totp, password: false, enrolled: true }, title: 'Xác thực OTP để ghép gateway' });
      if (ok === true) r = await rawApi(m, p, b);
    }
    return r;
  }
  const msg = (t, cls) => { const m = $('#msg'); m.textContent = t || ''; m.className = cls || ''; };
  const ERR = {
    invalid_login: 'Mã không đúng, đã hết hạn hoặc đã được xử lý.',
    otp_required: 'Cần xác thực OTP (Authenticator) hoặc Face ID — chỉ mật khẩu là không đủ.',
    forbidden: 'Chỉ admin mới tạo mã cho người dùng khác.',
    user_not_found: 'Không có người dùng này.',
    too_many_codes: 'Đang có quá nhiều mã chưa dùng, đợi hết hạn rồi tạo lại.',
    unauthorized: 'Phiên đăng nhập hết hạn — đăng nhập lại rồi mở lại liên kết.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
  };
  const errText = (e) => ERR[e] || (e ? `Lỗi: ${e}` : 'Có lỗi xảy ra.');

  async function boot() {
    if (!code) { $('#mk').hidden = false; return; }   // không kèm mã từ app → trang tạo mã kết nối
    if (!/^[0-9A-Z]{4}-?[0-9A-Z]{4}$/.test(code)) { msg('Liên kết thiếu mã đăng nhập.', 'err'); return; }
    const r = await api('GET', `/api/v1/gateway/login/info?code=${encodeURIComponent(code)}`);
    if (r.status === 401) { location.replace(LOGIN); return; }
    if (!r.ok) { msg(errText(r.body?.error), 'err'); return; }
    $('#code').textContent = code.includes('-') ? code : `${code.slice(0, 4)}-${code.slice(4)}`;
    const t = new Date(r.body.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    $('#meta').textContent = `Yêu cầu lúc ${t}${r.body.ip ? ` từ địa chỉ ${r.body.ip}` : ''}.`;
    $('#box').hidden = false;
  }

  async function decide(approve) {
    $('#ok').disabled = $('#deny').disabled = true;
    const r = await api('POST', '/api/v1/gateway/login/approve', { code, approve });
    if (!r.ok) { msg(errText(r.body?.error), 'err'); return; }
    $('#box').hidden = true;
    msg(approve ? 'Đã duyệt. Quay lại ứng dụng Gateway.' : 'Đã từ chối.', approve ? 'ok' : '');
  }

  $('#mk-go').addEventListener('click', async () => {
    $('#mk-go').disabled = true; msg('');
    const u = $('#mk-user').value.trim();
    const r = await api('POST', '/api/v1/gateway/connect-code', u ? { username: u } : {});
    $('#mk-go').disabled = false;
    if (r.status === 401) { location.replace(LOGIN); return; }
    if (!r.ok) { msg(errText(r.body?.error), 'err'); return; }
    $('#mk-code').textContent = r.body.code;
    $('#mk-exp').textContent = `Dùng một lần, hết hạn sau ${Math.round(r.body.expiresIn / 60)} phút · tài khoản ${r.body.forUser}`;
    $('#mk-out').hidden = false;
  });
  $('#ok').addEventListener('click', () => decide(true));
  $('#deny').addEventListener('click', () => decide(false));
  boot().catch(() => msg('Không kết nối được máy chủ.', 'err'));
})();
