'use strict';
/* Trang quản trị: thêm user, đổi vai trò, đổi site/thiết bị, khoá, đặt lại mật khẩu, xoá. Chỉ role admin. */
(function () {
  const $ = (s) => document.querySelector(s);
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch {}
  if (!session?.token || session.demo) { location.replace('login.html'); return; }
  const base = session.apiBase || location.origin;

  const ERR = {
    forbidden: 'Bạn không có quyền quản trị.',
    unauthorized: 'Phiên hết hạn, đăng nhập lại.',
    session_revoked: 'Phiên đã bị thu hồi, đăng nhập lại.',
    account_disabled: 'Tài khoản đã bị khoá.',
    invalid_phone: 'Cần số di động Việt Nam hợp lệ.',
    invalid_role: 'Vai trò không hợp lệ.',
    weak_password: 'Mật khẩu tối thiểu 8 ký tự.',
    phone_in_use: 'Số này đã có tài khoản.',
    invalid_site_or_device: 'Site/thiết bị chỉ gồm chữ, số, "_" và "-" (tối đa 48 ký tự).',
    last_admin: 'Không thể hạ quyền/khoá/xoá admin cuối cùng (hoặc chính bạn).',
    user_not_found: 'Không tìm thấy người dùng.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
  };

  function msg(text, cls) { const m = $('#msg'); m.textContent = text || ''; m.className = cls || ''; }

  async function api(path, method = 'GET', body) {
    const r = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(ERR[data.error] || data.error || `Lỗi ${r.status}`);
    return data;
  }

  const SCOPE_LABEL = { telemetry: 'Số liệu', status: 'Trạng thái', ack: 'Phản hồi lệnh', history: 'Lịch sử giờ' };
  let scopesAll = Object.keys(SCOPE_LABEL);
  let roles = ['admin', 'operator', 'viewer'];
  let users = [];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const roleOpts = (sel) => roles.map((r) => `<option value="${r}"${r === sel ? ' selected' : ''}>${r}</option>`).join('');

  const scopeBoxes = (sel, attr) => scopesAll.map((s) =>
    `<label><input type="checkbox" ${attr}="${s}"${sel.includes(s) ? ' checked' : ''}> ${SCOPE_LABEL[s] || s}</label>`).join('');

  function render() {
    $('#count').textContent = users.length;
    $('#list').innerHTML = users.map((u) => `
      <div class="u${u.disabled ? ' dis' : ''}" data-id="${u.id}">
        <div><b>${esc(u.phoneLocal || u.phone)}</b> <span class="tag ${u.role}">${u.role}</span>${u.disabled ? ' <span class="tag viewer">đã khoá</span>' : ''}
          <small>site <code>${esc(u.site)}</code> · thiết bị <code>${esc(u.device)}</code>${u.telegramLinked ? ' · Telegram ✓' : ''}</small></div>
        <div></div>
        <div class="scopes" data-scopes>${scopeBoxes(u.scopes, 'data-sc')}</div>
        <div class="acts">
          <select data-act="role">${roleOpts(u.role)}</select>
          <button data-act="site">Đổi site/thiết bị</button>
          <button data-act="pass">Đặt mật khẩu</button>
          <button data-act="toggle">${u.disabled ? 'Mở khoá' : 'Khoá'}</button>
          <button data-act="del" class="danger">Xoá</button>
        </div>
      </div>`).join('') || '<p class="help">Chưa có người dùng.</p>';
  }

  async function load() {
    try {
      const j = await api('/api/admin/users');
      roles = j.roles; users = j.users; scopesAll = j.scopes || scopesAll;
      $('#n-scopes').innerHTML = scopeBoxes(scopesAll, 'data-nsc');
      $('#n-role').innerHTML = roleOpts('operator');
      render();
    } catch (e) {
      $('#list').textContent = '';
      msg(e.message, 'err');
      if (/quản trị|đăng nhập lại|khoá/.test(e.message)) setTimeout(() => location.replace('index.html'), 2500);
    }
  }

  async function run(fn, okText) {
    msg('');
    try { await fn(); msg(okText, 'ok'); await load(); } catch (e) { msg(e.message, 'err'); }
  }

  $('#n-add').onclick = () => run(async () => {
    await api('/api/admin/users', 'POST', {
      phone: $('#n-phone').value.trim(), password: $('#n-pass').value,
      scopes: [...document.querySelectorAll('[data-nsc]')].filter((c) => c.checked).map((c) => c.dataset.nsc),
      role: $('#n-role').value, site: $('#n-site').value.trim() || undefined, device: $('#n-dev').value.trim() || undefined,
    });
    $('#n-phone').value = ''; $('#n-pass').value = '';
  }, 'Đã thêm người dùng.');

  $('#list').addEventListener('change', (e) => {
    const row = e.target.closest('.u');
    if (e.target.dataset.sc && row) {
      const scopes = [...row.querySelectorAll('[data-sc]')].filter((c) => c.checked).map((c) => c.dataset.sc);
      return run(() => api(`/api/admin/users/${row.dataset.id}`, 'PATCH', { scopes }), 'Đã đổi phạm vi xem.');
    }
    if (e.target.dataset.act !== 'role' || !row) return;
    run(() => api(`/api/admin/users/${row.dataset.id}`, 'PATCH', { role: e.target.value }), 'Đã đổi vai trò.');
  });

  $('#list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    const row = e.target.closest('.u');
    if (!b || !row) return;
    const id = row.dataset.id;
    const u = users.find((x) => String(x.id) === id);
    if (b.dataset.act === 'toggle') {
      if (!u.disabled && !confirm(`Khoá ${u.phoneLocal}? Họ bị đăng xuất và mất quyền MQTT ngay.`)) return;
      run(() => api(`/api/admin/users/${id}`, 'PATCH', { disabled: !u.disabled }), u.disabled ? 'Đã mở khoá.' : 'Đã khoá.');
    } else if (b.dataset.act === 'pass') {
      const p = prompt(`Mật khẩu mới cho ${u.phoneLocal} (tối thiểu 8 ký tự). Họ sẽ bị đăng xuất khỏi mọi thiết bị.`);
      if (p) run(() => api(`/api/admin/users/${id}`, 'PATCH', { password: p }), 'Đã đặt mật khẩu.');
    } else if (b.dataset.act === 'site') {
      const site = prompt('Site mới:', u.site); if (!site) return;
      const device = prompt('Thiết bị mới:', u.device); if (!device) return;
      run(() => api(`/api/admin/users/${id}`, 'PATCH', { site, device }), 'Đã đổi site/thiết bị.');
    } else if (b.dataset.act === 'del') {
      if (!confirm(`Xoá vĩnh viễn ${u.phoneLocal}? Không thể hoàn tác (nên dùng Khoá nếu chỉ tạm dừng).`)) return;
      run(() => api(`/api/admin/users/${id}`, 'DELETE'), 'Đã xoá.');
    }
  });

  load();
})();
