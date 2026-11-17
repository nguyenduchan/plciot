'use strict';
/* Duyệt đăng nhập cho app Gateway (C#): hiện mã + IP yêu cầu, người dùng đối chiếu rồi Duyệt / Từ chối.
   Cần phiên đăng nhập webapp đầy đủ (đã qua Face ID/TOTP); server kiểm lại ở /api/v1/gateway/login/*. */
(function () {
  const $ = (s) => document.querySelector(s);
  const LOGIN = /^adminplc\./.test(location.hostname) ? 'admin-login.html' : 'login.html';   // tên miền admin có trang đăng nhập riêng
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch { /* chưa đăng nhập */ }
  if (!session?.token || session.demo) { location.replace(LOGIN); return; }
  const code = (new URLSearchParams(location.search).get('code') || '').replace(/\s/g, '');
  const focusTransfer = (new URLSearchParams(location.search).get('transfer') || '').trim();
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
    not_found: 'Yêu cầu không còn (đã xử lý hoặc hết hạn).',
    gateway_changed: 'Gateway đã thay đổi — yêu cầu bị huỷ.',
    new_owner_gone: 'Tài khoản xin nhận không còn — yêu cầu bị huỷ.',
    too_many_gateways: 'Tài khoản xin nhận đã đủ số gateway tối đa — yêu cầu bị huỷ.',
  };
  const errText = (e) => ERR[e] || (e ? `Lỗi: ${e}` : 'Có lỗi xảy ra.');

  // Yêu cầu đổi chủ gateway đang chờ (chủ cũ = mình): Duyệt cần Face ID/TOTP, Từ chối chỉ cần đăng nhập
  const fmtTime = (ms) => new Date(ms).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  async function loadTransfers() {
    const r = await rawApi('GET', '/api/v1/gateway/transfers');
    const list = r.ok ? (r.body?.transfers || []) : [];
    const box = $('#tr-list'); box.textContent = '';
    $('#tr').hidden = list.length === 0;
    for (const t of list) {
      const el = document.createElement('div'); el.className = 'tr-item';
      if (t.id === focusTransfer) el.style.borderColor = 'var(--bad)';
      const h = document.createElement('b'); h.textContent = `${t.site}/${t.device} → ${t.toUser}`;
      const p = document.createElement('p'); p.className = 'help';
      p.textContent = `Xin lúc ${fmtTime(t.createdAt)}${t.ip ? ` từ ${t.ip}` : ''}. Tự chuyển lúc ${fmtTime(t.dueAt)} nếu bạn không từ chối.`;
      const row = document.createElement('div'); row.className = 'row';
      const no = document.createElement('button'); no.textContent = 'Từ chối';
      const yes = document.createElement('button'); yes.className = 'primary'; yes.textContent = 'Duyệt chuyển';
      no.addEventListener('click', () => decideTransfer(t, false, no, yes));
      yes.addEventListener('click', () => decideTransfer(t, true, no, yes));
      row.append(no, yes); el.append(h, p, row); box.append(el);
    }
  }
  async function decideTransfer(t, approve, no, yes) {
    if (approve && !confirm(`Chuyển gateway ${t.site}/${t.device} sang tài khoản "${t.toUser}"? Bạn sẽ mất quyền xem và điều khiển gateway này.`)) return;
    no.disabled = yes.disabled = true; msg('');
    const r = await api('POST', `/api/v1/gateway/transfers/${encodeURIComponent(t.id)}/${approve ? 'approve' : 'reject'}`);
    if (r.status === 401 && r.body?.error !== 'otp_required') { location.replace(LOGIN); return; }
    if (!r.ok) { msg(errText(r.body?.error), 'err'); no.disabled = yes.disabled = false; await loadTransfers(); return; }
    msg(approve ? 'Đã chuyển gateway.' : 'Đã từ chối. Nếu không phải người quen, hãy đổi mật khẩu và kiểm tra máy gateway.', approve ? 'ok' : 'ok');
    await loadTransfers();
  }

  async function boot() {
    await loadTransfers().catch(() => {});
    if (!code) { $('#mk').hidden = false; return; }   // không kèm mã từ app → trang tạo mã kết nối
    if (!/^\d{8}$/.test(code)) { msg('Liên kết thiếu mã đăng nhập.', 'err'); return; }
    const r = await api('GET', `/api/v1/gateway/login/info?code=${encodeURIComponent(code)}`);
    if (r.status === 401) { location.replace(LOGIN); return; }
    if (!r.ok) { msg(errText(r.body?.error), 'err'); return; }
    $('#code').textContent = code;
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
