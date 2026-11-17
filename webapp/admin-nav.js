'use strict';
/* Thanh điều hướng chung cho trang quản trị riêng: Người dùng / Console / Cài đặt / Đăng xuất + giữ phiên khi ĐANG thao tác + tự đăng xuất khi bỏ máy. */
(function () {
  let s = null;
  try { s = JSON.parse(localStorage.getItem('session')); } catch {}
  const here = location.pathname.split('/').pop() || 'admin.html';
  const items = [['admin.html', 'Người dùng & gateway'], ['console.html', 'Console IoT'], ['gateway-login.html', 'Mã ghép gateway (OTP)'], ['admin-chat.html', 'Hỗ trợ'], ['admin-settings.html', 'Cài đặt']];

  // Kiểu riêng của trang quản trị. Thanh dùng <div role="navigation"> chứ KHÔNG dùng <nav>: style.css của app có luật `nav{…}`
  // (thanh đáy trên điện thoại / cột bên cao 100vh trên máy tính) từng biến thanh này thành một khối cao hết màn hình, đẩy nội dung xuống dưới.
  const css = document.createElement('style');
  css.textContent = `
    .admin-bar{position:sticky;top:0;z-index:20;display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin:0 0 16px;padding:6px 8px;border-radius:12px;background:var(--card,#fff);box-shadow:0 0 0 1px var(--line,#ddd),0 2px 8px rgba(0,0,0,.06)}
    .admin-bar .ab-brand{font-weight:700;font-size:14px;padding:0 10px 0 6px;letter-spacing:.02em;white-space:nowrap}
    .admin-bar a{padding:8px 12px;border-radius:9px;text-decoration:none;font-weight:600;font-size:14px;color:var(--mut,#667);white-space:nowrap}
    .admin-bar a:hover{background:var(--bg,#f2f2f2);color:var(--fg,#111)}
    .admin-bar a.on{background:var(--accbg,#e6f4f1);color:var(--acc,#0f766e)}
    .admin-bar .ab-sp{flex:1}
    .admin-bar .ab-user{font-size:13px;color:var(--mut,#667);padding:0 4px;white-space:nowrap}
    .admin-bar .ab-idle{font-size:12px;color:var(--warn,#9a6100);padding:0 4px;white-space:nowrap}
    .admin-bar button{width:auto;flex:none;padding:8px 12px;font-size:13px;border-radius:9px}
    /* việc không hoàn tác được (xoá, thu hồi) phải khác hẳn nút thường */
    button.danger{color:var(--bad,#c4262e);border:1.5px solid var(--bad,#c4262e);background:transparent;font-weight:600}
    button.danger:hover{background:var(--bad,#c4262e);color:#fff}
    /* dải tab cuộn ngang: bỏ thanh cuộn thô của hệ điều hành */
    .tabs{scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
    @media(max-width:640px){.admin-bar .ab-brand{display:none}.admin-bar a{padding:7px 9px;font-size:13px}}`;
  document.head.appendChild(css);

  const bar = document.createElement('div');
  bar.className = 'admin-bar';
  bar.setAttribute('role', 'navigation');
  bar.setAttribute('aria-label', 'Quản trị');
  bar.innerHTML = '<span class="ab-brand">Quản trị PLC</span>'
    + items.map(([h, t]) => `<a href="${h}"${h === here ? ' class="on" aria-current="page"' : ''}>${t}</a>`).join('')
    + '<span class="ab-sp"></span>'
    + '<span class="ab-idle" id="admin-idle" hidden></span>'
    + `<span class="ab-user">${s?.username ? s.username.replace(/[<>&"]/g, '') : ''}</span>`
    + '<button type="button" id="admin-logout">Đăng xuất</button>';
  document.body.insertBefore(bar, document.body.firstChild);

  const auth = () => ({ Authorization: `Bearer ${s?.token || ''}` });
  async function logout(why) {
    try { await fetch('/api/logout', { method: 'POST', headers: auth() }); } catch {}
    try { localStorage.removeItem('session'); localStorage.removeItem('ctl'); } catch {}
    location.replace(`admin-login.html${why ? `?why=${why}` : ''}`);
  }
  document.getElementById('admin-logout').addEventListener('click', () => logout(''));

  // Số tin chưa đọc trên mục "Hỗ trợ"
  const chatLink = bar.querySelector('a[href="admin-chat.html"]');
  const unread = () => fetch('/api/admin/support/threads', { headers: auth() }).then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j && chatLink) chatLink.textContent = j.unread ? `Hỗ trợ (${j.unread})` : 'Hỗ trợ';
  }).catch(() => {});
  if (s?.token) { unread(); setInterval(unread, 30000); }

  // Phiên quản trị (DB + cấp gói): chỉ gia hạn khi người quản trị ĐANG thao tác. Bỏ máy IDLE_MS → tự đăng xuất, có cảnh báo trước 1 phút.
  // Trước đây trang ping 60 giây/lần vô điều kiện nên một tab bỏ quên giữ phiên sống mãi.
  const IDLE_MS = 15 * 60_000;
  let lastActive = Date.now();
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart']) {
    document.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true, capture: true });
  }
  if (s?.token) {
    setInterval(() => {
      const idle = Date.now() - lastActive;
      const note = document.getElementById('admin-idle');
      if (idle >= IDLE_MS) return logout('idle');
      if (note) {
        const left = Math.ceil((IDLE_MS - idle) / 1000);
        note.hidden = left > 60;
        if (left <= 60) note.textContent = `Tự đăng xuất sau ${left} giây`;
      }
    }, 1000);
    setInterval(() => {
      if (Date.now() - lastActive < 60_000) fetch('/api/login/activity', { method: 'POST', headers: auth() }).catch(() => {});
    }, 60000);
  }
})();
