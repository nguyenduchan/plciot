'use strict';
/**
 * Chat với quản trị viên: HAI KÊNH tách riêng để khỏi nhầm.
 *   - "Hỗ trợ kỹ thuật": chỉ hỏi kỹ thuật, dùng được ở mọi gói.
 *   - "Nâng cấp gói": xem chi tiết gói, bấm "Đồng ý nâng cấp" hoặc "Không nâng cấp", trao đổi với admin.
 * CHỈ văn bản thuần: hiển thị bằng textContent, không tự biến chữ thành link/nút. Không đơn hàng, không thanh toán:
 * "Đồng ý nâng cấp" chỉ gửi yêu cầu cho quản trị viên; gói chỉ đổi khi quản trị viên xác nhận trong chat.
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
  const input = $('#support-input');
  const badge = $('#support-badge');
  const logs = { support: $('#support-log'), upgrade: $('#upgrade-log') };
  const panes = { support: $('#ch-support'), upgrade: $('#ch-upgrade') };
  const CH_NAME = { support: 'Hỗ trợ kỹ thuật', upgrade: 'Nâng cấp gói' };
  let activeCh = 'support';
  let lastId = 0;
  let timer = null;
  const oldest = { support: 0, upgrade: 0 };
  const ERR = { empty_message: 'Hãy nhập nội dung.', rate_limited: 'Bạn gửi quá nhanh, thử lại sau.', duplicate: 'Tin này vừa được gửi rồi.', already_requested: 'Bạn đã đăng ký gói này rồi, đang chờ quản trị viên phản hồi.',
    already_on_plan: 'Bạn đang dùng gói này rồi.', quota_exceeded: 'Đã hết dung lượng ảnh cho tài khoản này.', busy: 'Hệ thống đang bận, thử lại sau.' };
  const newCid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36).padEnd(8, '0');
  const toast = (m) => (window.toast || alert)(m);

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
  function showReloadBanner() { $('#support-reload').hidden = false; }
  $('#support-reload-btn').addEventListener('click', () => location.reload());

  const chOf = (m) => (m.channel === 'upgrade' ? 'upgrade' : 'support');
  function rowOf(m) {
    const row = document.createElement('div');
    row.className = `sup-msg ${m.from}`;
    const who = document.createElement('small');
    who.textContent = `${m.from === 'admin' ? 'Quản trị viên' : 'Bạn'} · ${new Date(m.ts).toLocaleString('vi-VN')}`;
    const txt = document.createElement('div');
    txt.className = 'sup-text';
    txt.textContent = m.body;   // textContent: không hiểu HTML, không thành link
    row.append(who);
    if (m.image) { row.classList.add('has-img'); window.ChatImage?.attach(row, `${base}/api/support/images/${m.image}`, session.token); }
    if (m.body) row.append(txt);
    return row;
  }
  function addMessages(list, fromCache) {
    const touched = new Set();
    for (const m of list) {
      const ch = chOf(m);
      if (!fromCache && loadedOnce && m.from === 'admin' && m.id > lastId && /đã đồng ý và chuyển tài khoản/.test(m.body)) showReloadBanner();
      lastId = Math.max(lastId, m.id);
      if (!oldest[ch] || m.id < oldest[ch]) oldest[ch] = m.id;
      logs[ch].appendChild(rowOf(m));
      touched.add(ch);
    }
    for (const ch of touched) logs[ch].scrollTop = logs[ch].scrollHeight;
    if (list.length && !fromCache) cache.put(list).then(() => cache.trim());
  }

  /** Xem tin cũ hơn của KÊNH đang xem (kể cả kho lưu trữ trên máy chủ), chèn lên đầu khung. */
  const olderBtn = $('#support-older');
  olderBtn.addEventListener('click', async () => {
    olderBtn.disabled = true;
    const ch = activeCh;
    try {
      const { ok, data } = await call('GET', `/api/support/history?before=${oldest[ch] || ''}&limit=50&channel=${ch}`);
      if (ok) {
        const lg = logs[ch]; const h = lg.scrollHeight;
        for (const m of [...data.messages].reverse()) { lg.prepend(rowOf(m)); oldest[ch] = Math.min(oldest[ch] || m.id, m.id); }
        lg.scrollTop = lg.scrollHeight - h;
        olderBtn.hidden = !data.more;
      }
    } catch { /* offline */ } finally { olderBtn.disabled = false; }
  });

  async function refresh(markRead) {
    try {
      const { ok, data } = await call('GET', `/api/support/messages?after=${lastId}${markRead ? `&read=1&mark=${activeCh}` : ''}`);
      if (ok) { addMessages(data.messages || []); loadedOnce = true; olderBtn.hidden = !oldest[activeCh]; if (markRead) await pollUnread(); }
    } catch { /* offline */ }
  }

  let lastUnread = 0;
  let pendingReq = '';    // gói đã xin nâng cấp và đang chờ admin xử lý (lưu trong DB)
  let pendingDays = null;
  function setBadges(u) {
    const total = (u.support | 0) + (u.upgrade | 0);
    for (const ch of ['support', 'upgrade']) { const b = $(`#ch-badge-${ch}`); const n = ch === activeCh && det.open ? 0 : (u[ch] | 0); if (b) { b.hidden = !n; b.textContent = n ? `${n} mới` : ''; } }
    badge.hidden = !total; badge.textContent = total ? `${total} tin mới` : '';
    // Chấm báo trên nút 💬: người dùng không phải mở chat mới biết admin đã phản hồi
    const tabBtn = $('#chat-open');
    if (tabBtn) {
      let dot = tabBtn.querySelector('.sup-dot');
      if (total && !dot) { dot = document.createElement('i'); dot.className = 'sup-dot'; dot.setAttribute('aria-label', 'Có tin nhắn mới từ quản trị viên'); tabBtn.appendChild(dot); }
      if (!total && dot) dot.remove();
    }
    if (total && total > lastUnread) toast('Quản trị viên vừa trả lời bạn (nút 💬 trên đỉnh).');
    lastUnread = total;
  }
  async function pollUnread() {
    try {
      const { ok, data } = await call('GET', '/api/support/unread');
      if (ok) {
        setBadges({ support: data.unreadSupport | 0, upgrade: data.unreadUpgrade | 0 });
        pendingReq = data.pendingPlan || ''; pendingDays = data.pendingDays ?? null;
        renderUpgrade();
      }
    } catch { /* */ }
  }

  /* ---------- gửi tin: vào kênh đang xem ---------- */
  let pendingCid = {};
  async function send() {
    const body = input.value.trim();
    if (!body) return;
    $('#support-send').disabled = true;
    if (pendingCid.body !== body) pendingCid = { body, cid: newCid() };   // gửi lại cùng nội dung = cùng mã → máy chủ không tạo tin trùng
    try {
      const { ok, data } = await call('POST', '/api/support/messages', { body, cid: pendingCid.cid, channel: activeCh });
      if (ok) { input.value = ''; pendingCid = {}; await refresh(true); } else toast(ERR[data.error] || 'Không gửi được, thử lại sau.');
    } finally { $('#support-send').disabled = false; }
  }

  /* Ảnh đính kèm kiểu ứng dụng nhắn tin: chọn/dán ảnh → hiện ảnh nhỏ trong ô soạn (kèm ✕), con trỏ chuyển xuống ô nhập
     để gõ chú thích; bấm Gửi mới gửi ảnh cùng chú thích. Nút 📷 ẩn khi đang gõ hoặc đã chọn ảnh. */
  const chip = $('#support-chip');
  let staged = null;   // { blob, url }
  function syncComposer() {
    const has = Boolean(input.value.trim());
    $('#support-attach').hidden = has || Boolean(staged);
    if (staged && !chip.hasChildNodes()) {
      const img = document.createElement('img'); img.src = staged.url; img.alt = 'Ảnh đính kèm';
      const sm = document.createElement('small'); sm.textContent = 'Ảnh đính kèm';
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Bỏ ảnh'); x.className = 'fit';
      x.onclick = unstage;
      chip.append(img, sm, x);
    }
    chip.hidden = !staged;
  }
  function unstage() { if (staged) URL.revokeObjectURL(staged.url); staged = null; chip.textContent = ''; $('#support-file').value = ''; syncComposer(); }
  async function stageImage(file) {
    if (!file) return;
    try {
      const blob = await window.ChatImage.prepare(file);
      unstage();
      staged = { blob, url: URL.createObjectURL(blob) };
      syncComposer();
      input.placeholder = 'Thêm chú thích (tuỳ chọn)…';
      input.focus({ preventScroll: true });   // xuống ô nhập để gõ chú thích
    } catch { toast('Không đọc được ảnh này.'); }
  }
  async function sendImage() {
    if (!staged) return;
    const btn = $('#support-send'); btn.disabled = true;
    const blob = staged.blob;
    const caption = input.value.trim();
    // Hiện NGAY ảnh + chữ trong khung chat (đang gửi…); tin thật từ máy chủ thay thế khi gửi xong
    const pend = document.createElement('div'); pend.className = 'sup-msg user has-img pending';
    const pw = document.createElement('small'); pw.textContent = 'Bạn · đang gửi…'; pend.append(pw);
    const pobj = URL.createObjectURL(blob); window.ChatImage.preview(pend, pobj);
    if (caption) { const pt = document.createElement('div'); pt.className = 'sup-text'; pt.textContent = caption; pend.append(pt); }
    const lg = logs[activeCh]; lg.appendChild(pend); lg.scrollTop = lg.scrollHeight;
    try {
      const cid = newCid();
      const r = await fetch(`${base}/api/support/images?cid=${cid}&channel=${activeCh}${caption ? `&caption=${encodeURIComponent(caption)}` : ''}`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'image/jpeg' }, body: blob,
      });
      const data = await r.json().catch(() => ({}));
      pend.remove();
      if (r.ok) { input.value = ''; unstage(); input.style.height = 'auto'; input.placeholder = activeCh === 'upgrade' ? 'Trao đổi với quản trị viên về việc nâng cấp gói…' : 'Mô tả vấn đề kỹ thuật bạn gặp…'; await refresh(true); } else toast(data.error === 'rate_limited' ? 'Bạn gửi quá nhiều ảnh, thử lại sau.' : (ERR[data.error] || 'Không gửi được ảnh.'));
    } catch { pend.remove(); toast('Không gửi được ảnh.'); } finally { URL.revokeObjectURL(pobj); btn.disabled = false; syncComposer(); }
  }
  $('#support-attach').addEventListener('click', () => $('#support-file').click());
  $('#support-file').addEventListener('change', (e) => stageImage(e.target.files?.[0]));
  input.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => /^image\//.test(x.type));
    if (f) { e.preventDefault(); stageImage(f); }
  });
  // Ô soạn tự cao lên theo nội dung (tối đa ~6 dòng), như ứng dụng nhắn tin
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
  input.addEventListener('input', () => { grow(); syncComposer(); });
  // Gửi: có ảnh đính kèm thì gửi ảnh + chú thích, không thì gửi chữ
  const submit = () => (staged ? sendImage() : send()).then(() => { grow(); syncComposer(); });
  $('#support-send').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

  function startOpenPolling() { clearInterval(timer); timer = setInterval(() => refresh(true), 15000); }
  function stopOpenPolling() { clearInterval(timer); timer = null; }

  /* ---------- hai tab kênh ---------- */
  function setChannel(ch, { focus = false } = {}) {
    if (!panes[ch]) ch = 'support';
    activeCh = ch;
    try { localStorage.setItem('chatCh', ch); } catch { /* */ }
    document.querySelectorAll('.chat-tabs button').forEach((b) => { const on = b.dataset.ch === ch; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    for (const k of Object.keys(panes)) panes[k].hidden = k !== ch;
    if (!staged) input.placeholder = ch === 'upgrade' ? 'Trao đổi với quản trị viên về việc nâng cấp gói…' : 'Mô tả vấn đề kỹ thuật bạn gặp…';
    olderBtn.hidden = !oldest[ch];
    if (ch === 'upgrade') renderUpgrade();
    if (det.open) { refresh(true); setTimeout(() => { logs[ch].scrollTop = logs[ch].scrollHeight; if (focus) input.focus({ preventScroll: true }); }, 60); }
  }
  document.querySelector('.chat-tabs')?.addEventListener('click', (e) => { const b = e.target.closest('button[data-ch]'); if (b) setChannel(b.dataset.ch); });

  /* Chat là vùng riêng (#chat-view) mở bằng nút 💬 trên đỉnh, "Chat hỗ trợ" hoặc "Chat để nâng cấp". `det.open` giữ nguyên tên cũ cho các chỗ gọi. */
  const view = $('#chat-view');
  const det = {
    get open() { return !view.hidden; },
    set open(v) {
      v = Boolean(v);
      if (v === !view.hidden) return;
      view.hidden = !v;
      document.body.classList.toggle('chat-on', v);
      if (v) { fillPlans(); refresh(true); startOpenPolling(); setTimeout(() => { logs[activeCh].scrollTop = logs[activeCh].scrollHeight; }, 60); } else { stopOpenPolling(); pollUnread(); }
    },
  };
  $('#chat-open').hidden = false;
  $('#chat-open').addEventListener('click', async () => {
    if (det.open) { det.open = false; return; }
    // Mở kênh có tin mới; không có thì kênh dùng gần nhất
    let ch = 'support'; try { ch = localStorage.getItem('chatCh') || 'support'; } catch { /* */ }
    try { const { ok, data } = await call('GET', '/api/support/unread'); if (ok) { if (data.unreadUpgrade && !data.unreadSupport) ch = 'upgrade'; else if (data.unreadSupport && !data.unreadUpgrade) ch = 'support'; } } catch { /* */ }
    setChannel(ch); det.open = true;
  });
  $('#chat-close').addEventListener('click', () => { det.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && det.open) det.open = false; });

  /* ---------- Kênh Nâng cấp: chi tiết gói + "Đồng ý nâng cấp" / "Không nâng cấp" ----------
     Chọn gói ở mục Gói dịch vụ (chỉ đánh dấu ✓) → bấm "Chat để nâng cấp" → thẻ chi tiết hiện ở đây.
     Chỉ khi bấm "Đồng ý nâng cấp" mới có yêu cầu gửi đi; máy chủ tự soạn tin từ lựa chọn. Không tạo đơn, không thanh toán. */
  const planSel = $('#support-plan');
  const card = $('#upgrade-card');
  const vnd = (n) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

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
    renderUpgrade();
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

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n[k] = v; }
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  }
  const dl = (rows) => { const d = el('dl'); for (const [k, v] of rows) { if (v) { d.append(el('dt', { text: k }), el('dd', { text: v })); } } return d; };

  function renderUpgrade() {
    if (!card) return;
    const P = window.PlanUi;
    card.textContent = '';
    if (!P?.plans) return;
    const curLabel = P.currentLabel();
    const exp = P.expiresAt?.();
    const head = el('p', { class: 'muted', text: `Gói hiện tại: ${curLabel}${exp ? ` (đến hết ngày ${new Date(exp).toLocaleDateString('vi-VN')})` : ''}.` });

    // 1) Đã gửi yêu cầu, đang chờ quản trị viên
    if (pendingReq) {
      const t = P.plans.find((p) => p.id === pendingReq);
      card.append(head, el('h3', { text: `Đang chờ quản trị viên: gói ${t?.name || pendingReq}` }),
        el('p', { class: 'muted', text: `Bạn đã đồng ý nâng cấp${pendingDays ? ` (lưu lịch sử ${pendingDays} ngày)` : ''}. Quản trị viên sẽ xác nhận và trao đổi với bạn ngay trong kênh này. Gói của bạn chưa đổi cho tới khi quản trị viên xác nhận.` }));
      const row = el('div', { class: 'row' });
      const no = el('button', { type: 'button', class: 'fit', text: 'Rút lại yêu cầu' });
      no.onclick = () => respond('decline');
      row.append(no); card.append(row);
      return;
    }

    const id = planSel.value;
    const plan = id && P.plans.find((p) => p.id === id);

    // 2) Chưa chọn gói: chọn để xem chi tiết
    if (!plan) {
      card.append(head, el('p', { text: 'Chọn gói để xem chi tiết và giá tham khảo:' }));
      const pick = el('div', { class: 'upg-pick' });
      for (const p of P.plans) {
        if (p.id === P.current()) continue;
        const b = el('button', { type: 'button', class: 'fit', text: p.name });
        b.onclick = () => window.SupportChat.select(p.id);
        pick.append(b);
      }
      card.append(pick, el('p', { class: 'muted', text: 'Chỉ cần hỏi kỹ thuật? Sang tab “Hỗ trợ kỹ thuật”, không cần nâng cấp.' }));
      return;
    }

    // 3) Chi tiết gói đã chọn + Đồng ý / Không
    const paid = plan.id === 'monitor' || plan.id === 'pro';
    const { q, widgets, days } = P.priceOf?.(plan.id) || {};
    card.append(head, el('h3', { text: `Gói ${plan.name}` }));
    card.append(dl([
      ['Dành cho', plan.fit], ['Giám sát + điều khiển', 'có (mọi gói)'], ['Số widget', plan.widgets], ['Lịch sử', plan.retention],
      ['Widget của bạn', widgets != null ? `${widgets} widget` : ''],
    ]));
    if (paid && P.allowedDays) {
      const lab = el('label', { text: 'Thời gian lưu lịch sử ' });
      const sel = el('select');
      for (const d of P.allowedDays) { const o = el('option', { value: String(d), text: `${d} ngày` }); if (d === (P.selectedDays?.() || days)) o.selected = true; sel.append(o); }
      sel.onchange = () => P.setDays(Number(sel.value));
      lab.append(sel); card.append(lab);
    }
    let price = null; let canAccept = true;
    if (q) {
      if (!q.eligible) { price = el('div', { class: 'upg-price off', text: q.reason || 'Gói này chưa phù hợp với lựa chọn hiện tại.' }); canAccept = false; }
      else if (q.kind === 'free') price = el('div', { class: 'upg-price', text: 'Giá tham khảo: miễn phí.' });
      else if (q.kind === 'one_time') price = el('div', { class: 'upg-price', text: `Giá tham khảo: ${vnd(q.total)} trả một lần cho ${q.years} năm${q.equivalentPerMonth ? ` (≈ ${vnd(q.equivalentPerMonth)}/tháng)` : ''}.` });
      else price = el('div', { class: 'upg-price', text: `Giá tham khảo: ${vnd(q.total)}/tháng cho ${widgets} widget (${vnd(q.perWidget)}/widget${q.minMonth && q.total === q.minMonth ? `, mức tối thiểu ${vnd(q.minMonth)}/tháng` : ''}).` });
    }
    if (price) card.append(price);
    const d = downgradeInfo(plan.id);
    if (d) card.append(el('p', { class: 'muted', text: d.exp ? `Đây là hạ gói: gói “${curLabel}” vẫn được giữ đến hết ngày ${d.date}, sau đó tài khoản mới chuyển sang gói “${plan.name}”.` : `Gói “${curLabel}” hiện chưa có ngày hết hạn nên vẫn được giữ nguyên; quản trị viên sẽ xác nhận ngày chuyển sang gói “${plan.name}”.` }));
    card.append(el('p', { class: 'muted', text: 'Bấm “Đồng ý nâng cấp” chỉ gửi yêu cầu cho quản trị viên. Giá chỉ để tham khảo, chưa phải đơn đặt hàng, chưa tính tiền; gói chỉ đổi khi quản trị viên xác nhận trong chat.' }));
    const row = el('div', { class: 'row' });
    const yes = el('button', { type: 'button', class: 'primary fit upg-yes', text: d ? '✓ Đồng ý chuyển gói' : '✓ Đồng ý nâng cấp' });
    yes.disabled = !canAccept;
    yes.onclick = () => respond('accept');
    const no = el('button', { type: 'button', class: 'fit', text: '✕ Không nâng cấp' });
    no.onclick = () => respond('decline');
    row.append(yes, no); card.append(row);
  }

  async function respond(decision) {
    const P = window.PlanUi;
    const plan = planSel.value;
    const buttons = card.querySelectorAll('button'); buttons.forEach((b) => { b.disabled = true; });
    try {
      if (decision === 'decline') {
        if (pendingReq) {
          const { ok, data } = await call('POST', '/api/support/upgrade/respond', { decision: 'decline' });
          if (!ok) toast(ERR[data.error] || 'Không gửi được, thử lại sau.');
          else { pendingReq = ''; pendingDays = null; toast('Đã rút lại yêu cầu nâng cấp.'); }
        } else toast('Đã bỏ chọn gói. Gói của bạn không thay đổi.');
        resetPlanChoice(); await refresh(true); await pollUnread(); return;
      }
      if (!plan) return;
      const paid = plan === 'monitor' || plan === 'pro';
      const { ok, data } = await call('POST', '/api/support/upgrade/respond', { decision: 'accept', plan, days: paid ? P.selectedDays?.() : undefined, cid: newCid() });
      if (ok) { pendingReq = plan; pendingDays = paid ? P.selectedDays?.() : null; resetPlanChoice(); toast('Đã gửi yêu cầu nâng cấp cho quản trị viên.'); await refresh(true); await pollUnread(); }
      else { toast(ERR[data.error] || 'Không gửi được, thử lại sau.'); if (data.error === 'already_requested') { pendingReq = data.plan; resetPlanChoice(); } }
    } finally { renderUpgrade(); }
  }

  let pickedPlan = '';
  /** Đánh dấu ✓ trên thẻ gói đang được chọn trong bảng Gói dịch vụ (đồng bộ với gói đang xem chi tiết). */
  function markSelected(id) {
    document.querySelectorAll('#plan-table .plan-row').forEach((r) => {
      const on = Boolean(id) && r.dataset.plan === id;
      r.classList.toggle('sel', on);
      r.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  window.addEventListener('plan-table-rendered', () => markSelected(planSel.value));
  window.addEventListener('plan-prices', renderUpgrade);
  function resetPlanChoice() { planSel.value = ''; pickedPlan = ''; markSelected(''); renderUpgrade(); }
  planSel.addEventListener('change', () => { pickedPlan = planSel.value; markSelected(planSel.value); renderUpgrade(); });

  window.SupportChat = {
    /** "Chat để nâng cấp": mở kênh Nâng cấp, hiện chi tiết gói đã chọn (hoặc danh sách gói để chọn). */
    open() {
      fillPlans();
      setChannel('upgrade');
      det.open = true;
      requestAnimationFrame(() => setTimeout(() => {
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        card.classList.remove('sup-flash'); void card.offsetWidth; card.classList.add('sup-flash');
      }, 120));
    },
    /** "Chat hỗ trợ": mở kênh Hỗ trợ kỹ thuật, không liên quan gói. */
    support() {
      fillPlans();
      setChannel('support');
      det.open = true;
      setTimeout(() => input.focus({ preventScroll: true }), 100);
    },
    /** Chỉ ĐÁNH DẤU gói được chọn (✓), KHÔNG mở chat. Chọn lại gói đang chọn = bỏ chọn. */
    select(planId) {
      fillPlans();
      if (planSel.value === planId) { resetPlanChoice(); return; }
      if (![...planSel.options].some((o) => o.value === planId && !o.disabled)) return;
      planSel.value = planId;
      planSel.dispatchEvent(new Event('change'));
    },
    fillPlans,
    /** Chọn sẵn một gói rồi mở kênh Nâng cấp (giữ cho chỗ gọi cũ). */
    choose(planId) { this.select(planId); if (planSel.value === planId) this.open(); },
  };
  document.addEventListener('DOMContentLoaded', fillPlans);

  // Kênh dùng lần trước; hiện ngay tin đã lưu trên máy, rồi hỏi máy chủ phần mới hơn
  try { const c = localStorage.getItem('chatCh'); if (c && panes[c]) activeCh = c; } catch { /* */ }
  setChannel(activeCh);
  cache.all().then((list) => {
    if (list?.length && !lastId) addMessages(list.sort((a, b) => a.id - b.id), true);
  }).finally(() => refresh(false));
  pollUnread();
  setInterval(() => { if (!det.open) pollUnread(); }, 60000);
})();
