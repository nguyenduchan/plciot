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
  // Đã đăng xuất: xoá bộ nhớ đệm chat trên máy (máy dùng chung không để lộ nội dung)
  if (!session?.token) { try { indexedDB.databases?.().then((l) => (l || []).forEach((d) => /^plciot-chat-/.test(d.name) && indexedDB.deleteDatabase(d.name))); } catch {} }
  if (!panel || !session?.token || session.demo) return;
  panel.hidden = false;

  const base = session.apiBase || location.origin;
  const log = $('#support-log');
  const input = $('#support-input');
  const badge = $('#support-badge');
  let lastId = 0;
  let timer = null;
  const ERR = { empty_message: 'Hãy nhập nội dung.', rate_limited: 'Bạn gửi quá nhanh, thử lại sau.', duplicate: 'Tin này vừa được gửi rồi.', already_requested: 'Bạn đã đăng ký tư vấn gói này rồi, đang chờ quản trị viên phản hồi.',
    quota_exceeded: 'Đã hết dung lượng ảnh cho tài khoản này.', busy: 'Hệ thống đang bận, thử lại sau.' };
  const newCid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36).padEnd(8, '0');

  /* Bộ nhớ đệm trên máy (IndexedDB, theo từng tài khoản). Máy chủ vẫn là nguồn sự thật: chỉ để mở nhanh và xem được khi mất mạng. */
  const CACHE_MAX = 200;
  const cache = (() => {
    // Khoá theo id người dùng trong token: không có thì tắt bộ nhớ đệm (không bao giờ trộn nội dung giữa các tài khoản)
    let uid = null;
    try { const p = JSON.parse(atob(session.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); uid = p.sub ?? p.id ?? p.uid ?? null; } catch { /* */ }
    const name = `plciot-chat-${uid}`;
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((resolve) => {
      if (uid == null) return resolve(null);
      try {
        const rq = indexedDB.open(name, 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('m', { keyPath: 'id' });
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => resolve(null);
      } catch { resolve(null); }
    }));
    const tx = async (mode, fn) => { const d = await open(); if (!d) return null; return new Promise((res) => { try { const t = d.transaction('m', mode); const r = fn(t.objectStore('m')); t.oncomplete = () => res(r?.result ?? null); t.onerror = () => res(null); } catch { res(null); } }); };
    return {
      all: () => tx('readonly', (st) => st.getAll()),
      put: (list) => tx('readwrite', (st) => { list.forEach((m) => st.put(m)); }),
      async trim() { const a = await this.all(); if (a && a.length > CACHE_MAX) { const del = a.sort((x, y) => x.id - y.id).slice(0, a.length - CACHE_MAX); await tx('readwrite', (st) => { del.forEach((m) => st.delete(m.id)); }); } },
    };
  })();

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

  function rowOf(m) {
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
    return row;
  }
  let oldestId = 0;
  function addMessages(list, fromCache) {
    for (const m of list) {
      if (!fromCache && loadedOnce && m.from === 'admin' && m.id > lastId && /đã đồng ý và chuyển tài khoản/.test(m.body)) showReloadBanner();
      lastId = Math.max(lastId, m.id);
      if (!oldestId || m.id < oldestId) oldestId = m.id;
      log.appendChild(rowOf(m));
    }
    if (list.length) { log.scrollTop = log.scrollHeight; if (!fromCache) { cache.put(list).then(() => cache.trim()); } }
  }

  /** Xem tin cũ hơn (kể cả kho lưu trữ trên máy chủ), chèn lên đầu khung. */
  const olderBtn = $('#support-older');
  olderBtn.addEventListener('click', async () => {
    olderBtn.disabled = true;
    try {
      const { ok, data } = await call('GET', `/api/support/history?before=${oldestId || ''}&limit=50`);
      if (ok) {
        const h = log.scrollHeight;
        for (const m of [...data.messages].reverse()) { log.prepend(rowOf(m)); oldestId = Math.min(oldestId || m.id, m.id); }
        log.scrollTop = log.scrollHeight - h;
        olderBtn.hidden = !data.more;
      }
    } catch { /* offline */ } finally { olderBtn.disabled = false; }
  });

  async function refresh(markRead) {
    try {
      const { ok, data } = await call('GET', `/api/support/messages?after=${lastId}${markRead ? '&read=1' : ''}`);
      if (ok) { addMessages(data.messages || []); loadedOnce = true; olderBtn.hidden = !oldestId; if (markRead) setBadge(0); }
    } catch { /* offline */ }
  }

  function setBadge(n) {
    badge.hidden = !n;
    badge.textContent = n ? `${n} tin mới` : '';
    // Chấm báo trên tab Cài đặt: người dùng không phải mở Cài đặt mới biết admin đã phản hồi
    const tabBtn = document.querySelector('#chat-open');
    if (tabBtn) {
      let dot = tabBtn.querySelector('.sup-dot');
      if (n && !dot) { dot = document.createElement('i'); dot.className = 'sup-dot'; dot.setAttribute('aria-label', 'Có tin nhắn mới từ quản trị viên'); tabBtn.appendChild(dot); }
      if (!n && dot) dot.remove();
    }
    if (n && n > lastUnread) (window.toast || (() => {}))('Quản trị viên vừa trả lời bạn (nút 💬 trên đỉnh).');
    lastUnread = n;
  }
  let lastUnread = 0;
  let pendingReq = '';   // gói đã xin tư vấn và đang chờ admin xử lý (lưu trong DB)

  async function pollUnread() {
    try {
      const { ok, data } = await call('GET', '/api/support/unread');
      if (ok) { setBadge(data.unread | 0); pendingReq = data.pendingPlan || ''; }
    } catch { /* */ }
  }

  let pendingCid = {};
  async function send() {
    const body = input.value.trim();
    if (!body) return;
    $('#support-send').disabled = true;
    if (pendingCid.body !== body) pendingCid = { body, cid: newCid() };   // gửi lại cùng nội dung = cùng mã → máy chủ không tạo tin trùng
    try {
      const { ok, data } = await call('POST', '/api/support/messages', { body, cid: pendingCid.cid });
      if (ok) { input.value = ''; pendingCid = {}; await refresh(true); } else (window.toast || alert)(ERR[data.error] || 'Không gửi được, thử lại sau.');
    } finally { $('#support-send').disabled = false; }
  }

  /** Gửi ảnh chụp màn hình (chọn tệp hoặc dán). Nội dung ô nhập, nếu có, đi kèm làm chú thích. */
  async function sendImage(file) {
    if (!file) return;
    const btn = $('#support-attach'); btn.disabled = true;
    try {
      const blob = await window.ChatImage.prepare(file);
      const caption = input.value.trim();
      const cid = newCid();
      const r = await fetch(`${base}/api/support/images?cid=${cid}${caption ? `&caption=${encodeURIComponent(caption)}` : ''}`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'image/jpeg' }, body: blob,
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) { input.value = ''; await refresh(true); } else (window.toast || alert)(data.error === 'rate_limited' ? 'Bạn gửi quá nhiều ảnh, thử lại sau.' : (ERR[data.error] || 'Không gửi được ảnh.'));
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

  /* Chat là vùng riêng (#chat-view) mở bằng nút 💬 trên đỉnh hoặc "Chat để nâng cấp". `det.open` giữ nguyên tên cũ cho các chỗ gọi. */
  const view = $('#chat-view');
  const det = {
    get open() { return !view.hidden; },
    set open(v) {
      v = Boolean(v);
      if (v === !view.hidden) return;
      view.hidden = !v;
      document.body.classList.toggle('chat-on', v);
      if (v) { fillPlans(); refresh(true); startOpenPolling(); setTimeout(() => { log.scrollTop = log.scrollHeight; }, 60); } else stopOpenPolling();
    },
  };
  $('#chat-open').hidden = false;
  $('#chat-open').addEventListener('click', () => { det.open = !det.open; });
  $('#chat-close').addEventListener('click', () => { det.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && det.open) det.open = false; });

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
    const who = `Tài khoản: ${P.username() || session.username || '(tên đăng nhập)'}, gói hiện tại: ${P.currentLabel()}.`;
    const d = downgradeInfo(planId);
    if (d) return `Tôi muốn chuyển xuống gói "${target.name}" khi gói hiện tại hết hạn${d.exp ? ` (${d.date})` : ''}. ${who}`;
    return `Tôi muốn được tư vấn chuyển sang gói "${target.name}". ${who}`;
  }

  /** Chọn gói thấp hơn gói đang dùng = hạ gói: vẫn giữ gói cũ đến hết hạn rồi mới chuyển. null nếu không phải hạ gói. */
  function downgradeInfo(planId) {
    const P = window.PlanUi;
    const ids = (P?.plans || []).map((p) => p.id);
    const cur = P?.current?.();
    if (!ids.includes(planId) || !ids.includes(cur) || ids.indexOf(planId) >= ids.indexOf(cur)) return null;
    const exp = P.expiresAt?.() || null;
    return { exp, date: exp ? new Date(exp).toLocaleDateString('vi-VN') : '' };
  }

  /** Nội dung bước xem lại: hạ gói thì nói rõ gói cũ giữ tới ngày nào và khi nào chuyển. */
  function planPreview(planId) {
    const P = window.PlanUi;
    const target = P?.plans?.find((p) => p.id === planId)?.name || planId;
    const cur = P?.currentLabel?.() || '';
    const d = downgradeInfo(planId);
    if (!d) return `Sẽ gửi cho quản trị viên: “${planRequestText(planId)}”`;
    return d.exp
      ? `Bạn đang dùng gói “${cur}” đến hết ngày ${d.date}. Gói này vẫn được giữ nguyên đến hết hạn; sau ngày đó tài khoản mới chuyển sang gói “${target}”. Gửi yêu cầu để quản trị viên xác nhận.`
      : `Gói “${cur}” của bạn hiện chưa có ngày hết hạn nên vẫn được giữ nguyên. Quản trị viên sẽ xác nhận với bạn ngày chuyển sang gói “${target}”.`;
  }

  let pendingPlan = '';
  /** Đánh dấu ✓ trên thẻ gói đang được chọn trong bảng Gói dịch vụ (đồng bộ với ô chọn gói). */
  function markSelected(id) {
    document.querySelectorAll('#plan-table .plan-row').forEach((r) => {
      const on = Boolean(id) && r.dataset.plan === id;
      r.classList.toggle('sel', on);
      r.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  window.addEventListener('plan-table-rendered', () => markSelected(planSel.value));
  function resetPlanChoice() { planSel.value = ''; pendingText = ''; pendingPlan = ''; planBox.hidden = true; markSelected(''); }

  planSel.addEventListener('change', () => {
    pendingPlan = planSel.value;
    pendingText = planRequestText(planSel.value);
    $('#support-plan-preview').textContent = pendingText ? planPreview(planSel.value) : '';
    $('#support-plan-send').textContent = downgradeInfo(planSel.value) ? 'Gửi yêu cầu hạ gói' : 'Gửi yêu cầu tư vấn';
    planBox.hidden = !pendingText;
    // Gói này đã đăng ký tư vấn rồi (đang chờ admin): báo ngay, không cho gửi trùng
    const dupe = Boolean(pendingText) && planSel.value === pendingReq;
    $('#support-plan-send').hidden = dupe;
    if (dupe) {
      $('#support-plan-preview').textContent = `Bạn đã đăng ký tư vấn gói “${window.PlanUi?.plans?.find((p) => p.id === pendingReq)?.name || pendingReq}” rồi. Yêu cầu đang chờ quản trị viên xử lý, bạn không cần gửi lại.`;
      (window.toast || (() => {}))('Bạn đã đăng ký gói này rồi, đang chờ quản trị viên.');
    }
    markSelected(pendingText ? planSel.value : '');
  });
  $('#support-plan-cancel').addEventListener('click', resetPlanChoice);
  $('#support-plan-send').addEventListener('click', async () => {
    const body = pendingText;
    if (!body) return;
    $('#support-plan-send').disabled = true;
    try {
      const { ok, data } = await call('POST', '/api/support/messages', { body, plan: pendingPlan, cid: newCid() });
      if (ok) { resetPlanChoice(); pendingReq = pendingPlan || pendingReq; await refresh(true); pollUnread(); } else { (window.toast || alert)(ERR[data.error] || 'Không gửi được, thử lại sau.'); if (data.error === 'already_requested') { pendingReq = data.plan; resetPlanChoice(); } }
    } finally { $('#support-plan-send').disabled = false; }
  });

  /** Mở khung chat + bộ chọn gói (từ mục Gói dịch vụ). Không tự gửi gì. */
  window.SupportChat = {
    open() {
      det.open = true;
      fillPlans();
      setTimeout(() => $('#support-input').focus({ preventScroll: true }), 100);
    },
    fillPlans,
    /** Chọn sẵn một gói (từ thẻ gói trong Gói dịch vụ): mở khung chat, hiện bước xem lại. Không tự gửi. */
    choose(planId) {
      det.open = true;
      fillPlans();
      if (![...planSel.options].some((o) => o.value === planId && !o.disabled)) return;
      planSel.value = planId;
      planSel.dispatchEvent(new Event('change'));
      // Cuộn xuống bước xem lại + nút "Gửi yêu cầu tư vấn" (đợi khung chat mở xong rồi mới cuộn, nếu không trên điện thoại cuộn bị lệch)
      requestAnimationFrame(() => setTimeout(() => {
        planBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        planBox.classList.remove('sup-flash'); void planBox.offsetWidth; planBox.classList.add('sup-flash');
      }, 120));
    },
  };
  document.addEventListener('DOMContentLoaded', fillPlans);

  // Hiện ngay tin đã lưu trên máy, rồi hỏi máy chủ phần mới hơn
  cache.all().then((list) => {
    if (list?.length && !lastId) addMessages(list.sort((a, b) => a.id - b.id), true);
  }).finally(() => refresh(false));
  pollUnread();
  setInterval(() => { if (!det.open) pollUnread(); }, 60000);
})();
