'use strict';
/* Hộp thư hỗ trợ của admin. Chỉ văn bản thuần (textContent). Mẫu tin nhắn chỉ điền sẵn vào ô soạn — không tự gửi,
   không sinh mã đơn/QR/số tiền. Xem docs/CHAT-COMPLIANCE.md. */
(function () {
  const $ = (s) => document.querySelector(s);
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch {}
  if (!session?.token) { location.replace('admin-login.html'); return; }

  // Mẫu gõ sẵn: chữ <...> là chỗ admin tự điền. KHÔNG chèn số tài khoản/số tiền tự động.
  const TEMPLATES = [
    ['Chào và hỏi nhu cầu', 'Xin chào, mình là quản trị viên hệ thống. Bạn cần nâng cấp gói để dùng thêm tính năng nào (số widget, lưu dữ liệu lâu hơn…)? Bạn cho mình biết nhu cầu để mình tư vấn nhé.'],
    ['Hướng dẫn chuyển khoản thủ công', 'Bạn vui lòng tự mở ứng dụng ngân hàng của mình và chuyển khoản theo thông tin sau:\n- Ngân hàng: <tên ngân hàng>\n- Số tài khoản: <số tài khoản>\n- Chủ tài khoản: <tên chủ tài khoản>\n- Số tiền: <số tiền đã thỏa thuận>\n- Nội dung chuyển khoản: <tên đăng nhập của bạn> + <tên gói> (chỉ cần tên đăng nhập và gói, không cần họ tên hay số điện thoại)\nChuyển xong bạn nhắn lại ở đây (ngày giờ, số tiền) để mình đối soát và nâng gói cho tài khoản.'],
    ['Đã nhận tiền, đã nâng gói', 'Mình đã nhận được khoản chuyển khoản và đã nâng gói <tên gói> cho tài khoản của bạn. Bạn tải lại ứng dụng là dùng được ngay, không cần đăng nhập lại. Cảm ơn bạn!'],
    ['Hóa đơn (chỉ khi người mua yêu cầu)', 'Nếu bạn cần hóa đơn, hãy nhắn giúp mình thông tin xuất hóa đơn mà bạn muốn ghi (tên người/đơn vị mua, mã số thuế nếu có). Nếu không cần thì bạn không phải cung cấp thêm gì ngoài tên đăng nhập.'],
    ['Chưa thấy tiền về', 'Hiện mình chưa thấy khoản chuyển khoản của bạn trong tài khoản. Bạn kiểm tra lại giúp mình ngày giờ, số tiền và nội dung chuyển khoản nhé.'],
  ];

  const ERR = { empty_message: 'Hãy nhập nội dung.', user_not_found: 'Không tìm thấy người dùng.', rate_limited: 'Gửi quá nhanh, chờ một chút.',
    admin_session_required: 'Đăng nhập lại.', unauthorized: 'Phiên hết hạn, đăng nhập lại.', session_revoked: 'Phiên đã bị thu hồi, đăng nhập lại.' };
  const msg = (t, bad) => { const m = $('#msg'); m.textContent = t || ''; m.className = bad ? 'err' : ''; };
  const when = (t) => new Date(t).toLocaleString('vi-VN');
  let current = null; let lastId = 0; let timer = null;

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

  const tpl = $('#tpl');
  TEMPLATES.forEach(([t], i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = t; tpl.appendChild(o); });
  tpl.addEventListener('change', () => {
    if (tpl.value === '') return;
    $('#input').value = TEMPLATES[Number(tpl.value)][1];
    tpl.value = ''; $('#input').focus();
  });

  function addMessages(list) {
    const log = $('#log');
    for (const m of list) {
      lastId = Math.max(lastId, m.id);
      const row = document.createElement('div'); row.className = `sup-msg ${m.from}`;
      const who = document.createElement('small'); who.textContent = `${m.from === 'admin' ? 'Quản trị viên' : (current?.username || 'Người dùng')} · ${when(m.ts)}`;
      const txt = document.createElement('div'); txt.className = 'sup-text'; txt.textContent = m.body;
      row.append(who);
      if (m.image) window.ChatImage.attach(row, `/api/admin/support/images/${m.image}`, session.token);
      if (m.body) row.append(txt);
      log.appendChild(row);
    }
    if (list.length) log.scrollTop = log.scrollHeight;
  }

  async function loadThreads() {
    const j = await api('/api/admin/support/threads');
    const box = $('#threads'); box.textContent = '';
    if (!j.threads.length) { box.textContent = 'Chưa có cuộc trò chuyện.'; box.className = 'help'; return j; }
    box.className = '';
    for (const t of j.threads) {
      const el = document.createElement('div'); el.className = `th${current?.userId === t.userId ? ' on' : ''}`;
      const b = document.createElement('b'); b.textContent = t.username;
      if (t.plan) { const p = document.createElement('span'); p.className = 'tag'; p.textContent = t.plan; b.append(' ', p); }
      if (t.unread) { const n = document.createElement('span'); n.className = 'tag new'; n.textContent = `${t.unread} mới`; b.append(' ', n); }
      const s = document.createElement('small'); s.textContent = `${t.lastFromAdmin ? 'Bạn: ' : ''}${t.lastBody}`;
      el.append(b, s); el.addEventListener('click', () => open(t.userId, t.username)); box.appendChild(el);
    }
    return j;
  }

  async function open(userId, username) {
    current = { userId, username }; lastId = 0; $('#log').textContent = '';
    $('#who').textContent = `Trò chuyện với ${username}`;
    $('#input').disabled = false; $('#send').disabled = false;
    await poll(true);
    clearInterval(timer); timer = setInterval(() => { poll(false); }, 10000);
    loadThreads().catch(() => {});
  }

  async function poll(first) {
    if (!current) return;
    try {
      const j = await api(`/api/admin/support/threads/${current.userId}?after=${lastId}`);
      if (first) { const pl = $('#plan-line'); pl.textContent = j.plan ? `Gói hiện tại: ${j.plan}` : ''; pl.classList.toggle('hidden', !j.plan); }
      addMessages(j.messages);
    } catch (e) { msg(e.message, true); }
  }

  $('#send').addEventListener('click', async () => {
    const body = $('#input').value.trim();
    if (!current || !body) return;
    msg(''); $('#send').disabled = true;
    try { await api(`/api/admin/support/threads/${current.userId}`, 'POST', { body }); $('#input').value = ''; await poll(false); loadThreads().catch(() => {}); }
    catch (e) { msg(e.message, true); } finally { $('#send').disabled = false; }
  });

  async function sendImage(file) {
    if (!current || !file) return;
    msg(''); $('#attach').disabled = true;
    try {
      const blob = await window.ChatImage.prepare(file);
      const caption = $('#input').value.trim();
      const r = await fetch(`/api/admin/support/threads/${current.userId}/image${caption ? `?caption=${encodeURIComponent(caption)}` : ''}`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'image/jpeg' }, body: blob,
      });
      if (!r.ok) throw new Error('Không gửi được ảnh.');
      $('#input').value = ''; await poll(false); loadThreads().catch(() => {});
    } catch (e) { msg(e.message || 'Không đọc được ảnh này.', true); } finally { $('#attach').disabled = false; $('#file').value = ''; }
  }
  $('#attach').addEventListener('click', () => { if (current) $('#file').click(); });
  $('#file').addEventListener('change', (e) => sendImage(e.target.files?.[0]));
  $('#input').addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => /^image\//.test(x.type));
    if (f) { e.preventDefault(); sendImage(f); }
  });

  let ft = null;
  $('#find').addEventListener('input', () => {
    clearTimeout(ft);
    ft = setTimeout(async () => {
      const q = $('#find').value.trim(); const box = $('#found'); box.textContent = '';
      if (q.length < 2) return;
      try {
        const j = await api(`/api/admin/support/users?q=${encodeURIComponent(q)}`);
        for (const u of j.users) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'fit'; b.textContent = u.username;
          b.addEventListener('click', () => { box.textContent = ''; $('#find').value = ''; open(u.userId, u.username); }); box.appendChild(b);
        }
      } catch (e) { msg(e.message, true); }
    }, 300);
  });

  loadThreads().catch((e) => msg(e.message, true));
  setInterval(() => loadThreads().catch(() => {}), 30000);
})();
