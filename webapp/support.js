'use strict';
/**
 * Chat hỗ trợ với quản trị viên (Cài đặt → Hỗ trợ & nâng cấp gói).
 * CHỈ văn bản thuần: hiển thị bằng textContent, không tự biến chữ thành link/nút, không đơn hàng, không thanh toán.
 * Xem docs/CHAT-COMPLIANCE.md trước khi thêm tính năng cho khung chat này.
 */
(function () {
  const $ = (s) => document.querySelector(s);
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch {}
  const panel = $('#support-panel');
  if (!panel || !session?.token || session.demo) return;
  panel.hidden = false;

  const base = session.apiBase || location.origin;
  const log = $('#support-log');
  const input = $('#support-input');
  const badge = $('#support-badge');
  let lastId = 0;
  let timer = null;
  const ERR = { empty_message: 'Hãy nhập nội dung.', rate_limited: 'Bạn gửi quá nhanh, thử lại sau.' };

  async function call(method, path, body) {
    const r = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, data };
  }

  let loadedOnce = false;
  /** Admin vừa đồng ý đổi gói: mời người dùng tải lại để dùng gói mới ngay (không cần đăng nhập lại). */
  function showReloadBanner() {
    const b = $('#support-reload');
    b.hidden = false;
  }
  $('#support-reload-btn').addEventListener('click', () => location.reload());

  function addMessages(list) {
    for (const m of list) {
      if (loadedOnce && m.from === 'admin' && m.id > lastId && /đã đồng ý và chuyển tài khoản/.test(m.body)) showReloadBanner();
      lastId = Math.max(lastId, m.id);
      const row = document.createElement('div');
      row.className = `sup-msg ${m.from}`;
      const who = document.createElement('small');
      who.textContent = `${m.from === 'admin' ? 'Quản trị viên' : 'Bạn'} · ${new Date(m.ts).toLocaleString('vi-VN')}`;
      const txt = document.createElement('div');
      txt.className = 'sup-text';
      txt.textContent = m.body;   // textContent: không hiểu HTML, không thành link
      row.append(who);
      if (m.image) window.ChatImage?.attach(row, `${base}/api/support/images/${m.image}`, session.token);
      if (m.body) row.append(txt);
      log.appendChild(row);
    }
    if (list.length) log.scrollTop = log.scrollHeight;
  }

  async function refresh(markRead) {
    try {
      const { ok, data } = await call('GET', `/api/support/messages?after=${lastId}${markRead ? '&read=1' : ''}`);
      if (ok) { addMessages(data.messages || []); loadedOnce = true; if (markRead) setBadge(0); }
    } catch { /* offline */ }
  }

  function setBadge(n) {
    badge.hidden = !n;
    badge.textContent = n ? `${n} tin mới` : '';
    // Chấm báo trên tab Cài đặt: người dùng không phải mở Cài đặt mới biết admin đã phản hồi
    const tabBtn = document.querySelector('nav button[data-tab="set"]');
    if (tabBtn) {
      let dot = tabBtn.querySelector('.sup-dot');
      if (n && !dot) { dot = document.createElement('i'); dot.className = 'sup-dot'; dot.setAttribute('aria-label', 'Có tin nhắn mới từ quản trị viên'); tabBtn.appendChild(dot); }
      if (!n && dot) dot.remove();
    }
    if (n && n > lastUnread) (window.toast || (() => {}))('Quản trị viên vừa trả lời bạn (Cài đặt → Hỗ trợ).');
    lastUnread = n;
  }
  let lastUnread = 0;

  async function pollUnread() {
    try {
      const { ok, data } = await call('GET', '/api/support/unread');
      if (ok) setBadge(data.unread | 0);
    } catch { /* */ }
  }

  async function send() {
    const body = input.value.trim();
    if (!body) return;
    $('#support-send').disabled = true;
    try {
      const { ok, data } = await call('POST', '/api/support/messages', { body });
      if (ok) { input.value = ''; await refresh(true); } else (window.toast || alert)(ERR[data.error] || 'Không gửi được, thử lại sau.');
    } finally { $('#support-send').disabled = false; }
  }

  /** Gửi ảnh chụp màn hình (chọn tệp hoặc dán). Nội dung ô nhập, nếu có, đi kèm làm chú thích. */
  async function sendImage(file) {
    if (!file) return;
    const btn = $('#support-attach'); btn.disabled = true;
    try {
      const blob = await window.ChatImage.prepare(file);
      const caption = input.value.trim();
      const r = await fetch(`${base}/api/support/images${caption ? `?caption=${encodeURIComponent(caption)}` : ''}`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'image/jpeg' }, body: blob,
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) { input.value = ''; await refresh(true); } else (window.toast || alert)(data.error === 'rate_limited' ? 'Bạn gửi quá nhiều ảnh, thử lại sau.' : 'Không gửi được ảnh.');
    } catch { (window.toast || alert)('Không đọc được ảnh này.'); } finally { btn.disabled = false; $('#support-file').value = ''; }
  }
  $('#support-attach').addEventListener('click', () => $('#support-file').click());
  $('#support-file').addEventListener('change', (e) => sendImage(e.target.files?.[0]));
  input.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => /^image\//.test(x.type));
    if (f) { e.preventDefault(); sendImage(f); }
  });

  function startOpenPolling() { clearInterval(timer); timer = setInterval(() => refresh(true), 15000); }
  function stopOpenPolling() { clearInterval(timer); timer = null; }

  $('#support-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  panel.addEventListener('toggle', () => {}, true);

  const det = $('#support-details');
  det.addEventListener('toggle', () => {
    if (det.open) { refresh(true); startOpenPolling(); } else stopOpenPolling();
  });

  /* ---------- Xin tư vấn nâng cấp gói: chọn gói → xem lại nội dung → "Gửi yêu cầu tư vấn" hoặc "Hủy" ----------
     Chỉ khi bấm "Gửi yêu cầu tư vấn" mới có tin nhắn được gửi. Không tạo đơn, không thanh toán, không giá. */
  const planSel = $('#support-plan');
  const planBox = $('#support-plan-confirm');
  let pendingText = '';

  function fillPlans() {
    const P = window.PlanUi;
    if (!P?.plans) return;
    const cur = P.current();
    const keep = planSel.value;
    planSel.length = 1;
    for (const p of P.plans) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.id === cur ? ' (đang dùng)' : '');
      o.disabled = p.id === cur;
      planSel.appendChild(o);
    }
    if ([...planSel.options].some((o) => o.value === keep && !o.disabled)) planSel.value = keep;
  }

  function planRequestText(planId) {
    const P = window.PlanUi;
    const target = P?.plans?.find((p) => p.id === planId);
    if (!target) return '';
    return `Tôi muốn được tư vấn chuyển sang gói "${target.name}". Tài khoản: ${P.username() || session.username || '(tên đăng nhập)'}, gói hiện tại: ${P.currentLabel()}.`;
  }

  let pendingPlan = '';
  function resetPlanChoice() { planSel.value = ''; pendingText = ''; pendingPlan = ''; planBox.hidden = true; }

  planSel.addEventListener('change', () => {
    pendingPlan = planSel.value;
    pendingText = planRequestText(planSel.value);
    $('#support-plan-preview').textContent = pendingText ? `Sẽ gửi cho quản trị viên: “${pendingText}”` : '';
    planBox.hidden = !pendingText;
  });
  $('#support-plan-cancel').addEventListener('click', resetPlanChoice);
  $('#support-plan-send').addEventListener('click', async () => {
    const body = pendingText;
    if (!body) return;
    $('#support-plan-send').disabled = true;
    try {
      const { ok, data } = await call('POST', '/api/support/messages', { body, plan: pendingPlan });
      if (ok) { resetPlanChoice(); await refresh(true); } else (window.toast || alert)(ERR[data.error] || 'Không gửi được, thử lại sau.');
    } finally { $('#support-plan-send').disabled = false; }
  });

  /** Mở khung chat + bộ chọn gói (từ mục Gói dịch vụ). Không tự gửi gì. */
  window.SupportChat = {
    open() {
      det.open = true;
      fillPlans();
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      planSel.focus();
    },
    fillPlans,
  };
  det.addEventListener('toggle', () => { if (det.open) fillPlans(); });
  document.addEventListener('DOMContentLoaded', fillPlans);

  refresh(false);
  pollUnread();
  setInterval(() => { if (!det.open) pollUnread(); }, 60000);
})();
