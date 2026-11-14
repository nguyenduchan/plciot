'use strict';
/* Thanh điều hướng chung cho trang quản trị riêng: Người dùng / Console / Cài đặt / Đăng xuất + giữ phiên (activity ping). */
(function () {
  let s = null;
  try { s = JSON.parse(localStorage.getItem('session')); } catch {}
  const here = location.pathname.split('/').pop() || 'admin.html';
  const items = [['admin.html', 'Người dùng & gateway'], ['console.html', 'Console IoT'], ['admin-chat.html', 'Hỗ trợ'], ['admin-settings.html', 'Cài đặt']];
  const bar = document.createElement('nav');
  bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:0 0 14px;padding:6px;border-radius:12px;background:var(--card,#fff);box-shadow:0 0 0 1px var(--line,#ddd)';
  bar.innerHTML = items.map(([h, t]) => `<a href="${h}" style="padding:8px 12px;border-radius:9px;text-decoration:none;font-weight:600;font-size:14px;${h === here ? 'background:var(--accbg,#e6f4f1);color:var(--acc,#0f766e)' : 'color:var(--mut,#667)'}">${t}</a>`).join('')
    + '<span style="flex:1"></span>'
    + `<span style="font-size:13px;color:var(--mut,#667)">${s?.username ? s.username.replace(/[<>&"]/g, '') : ''}</span>`
    + '<button type="button" id="admin-logout" style="padding:8px 12px;font-size:13px;border-radius:9px">Đăng xuất</button>';
  document.body.insertBefore(bar, document.body.firstChild);
  const auth = () => ({ Authorization: `Bearer ${s?.token || ''}` });
  document.getElementById('admin-logout').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', headers: auth() }); } catch {}
    try { localStorage.removeItem('session'); localStorage.removeItem('ctl'); } catch {}
    location.replace('admin-login.html');
  });
  // Số tin chưa đọc trên mục "Hỗ trợ"
  const chatLink = bar.querySelector('a[href="admin-chat.html"]');
  const unread = () => fetch('/api/admin/support/threads', { headers: auth() }).then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j && chatLink) chatLink.textContent = j.unread ? `Hỗ trợ (${j.unread})` : 'Hỗ trợ';
  }).catch(() => {});
  if (s?.token) { unread(); setInterval(unread, 30000); }
  if (s?.token) setInterval(() => { fetch('/api/login/activity', { method: 'POST', headers: auth() }).catch(() => {}); }, 60000);
})();
