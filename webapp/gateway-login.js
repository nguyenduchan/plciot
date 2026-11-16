'use strict';
/* Duyệt đăng nhập cho app Gateway (C#): hiện mã + IP yêu cầu, người dùng đối chiếu rồi Duyệt / Từ chối.
   Cần phiên đăng nhập webapp đầy đủ (đã qua Face ID/TOTP); server kiểm lại ở /api/v1/gateway/login/*. */
(function () {
  const $ = (s) => document.querySelector(s);
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch { /* chưa đăng nhập */ }
  if (!session?.token || session.demo) { location.replace('login.html'); return; }
  const code = (new URLSearchParams(location.search).get('code') || '').trim().toUpperCase();
  const api = (m, p, b) => window.Security.api(m, p, b);
  const msg = (t, cls) => { const m = $('#msg'); m.textContent = t || ''; m.className = cls || ''; };
  const ERR = {
    invalid_login: 'Mã không đúng, đã hết hạn hoặc đã được xử lý.',
    unauthorized: 'Phiên đăng nhập hết hạn — đăng nhập lại rồi mở lại liên kết.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
  };
  const errText = (e) => ERR[e] || (e ? `Lỗi: ${e}` : 'Có lỗi xảy ra.');

  async function boot() {
    if (!/^[0-9A-Z]{4}-?[0-9A-Z]{4}$/.test(code)) { msg('Liên kết thiếu mã đăng nhập.', 'err'); return; }
    const r = await api('GET', `/api/v1/gateway/login/info?code=${encodeURIComponent(code)}`);
    if (r.status === 401) { location.replace('login.html'); return; }
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

  $('#ok').addEventListener('click', () => decide(true));
  $('#deny').addEventListener('click', () => decide(false));
  boot().catch(() => msg('Không kết nối được máy chủ.', 'err'));
})();
