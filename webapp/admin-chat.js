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
    ['Hỗ trợ kỹ thuật: xin thông tin', 'Để kiểm tra giúp bạn, bạn cho mình biết: (1) tên gateway/thiết bị gặp lỗi, (2) lỗi xảy ra lúc mấy giờ, (3) bạn chụp màn hình lỗi và gửi ảnh (nút 📷) ở đây nhé.'],
    ['Chưa thấy tiền về', 'Hiện mình chưa thấy khoản chuyển khoản của bạn trong tài khoản. Bạn kiểm tra lại giúp mình ngày giờ, số tiền và nội dung chuyển khoản nhé.'],
  ];

  const ERR = { empty_message: 'Hãy nhập nội dung.', user_not_found: 'Không tìm thấy người dùng.', rate_limited: 'Gửi quá nhanh, chờ một chút.', no_expiry: 'Gói hiện tại không có ngày hết hạn: tick "Đổi ngay" nếu muốn hạ gói luôn.', quota_exceeded: 'Vượt hạn mức dung lượng.', busy: 'Hệ thống đang quá tải, thử lại sau.',
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

  function rowOf(m) {
    const row = document.createElement('div'); row.className = `sup-msg ${m.from}`; row.dataset.id = m.id;
    const who = document.createElement('small'); who.textContent = `${m.from === 'admin' ? 'Quản trị viên' : (current?.username || 'Người dùng')} · ${when(m.ts)}`;
    if (m.channel === 'upgrade') { const t = document.createElement('span'); t.className = 'tag'; t.style.marginLeft = '6px'; t.textContent = 'Nâng cấp'; who.append(t); }
    const txt = document.createElement('div'); txt.className = 'sup-text'; txt.textContent = m.body;
    row.append(who);
    if (m.image) { row.classList.add('has-img'); window.ChatImage.attach(row, `/api/admin/support/images/${m.image}`, session.token); }
    if (m.body) row.append(txt);
    return row;
  }
  let oldestId = 0;
  function addMessages(list) {
    const log = $('#log');
    for (const m of list) {
      lastId = Math.max(lastId, m.id);
      if (!oldestId || m.id < oldestId) oldestId = m.id;
      log.appendChild(rowOf(m));
    }
    if (list.length) log.scrollTop = log.scrollHeight;
  }
  /** Tải tin cũ hơn (kể cả kho lưu trữ) và chèn lên đầu. */
  async function loadOlder() {
    if (!current) return;
    $('#older').disabled = true;
    try {
      const j = await api(`/api/admin/support/threads/${current.userId}/history?before=${oldestId || ''}&limit=50`);
      const log = $('#log'); const h = log.scrollHeight;
      for (const m of [...j.messages].reverse()) { log.prepend(rowOf(m)); oldestId = Math.min(oldestId || m.id, m.id); }
      log.scrollTop = log.scrollHeight - h;
      $('#older').disabled = !j.more;
      if (!j.messages.length) msg('Không còn tin cũ hơn.');
    } catch (e) { msg(e.message, true); $('#older').disabled = false; }
  }
  $('#older').addEventListener('click', loadOlder);
  $('#export').addEventListener('click', async () => {
    if (!current) return;
    try {
      const r = await fetch(`/api/admin/support/threads/${current.userId}/export`, { headers: { Authorization: `Bearer ${session.token}` } });
      if (!r.ok) throw new Error('Không xuất được.');
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = url; a.download = `chat-${current.username}.txt`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { msg(e.message, true); }
  });

  /* Danh sách hội thoại: tải theo trang (40/trang, tối đa 100 trong một lần xem), lọc/tìm phía máy chủ, không dựng lại cả nghìn dòng. */
  const TH_PAGE = 40; const TH_MAX = 100;
  let thLoaded = TH_PAGE; let thTimer = null;
  function threadEl(t) {
    const el = document.createElement('div'); el.className = `th${current?.userId === t.userId ? ' on' : ''}`;
    const b = document.createElement('b'); b.textContent = t.username;
    if (t.plan) { const p = document.createElement('span'); p.className = 'tag'; p.textContent = t.plan; b.append(' ', p); }
    if (t.pendingPlan) { const q = document.createElement('span'); q.className = 'tag'; q.textContent = 'chờ xử lý'; b.append(' ', q); }
    if (t.unread) { const n = document.createElement('span'); n.className = 'tag new'; n.textContent = `${t.unread} mới`; b.append(' ', n); }
    const s = document.createElement('small'); s.textContent = `${t.lastFromAdmin ? 'Bạn: ' : ''}${t.lastBody}`;
    el.append(b, s); el.addEventListener('click', () => open(t.userId, t.username));
    return el;
  }
  async function loadThreads() {
    const q = ($('#th-q')?.value || '').trim(); const f = $('#th-filter')?.value || '';
    const j = await api(`/api/admin/support/threads?limit=${Math.min(TH_MAX, thLoaded)}&offset=0&q=${encodeURIComponent(q)}&filter=${encodeURIComponent(f)}`);
    const box = $('#threads'); box.textContent = '';
    if (!j.threads.length) { box.textContent = q || f ? 'Không có cuộc trò chuyện phù hợp.' : 'Chưa có cuộc trò chuyện.'; box.className = 'help'; }
    else { box.className = ''; const frag = document.createDocumentFragment(); for (const t of j.threads) frag.appendChild(threadEl(t)); box.appendChild(frag); }
    $('#th-count').textContent = j.total ? `Hiện ${j.threads.length} / ${j.total} cuộc trò chuyện${j.unread ? ` · ${j.unread} tin chưa đọc` : ''}${j.pending ? ` · ${j.pending} yêu cầu đổi gói đang chờ` : ''}` : '';
    const more = $('#th-more');
    more.classList.toggle('hidden', !(j.total > j.threads.length && j.threads.length < TH_MAX));
    if (j.total > TH_MAX && j.threads.length >= TH_MAX) $('#th-count').textContent += ' · dùng ô tìm kiếm để thu hẹp';
    return j;
  }
  $('#th-more')?.addEventListener('click', () => { thLoaded = Math.min(TH_MAX, thLoaded + TH_PAGE); loadThreads().catch((e) => msg(e.message, true)); });
  $('#th-filter')?.addEventListener('change', () => { thLoaded = TH_PAGE; loadThreads().catch((e) => msg(e.message, true)); });
  $('#th-q')?.addEventListener('input', () => { clearTimeout(thTimer); thTimer = setTimeout(() => { thLoaded = TH_PAGE; loadThreads().catch((e) => msg(e.message, true)); }, 300); });

  async function open(userId, username) {
    current = { userId, username }; lastId = 0; oldestId = 0; $('#log').textContent = '';
    document.body.classList.add('in-conv'); $('#info').classList.add('hidden'); $('#info-btn').classList.remove('on');
    $('#older').disabled = false; $('#export').disabled = false;
    $('#who').textContent = username;
    $('#input').disabled = false; $('#send').disabled = false;
    await poll(true);
    clearInterval(timer); timer = setInterval(() => { poll(false); }, 10000);
    loadThreads().catch(() => {});
  }

  async function poll(first) {
    if (!current) return;
    try {
      const j = await api(`/api/admin/support/threads/${current.userId}?after=${lastId}`);
      if (first) { const pl = $('#plan-line'); pl.textContent = j.plan ? `Gói hiện tại: ${j.plan}` : ''; pl.classList.toggle('hidden', !j.plan); fillApprove(j); renderProfile(j.profile, j.plans, j.planId); pendBar(j); }
      addMessages(j.messages);
      if (first) { const lu = [...(j.messages || [])].reverse().find((m) => m.from === 'user'); $('#reply-ch').value = lu?.channel === 'upgrade' || j.requestedPlan ? 'upgrade' : 'support'; }
    } catch (e) { msg(e.message, true); }
  }

  /* ---------- Bố cục kiểu ứng dụng nhắn tin: khung chat chiếm hết chỗ, thông tin/xử lý gói nằm trong ngăn ℹ ---------- */
  function pendBar(j) {
    const bar = $('#pend-bar'); const lbl = (j.plans || []).find((p) => p.id === j.requestedPlan)?.label || j.requestedPlan;
    bar.classList.toggle('hidden', !j.requestedPlan);
    $('#pend-text').textContent = j.requestedPlan ? `Yêu cầu đổi gói: ${lbl}${j.requestedDays ? ` · lưu ${j.requestedDays} ngày` : ''}` : '';
  }
  const toggleInfo = (open) => { const i = $('#info'); const on = open ?? i.classList.contains('hidden'); i.classList.toggle('hidden', !on); $('#info-btn').classList.toggle('on', on); if (on) i.scrollTop = 0; };
  $('#info-btn').addEventListener('click', () => { if (current) toggleInfo(); });
  $('#pend-open').addEventListener('click', () => { toggleInfo(true); $('#apr').scrollIntoView({ block: 'start' }); });
  $('#back-btn').addEventListener('click', () => { document.body.classList.remove('in-conv'); });
  { const inp = $('#input'); inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = `${Math.min(140, inp.scrollHeight)}px`; }); }

  /* ---------- Thông tin cơ bản của người dùng (DB) + cập nhật nhanh ---------- */
  const dmy = (t) => (t ? new Date(t).toLocaleDateString('vi-VN') : '—');
  const dt = (t) => (t ? new Date(t).toLocaleString('vi-VN') : '—');
  const ago = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'vừa xong' : m < 90 ? `${m} phút trước` : m < 2880 ? `${Math.round(m / 60)} giờ trước` : `${Math.round(m / 1440)} ngày trước`; };
  function renderProfile(pr, plans, planId) {
    const box = $('#prof'); if (!pr) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const days = pr.expiresAt ? Math.ceil((pr.expiresAt - Date.now()) / 86400000) : null;
    const rows = [
      ['Tài khoản', `${pr.username} (#${pr.id})`], ['Vai trò', pr.role + (pr.disabled ? ' · ĐÃ KHOÁ' : '')],
      ['Gói', (pr.plan || 'chưa gán') + (pr.nextPlan ? ` → ${pr.nextPlan}` : '')],
      ['Hết hạn', pr.expiresAt ? `${dmy(pr.expiresAt)}${days != null ? (days >= 0 ? ` (còn ${days} ngày)` : ` (quá hạn ${-days} ngày)`) : ''}` : 'không hết hạn'],
      ['Widget', pr.widgets == null ? '—' : `${pr.widgets}${pr.widgetLimit != null ? ` / ${pr.widgetLimit}` : ''}`],
      ['Lưu lịch sử', pr.unlimitedHistory ? 'không giới hạn' : pr.retentionDays == null ? '—' : `${pr.retentionDays} ngày`],
      ['Điều khiển từ xa', pr.remoteControl == null ? '—' : pr.remoteControl ? 'bật' : 'tắt'],
      ['Nhà máy / thiết bị', `${pr.site || '—'} / ${pr.device || '—'}`],
      ['Đăng nhập gần nhất', pr.lastLoginAt ? `${ago(pr.lastLoginAt)}${pr.lastLoginIp ? ` · ${pr.lastLoginIp}` : ''}` : '—'],
      ['Dữ liệu gần nhất', ago(pr.lastTelemetryAt)],
      ['Bảo mật', `${pr.passkeys ? `Face ID ${pr.passkeys}` : 'chưa Face ID'} · ${pr.totpEnabled ? 'Authenticator' : 'chưa Authenticator'}${pr.setupComplete ? '' : ' · chưa hoàn tất thiết lập'}`],
      ['Tạo lúc', `${dmy(pr.createdAt)}${pr.createdBy ? ` bởi ${pr.createdBy}` : ''}`], ['Đồng ý quyền riêng tư', pr.privacyConsentAt ? dmy(pr.privacyConsentAt) : '—'],
      ['Tin nhắn chat', String(pr.chatMessages)],
    ];
    const g = $('#prof-grid'); g.textContent = '';
    for (const [k, v] of rows) { const d = document.createElement('div'); const a = document.createElement('small'); a.style.display = 'block'; a.style.opacity = '.7'; a.textContent = k; const b = document.createElement('b'); b.style.fontWeight = '600'; b.textContent = v; d.append(a, b); g.appendChild(d); }
    if (pr.note) { const d = document.createElement('div'); d.style.gridColumn = '1 / -1'; const a = document.createElement('small'); a.style.cssText = 'display:block;opacity:.7'; a.textContent = 'Ghi chú admin'; const b = document.createElement('span'); b.textContent = pr.note; d.append(a, b); g.appendChild(d); }
    const sel = $('#pf-plan'); sel.textContent = '';
    for (const p of plans || []) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; sel.appendChild(o); }
    if (planId) sel.value = planId;
    $('#pf-exp').value = pr.expiresAt ? new Date(pr.expiresAt).toISOString().slice(0, 10) : '';
    $('#pf-days').value = pr.unlimitedHistory ? '' : (pr.retentionDays ?? ''); box.dataset.days = pr.unlimitedHistory ? '' : String(pr.retentionDays ?? '');
    $('#pf-rc').checked = pr.remoteControl === true; $('#pf-note').value = pr.note || '';
    box.dataset.planId = planId || ''; box.dataset.exp = pr.expiresAt || ''; box.dataset.rc = pr.remoteControl === true ? '1' : '0'; box.dataset.note = pr.note || '';
  }
  const pr0Unlimited = (box) => box.dataset.days === '';
  $('#pf-save')?.addEventListener('click', async () => {
    if (!current) return;
    const box = $('#prof'); const body = {};
    const plan = $('#pf-plan').value; const expStr = $('#pf-exp').value;
    const exp = expStr ? Date.parse(`${expStr}T23:59:59`) : null;
    const planChanged = plan !== box.dataset.planId; const expChanged = String(exp || '') !== String(box.dataset.exp || '');
    if (planChanged || expChanged) { body.planId = plan; body.expiresAt = exp; }
    if ($('#pf-days').value.trim() !== box.dataset.days && !(pr0Unlimited(box) && !$('#pf-days').value.trim())) body.retentionDays = $('#pf-days').value.trim() === '' ? null : Number($('#pf-days').value);
    if (($('#pf-rc').checked ? '1' : '0') !== box.dataset.rc) body.remoteControl = $('#pf-rc').checked;
    if ($('#pf-note').value !== box.dataset.note) body.note = $('#pf-note').value;
    if (!Object.keys(body).length) return msg('Chưa có gì thay đổi.');
    if (planChanged && !confirm(`Gán gói "${$('#pf-plan').selectedOptions[0].textContent}" cho ${current.username} NGAY${exp ? ` đến ${dmy(exp)}` : ' (không hết hạn)'}?`)) return;
    try { const r = await api(`/api/admin/support/threads/${current.userId}/profile`, 'POST', body); await poll(true); msg('Đã cập nhật.', false); void r; } catch (e) { msg(e.message, true); }
  });

  /* ---------- Đồng ý / Từ chối yêu cầu đổi gói (gán gói thủ công + nhắn chữ; không đơn hàng, không thanh toán) ---------- */
  let planLabels = {}; let pendingAction = null; let curPlanId = null; let curExp = null; let planOrder = [];
  function fillApprove(j) {
    planLabels = Object.fromEntries((j.plans || []).map((p) => [p.id, p.label]));
    planOrder = (j.plans || []).map((p) => p.id); curPlanId = j.planId; curExp = j.expiresAt || null;
    const sel = $('#apr-plan'); sel.textContent = '';
    for (const p of j.plans || []) {
      const o = document.createElement('option'); o.value = p.id;
      o.textContent = p.label + (p.id === j.planId ? ' (đang dùng)' : ''); o.disabled = p.id === j.planId; sel.appendChild(o);
    }
    if (j.requestedPlan && j.requestedPlan !== j.planId) sel.value = j.requestedPlan;
    else sel.value = [...sel.options].find((o) => !o.disabled)?.value || '';
    $('#apr-asked').textContent = j.requestedPlan ? `Người dùng đang xin tư vấn gói: ${planLabels[j.requestedPlan] || j.requestedPlan}.` : 'Người dùng chưa chọn gói cụ thể.';
    $('#apr-days').value = j.requestedDays || '';
    window._quotes = j.quotes || null; window._pricing = j.pricing || null;
    showQuote();
    $('#apr').classList.remove('hidden'); $('#apr-confirm').classList.add('hidden'); pendingAction = null;
    $('#apr-now').checked = false; $('#apr-now-row').classList.toggle('hidden', !isDown(sel.value));
  }
  function askConfirm(kind) {
    const sel = $('#apr-plan');
    if (kind === 'yes' && !sel.value) return msg('Hãy chọn gói.', true);
    pendingAction = kind;
    $('#apr-confirm-text').textContent = kind === 'yes'
      ? `Gán gói “${planLabels[sel.value] || sel.value}” cho ${current.username} và nhắn xác nhận? Chỉ bấm khi bạn đã tự kiểm tra tiền về ngoài hệ thống.`
      : `Từ chối yêu cầu của ${current.username} và gửi tin nhắn báo?`;
    const down = isDown(sel.value);
    if (kind === 'yes' && down) {
      $('#apr-confirm-text').textContent = curExp && !$('#apr-now').checked
        ? `Hạ gói của ${current.username}: giữ “${planLabels[curPlanId] || curPlanId}” đến hết ngày ${new Date(curExp).toLocaleDateString('vi-VN')}, sau đó tự chuyển sang “${planLabels[sel.value] || sel.value}” và nhắn báo ngày chuyển?`
        : `Đổi NGAY ${current.username} sang gói thấp hơn “${planLabels[sel.value] || sel.value}” (bỏ qua hạn gói hiện tại) và nhắn xác nhận?`;
    }
    $('#apr-confirm').classList.remove('hidden');
  }
  const isDown = (id) => planOrder.indexOf(id) !== -1 && planOrder.indexOf(id) < planOrder.indexOf(curPlanId);
  $('#apr-plan').addEventListener('change', () => { $('#apr-now-row').classList.toggle('hidden', !isDown($('#apr-plan').value)); });
  const money = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;
  function quoteLine(q) {
    if (!q) return '';
    if (q.kind === 'free') return 'Gói Miễn phí: 0đ.';
    if (q.kind === 'monthly') return `${q.label}: ${money(q.total)}/tháng (~${money(q.perYear)}/năm). ${q.note}`;
    return `${q.label}: ${money(q.total)} trả một lần cho ${q.years} năm (${q.widgets} widget × ${money(q.perWidget)}; tương đương ~${money(q.equivalentPerMonth)}/tháng). ${q.note}`;
  }
  /** Gợi ý giá của gói đang chọn (chỉ admin thấy). */
  function showQuote() {
    const q = window._quotes?.[$('#apr-plan').value];
    $('#quote').classList.toggle('hidden', !q);
    if (!q) return;
    const f = `Giá sàn theo chi phí: ~${money(q.floorPerWidgetMonth)}/widget/tháng (đĩa ~${q.storageMbPerWidget} MB/widget; VPS ${money(window._pricing?.vpsMonthVnd || 0)}/tháng).`;
    $('#quote-text').textContent = `Gợi ý tham khảo (chỉ admin thấy) cho ${q.widgets} widget hiện có: ${quoteLine(q)}${q.overCap ? ` ⚠ Vượt giới hạn ${q.widgetCap} widget của gói.` : ''} ${f}`;
  }
  $('#apr-plan').addEventListener('change', showQuote);
  $('#quote-fill').addEventListener('click', () => {
    const q = window._quotes?.[$('#apr-plan').value]; if (!q || !current) return;
    const body = q.kind === 'one_time'
      ? `Với ${q.widgets} widget hiện có, gói "${q.label}" trả một lần cho ${q.years} năm khoảng ${money(q.total)} (tương đương ~${money(q.equivalentPerMonth)}/tháng).`
      : q.kind === 'monthly' ? `Gói "${q.label}" cho ${q.widgets} widget hiện có khoảng ${money(q.total)}/tháng (hoặc ~${money(q.perYear)}/năm).` : `Gói "${q.label}" miễn phí.`;
    $('#input').value = `${body} Mức này chỉ để tham khảo; nếu bạn đồng ý, mình gửi hướng dẫn chuyển khoản.`;
    $('#input').focus();
  });
  $('#apr-yes').addEventListener('click', () => askConfirm('yes'));
  $('#apr-no').addEventListener('click', () => askConfirm('no'));
  $('#apr-cancel').addEventListener('click', () => { pendingAction = null; $('#apr-confirm').classList.add('hidden'); });
  $('#apr-ok').addEventListener('click', async () => {
    if (!current || !pendingAction) return;
    msg(''); $('#apr-ok').disabled = true;
    try {
      if (pendingAction === 'yes') await api(`/api/admin/support/threads/${current.userId}/approve`, 'POST', { plan: $('#apr-plan').value, immediate: $('#apr-now').checked, retentionDays: $('#apr-days').value.trim() === '' ? undefined : Number($('#apr-days').value) });
      else await api(`/api/admin/support/threads/${current.userId}/decline`, 'POST', { reason: $('#apr-reason').value.trim() });
      $('#apr-reason').value = '';
      lastId = 0; oldestId = 0; $('#log').textContent = ''; await poll(true); loadThreads().catch(() => {});
    } catch (e) { msg(e.message, true); } finally { $('#apr-ok').disabled = false; }
  });

  $('#input').addEventListener('input', syncComposer);
  $('#send').addEventListener('click', async () => {
    if (staged) return sendImage();
    const body = $('#input').value.trim();
    if (!current || !body) return;
    msg(''); $('#send').disabled = true;
    try { await api(`/api/admin/support/threads/${current.userId}`, 'POST', { body, channel: $('#reply-ch').value }); $('#input').value = ''; $('#input').style.height = 'auto'; syncComposer(); await poll(false); loadThreads().catch(() => {}); }
    catch (e) { msg(e.message, true); } finally { $('#send').disabled = false; }
  });

  /* Ảnh đính kèm kiểu ứng dụng nhắn tin: chọn/dán → ảnh nhỏ trong ô soạn, gõ chú thích, bấm Gửi mới gửi. */
  let staged = null;
  function syncComposer() {
    const chip = $('#chip');
    $('#attach').hidden = Boolean($('#input').value.trim()) || Boolean(staged);
    if (staged && !chip.hasChildNodes()) {
      const img = document.createElement('img'); img.src = staged.url; img.alt = 'Ảnh đính kèm';
      const sm = document.createElement('small'); sm.textContent = 'Ảnh đính kèm';
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.className = 'fit'; x.setAttribute('aria-label', 'Bỏ ảnh'); x.onclick = unstage;
      chip.append(img, sm, x);
    }
    chip.hidden = !staged;
  }
  function unstage() { if (staged) URL.revokeObjectURL(staged.url); staged = null; $('#chip').textContent = ''; $('#file').value = ''; syncComposer(); }
  async function stageImage(file) {
    if (!current || !file) return;
    try { const blob = await window.ChatImage.prepare(file); unstage(); staged = { blob, url: URL.createObjectURL(blob) }; syncComposer(); $('#input').placeholder = 'Thêm chú thích (tuỳ chọn)…'; $('#input').focus(); }
    catch (e) { msg(e.message || 'Không đọc được ảnh này.', true); }
  }
  async function sendImage() {
    if (!current || !staged) return;
    msg(''); $('#send').disabled = true;
    const caption = $('#input').value.trim();
    const pend = document.createElement('div'); pend.className = 'sup-msg admin has-img pending';
    const pw = document.createElement('small'); pw.textContent = 'Quản trị viên · đang gửi…'; pend.append(pw);
    const pobj = URL.createObjectURL(staged.blob); window.ChatImage.preview(pend, pobj);
    if (caption) { const pt = document.createElement('div'); pt.className = 'sup-text'; pt.textContent = caption; pend.append(pt); }
    const lg = $('#log'); lg.appendChild(pend); lg.scrollTop = lg.scrollHeight;
    try {
      const r = await fetch(`/api/admin/support/threads/${current.userId}/image?channel=${$('#reply-ch').value}${caption ? `&caption=${encodeURIComponent(caption)}` : ''}`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'image/jpeg' }, body: staged.blob,
      });
      pend.remove();
      if (!r.ok) throw new Error('Không gửi được ảnh.');
      $('#input').value = ''; unstage(); $('#input').placeholder = 'Nhập tin nhắn…';
      await poll(false); loadThreads().catch(() => {});
    } catch (e) { pend.remove(); msg(e.message || 'Không gửi được ảnh.', true); } finally { URL.revokeObjectURL(pobj); $('#send').disabled = false; syncComposer(); }
  }
  $('#attach').addEventListener('click', () => { if (current) $('#file').click(); });
  $('#file').addEventListener('change', (e) => stageImage(e.target.files?.[0]));
  $('#input').addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => /^image\//.test(x.type));
    if (f) { e.preventDefault(); stageImage(f); }
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
  setInterval(() => { if (!document.hidden) loadThreads().catch(() => {}); }, 30000);
})();
