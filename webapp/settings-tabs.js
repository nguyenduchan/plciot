'use strict';
/* Cài đặt chia 4 tab: Thông tin tài khoản · Gateway (đổi tên, gỡ, logic, cập nhật, hỗ trợ từ xa, báo mất) · Giao diện · Gói dịch vụ. Nhớ tab đang xem trên máy này. */
(function () {
  const bar = document.querySelector('.set-tabs');
  if (!bar) return;
  const KEY = 'setTab';
  const names = ['acct', 'gw', 'ui', 'plan'];
  function show(name, { remember = true } = {}) {
    if (!names.includes(name)) name = 'acct';
    bar.querySelectorAll('button[data-sub]').forEach((b) => { const on = b.dataset.sub === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    document.querySelectorAll('.set-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (remember) { try { localStorage.setItem(KEY, name); } catch { /* */ } }
  }
  bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-sub]'); if (b) show(b.dataset.sub); });
  let saved = 'acct'; try { saved = localStorage.getItem(KEY) || 'acct'; } catch { /* */ }
  show(saved, { remember: false });
  document.getElementById('support-open')?.addEventListener('click', () => window.SupportChat?.support?.());
  window.SettingsTabs = { show };
}());
