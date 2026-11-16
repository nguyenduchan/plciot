'use strict';
/* Trang quản trị: thêm user, đổi vai trò, đổi site/thiết bị, khoá, đăng xuất mọi máy, xoá. Chỉ role admin. */
(function () {
  const $ = (s) => document.querySelector(s);
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch {}
  // Mở qua đường hầm SSH (ADMIN_SSH_LOGIN=true trên server): server tự cấp phiên admin, không cần đăng nhập.
  // Từ Internet endpoint này luôn trả 404 nên rơi về màn đăng nhập như cũ.
  if (!session?.token || session.demo) {
    fetch('/api/admin/local-session', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (j?.token) { localStorage.setItem('session', JSON.stringify({ token: j.token, apiBase: location.origin })); location.reload(); }
      else location.replace('admin-login.html');
    }).catch(() => location.replace('admin-login.html'));
    return;
  }
  const base = session.apiBase || location.origin;

  const ERR = {
    invalid_solution: 'Giải pháp không có trong danh sách.',
    invalid_id: 'Mã mục: chữ thường/số/gạch dưới, bắt đầu bằng chữ, tối đa 24 ký tự (không dùng “basic”).',
    invalid_folder: 'Thư mục này chưa có trên server (cần solutions/<tên>/webapp/ — chạy sync-solutions.ps1).',
    invalid_title: 'Tên hiển thị 1–60 ký tự, không chứa < >.',
    exists: 'Mã mục đã tồn tại.',
    in_use: 'Còn gateway đang dùng mục này — đổi gateway sang giải pháp khác trước.',
    forbidden: 'Bạn không có quyền quản trị.',
    unauthorized: 'Phiên hết hạn, đăng nhập lại.',
    session_revoked: 'Phiên đã bị thu hồi, đăng nhập lại.',
    account_disabled: 'Tài khoản đã bị khoá.',
    invalid_username: 'Tên đăng nhập 3–48 ký tự (chữ, số, _).',
    invalid_role: 'Vai trò không hợp lệ.',
    username_in_use: 'Tên đăng nhập đã có tài khoản.',
    invalid_site_or_device: 'Nhà máy/thiết bị chỉ gồm chữ, số, "_" và "-" (tối đa 48 ký tự).',
    last_admin: 'Không thể hạ quyền/khoá/xoá admin cuối cùng (hoặc chính bạn).',
    user_not_found: 'Không tìm thấy người dùng.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
    step_up_required: 'Cần xác nhận bằng vân tay / Authenticator.',
    reauth_required: 'Hãy đăng xuất rồi đăng nhập lại trước khi thao tác quản trị.',
    admin_not_allowlisted: 'Tên đăng nhập không nằm trong ADMIN_USERNAMES.',
    claim_root_private_key_missing: 'Thiếu CLAIM_ROOT_PRIVATE_KEY trên server.',
    claim_root_public_key_missing: 'Thiếu CLAIM_ROOT_PUBLIC_KEY trên server.',
    claim_secret_unavailable: 'Không lấy lại được QR (thiết bị cũ). Hãy phát hành lại tem.',
    device_already_claimed: 'Thiết bị đã có người dùng gắn. Phát hành lại sẽ cần huỷ liên kết.',
    not_found: 'Không tìm thấy thiết bị.',
  };

  let hwDevices = [];
  let lastQr = null;
  /** Catalog type từ API — không hard-code trong file admin. */
  let typeCatalog = [
    { id: 'iot-hub', title: 'Cổng kết nối (nhiều thiết bị con)' },
    { id: 'pump', title: 'Bơm' },
    { id: 'env', title: 'Môi trường' },
    { id: 'switch', title: 'Công tắc' },
    { id: 'relay', title: 'Relay' },
    { id: 'di', title: 'Đầu vào số' },
    { id: 'do', title: 'Đầu ra số' },
    { id: 'motor', title: 'Động cơ' },
    { id: 'energy', title: 'Điện năng' },
    { id: 'tank', title: 'Bồn / mức' },
    { id: 'conveyor', title: 'Băng tải' },
    { id: 'generic', title: 'Tuỳ chọn' },
  ];

  function msg(text, cls) { const m = $('#msg'); m.textContent = text || ''; m.className = cls || ''; }

  function kitText(bundle) {
    const g = bundle?.gateway;
    if (!g) return '';
    return JSON.stringify({
      enroll: g.enroll?.url,
      body: g.enrollBody || { qr: bundle.qr },
      mqtt: { host: g.mqtt?.host, port: g.mqtt?.port, username: g.mqtt?.username, tls: true },
      topics: g.topics,
      pack: g.pack,
      payloadExample: g.payloadExample,
    }, null, 2);
  }

  async function api(path, method = 'GET', body, retried) {
    let ctlTok = null;
    try { ctlTok = JSON.parse(localStorage.getItem('ctl'))?.token; } catch {}
    const r = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${session.token}`, ...(ctlTok ? { 'X-Control-Token': ctlTok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    // thao tác ghi của admin cần xác nhận lại bằng vân tay / Authenticator
    if (r.status === 401 && data.error === 'step_up_required' && !retried && window.Ctl) {
      try { localStorage.removeItem('ctl'); } catch {}
      if (await window.Ctl.unlock(data)) return api(path, method, body, true);
    }
    if (r.ok && Array.isArray(data.capacityWarnings) && data.capacityWarnings.length) alert('⚠ Cảnh báo năng lực server:\n\n' + data.capacityWarnings.join('\n\n'));
    if (!r.ok) throw new Error(ERR[data.error] || (window.ErrText ? window.ErrText(data.error, r.status) : (data.error || `Lỗi ${r.status}`)));
    return data;
  }

  const SCOPE_LABEL = { telemetry: 'Số liệu', status: 'Trạng thái', ack: 'Phản hồi lệnh', history: 'Lịch sử giờ' };
  let scopesAll = Object.keys(SCOPE_LABEL);
  let roles = ['admin', 'operator', 'viewer'];
  let users = [];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let solutions = [{ id: 'basic', title: 'Cơ bản' }], gatewaySolutions = [{ id: 'basic', title: 'Cơ bản' }], defSolution = 'basic';
  const solOpts = (sel) => gatewaySolutions.map((x) => `<option value="${esc(x.id === 'basic' ? '' : x.id)}"${(sel || '') === (x.id === 'basic' ? '' : x.id) ? ' selected' : ''}>${esc(x.title)}${x.id === defSolution && !sel ? ' (mặc định)' : ''}</option>`).join('');
  const roleOpts = (sel) => roles.map((r) => `<option value="${r}"${r === sel ? ' selected' : ''}>${r}</option>`).join('');

  const scopeBoxes = (sel, attr) => scopesAll.map((s) =>
    `<label><input type="checkbox" ${attr}="${s}"${sel.includes(s) ? ' checked' : ''}> ${SCOPE_LABEL[s] || s}</label>`).join('');

  /* Phân trang + tìm kiếm phía máy chủ: chỉ tải/dựng 25 dòng mỗi lần, không treo khi có nhiều gateway/người dùng. */
  const PAGE = 25;
  const pg = { u: { q: '', off: 0, total: 0 }, hw: { q: '', off: 0, total: 0 } };
  function renderPager(sel, st, reload) {
    const el = $(sel); if (!el) return;
    const pages = Math.max(1, Math.ceil(st.total / PAGE)); const cur = Math.floor(st.off / PAGE) + 1;
    if (st.total <= PAGE) { el.textContent = ''; return; }
    el.innerHTML = `<button type="button" data-d="-1"${cur <= 1 ? ' disabled' : ''}>‹ Trước</button><span>Trang ${cur}/${pages} · ${st.total} mục</span><button type="button" data-d="1"${cur >= pages ? ' disabled' : ''}>Sau ›</button>`;
    el.onclick = (e) => { const b = e.target.closest('button[data-d]'); if (!b) return; st.off = Math.max(0, st.off + Number(b.dataset.d) * PAGE); reload().catch((er) => msg(er.message, 'err')); };
  }
  const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const qs = (st) => `limit=${PAGE}&offset=${st.off}&q=${encodeURIComponent(st.q)}`;

  const TABS = ['gw', 'add', 'find', 'users', 'sol', 'cap'];
  let solTimer = null;
  let curTab = 'gw';
  function showAdminTab(name) {
    if (!TABS.includes(name)) name = 'gw';
    curTab = name;
    document.querySelectorAll('.adm-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.at === name));
    document.querySelectorAll('.adm-pane').forEach((p) => { p.hidden = p.dataset.at !== name; });
    try { localStorage.setItem('admTab', name); } catch { /* */ }
    if (name === 'find') window.AdminFind?.open();
    clearInterval(solTimer);
    if (name === 'sol') { loadSolutions().catch((e) => msg(e.message, 'err')); solTimer = setInterval(() => { if (!document.hidden) loadSolutions().catch(() => {}); }, 20000); }   // thư mục mới chép lên server tự vào ô chọn
    if (name === 'cap') loadCapacity().catch(() => {});
    if (name === 'gw') { loadHw().catch(() => {}); loadDup().catch(() => {}); }
  }
  document.querySelector('.adm-tabs')?.addEventListener('click', (e) => { const b = e.target.closest('button[data-at]'); if (b) showAdminTab(b.dataset.at); });
  $('#hw-q')?.addEventListener('input', debounce((e) => { pg.hw.q = e.target.value.trim(); pg.hw.off = 0; loadHw().catch((er) => msg(er.message, 'err')); }));
  $('#u-q')?.addEventListener('input', debounce((e) => { pg.u.q = e.target.value.trim(); pg.u.off = 0; loadUsers().catch((er) => msg(er.message, 'err')); }));

  function render() {
    $('#count').textContent = pg.u.total; const nb = $('#at-users-n'); if (nb) nb.textContent = pg.u.total;
    renderPager('#u-pager', pg.u, loadUsers);
    $('#list').innerHTML = users.map((u) => `
      <div class="u${u.disabled ? ' dis' : ''}" data-id="${u.id}">
        <div><b>${esc(u.username)}</b> <span class="tag ${u.role}">${u.role}</span>${u.disabled ? ' <span class="tag viewer">đã khoá</span>' : ''}
          <small>site <code>${esc(u.site)}</code> · thiết bị <code>${esc(u.device)}</code></small></div>
        <div></div>
        <div class="scopes" data-scopes>${scopeBoxes(u.scopes, 'data-sc')}</div>
        <div class="acts">
          <select data-act="role">${roleOpts(u.role)}</select>
          <button data-act="site">Đổi site/thiết bị</button>
          <button data-act="logout">Đăng xuất mọi máy</button>
          <button data-act="toggle">${u.disabled ? 'Mở khoá' : 'Khoá'}</button>
          <button data-act="del" class="danger">Xoá</button>
        </div>
      </div>`).join('') || '<p class="help">Chưa có người dùng.</p>';
  }

  function fmtTs(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString('vi-VN'); } catch { return String(ts); }
  }

  function renderHw() {
    $('#hw-count').textContent = pg.hw.total; const nb = $('#at-gw-n'); if (nb) nb.textContent = pg.hw.total;
    renderPager('#hw-pager', pg.hw, loadHw);
    $('#hw-list').innerHTML = hwDevices.map((d) => `
      <div class="hw" data-site="${esc(d.site)}" data-device="${esc(d.device)}">
        <div><b>${esc(d.label || `${d.site}/${d.device}`)}</b>
          ${d.claimed ? '<span class="tag">đã gắn</span>' : '<span class="tag viewer">chưa gắn</span>'}
          ${d.activated ? `<span class="tag">đã kích hoạt${d.activations > 1 ? ` · ${d.activations} lần` : ''}</span>` : ''}
          <small><code>${esc(d.site)}</code> / <code>${esc(d.device)}</code>
            ${d.profile ? ` · <b>${esc(d.profile)}</b>` : ' · <span class="tag viewer">chưa profile</span>'}
            ${d.note ? ` · ${esc(d.note)}` : ''}
            ${d.claimedUsername ? ` · user ${esc(d.claimedUsername)}` : ''}
            · tạo ${esc(fmtTs(d.createdAt))}</small>
          <small>${d.activatedHw ? `ID máy <code>${esc(d.activatedHw)}</code>` : 'chưa gắn máy'}
            ${d.mqttId ? ` · ID MQTT <code>${esc(d.mqttId)}</code>${d.mqttStatus && d.mqttStatus !== 'active' ? ` (${esc(d.mqttStatus)})` : ''}` : ''}
            ${d.config ? ` · setting rev ${d.config.rev}: ${d.config.devices} thiết bị, ${d.config.fields} field · cập nhật ${esc(fmtTs(d.config.updatedAt))}` : ' · chưa có setting'}</small>
          <small>Giải pháp (do gateway chọn): <b>${esc(d.solutionTitle || 'Cơ bản')}</b></small></div>
        <div class="acts">
          <button data-hw="qr">Xem / in QR</button>
          ${d.activated ? '<button data-hw="unbind">Gỡ máy đã gắn</button>' : ''}
          ${d.claimed
    ? '<button data-hw="revoke" class="danger">Thu hồi &amp; cấp QR mới</button>'
    : '<button data-hw="reissue">Phát hành lại tem</button>'}
          <button data-hw="del" class="danger">Xoá</button>
        </div>
      </div>`).join('') || '<p class="help">Chưa có thiết bị. Thêm ở form phía trên.</p>';
  }

  async function showQr(bundle) {
    lastQr = bundle;
    const title = bundle.label || `${bundle.site}/${bundle.device}`;
    $('#qr-title').textContent = title;
    const gw = bundle.gateway;
    $('#qr-meta').textContent = `${bundle.site} / ${bundle.device}`
      + `${bundle.profile ? ` · ${bundle.profile}` : ''}${bundle.note ? ` — ${bundle.note}` : ''}`
      + (gw?.topicBase ? ` · MQTT ${gw.topicBase}` : '')
      + (gw?.seed?.length ? ` · ${gw.seed.length} device con` : '');
    $('#qr-url').textContent = bundle.loginUrl || bundle.qr;
    const gwEl = $('#qr-gateway');
    if (gwEl) {
      const text = kitText(bundle);
      if (text) {
        gwEl.style.display = 'block';
        gwEl.textContent = text;
      } else {
        gwEl.style.display = 'none';
        gwEl.textContent = '';
      }
    }
    const host = $('#qr-canvas');
    host.innerHTML = '';
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const text = bundle.loginUrl || bundle.qr;
    if (window.QRCode?.toCanvas) {
      await window.QRCode.toCanvas(canvas, text, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
    } else {
      host.innerHTML = `<p class="help">Không tải được thư viện QR. Link: <code>${esc(text)}</code></p>`;
    }
    $('#qr-modal').classList.add('on');
  }

  function closeQr() { $('#qr-modal').classList.remove('on'); }

  async function loadHw() {
    const j = await api(`/api/admin/hardware?${qs(pg.hw)}`);
    hwDevices = j.devices || [];
    pg.hw.total = j.total ?? hwDevices.length;
    if (!hwDevices.length && pg.hw.off > 0) { pg.hw.off = Math.max(0, pg.hw.off - PAGE); return loadHw(); }
    const cfg = $('#hw-cfg');
    if (cfg) {
      cfg.textContent = j.configured
        ? '✓ Khoá ký QR đã cấu hình.'
        : '⚠ Chưa có CLAIM_ROOT_* — không tạo được tem. Chạy: node cloud/app/scripts/provision-device-qr.js gen-keys';
      cfg.style.color = j.configured ? 'var(--ok)' : 'var(--warn)';
    }
    renderHw();
    const sel = $('#act-dev');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = hwDevices.map((d) => {
        const v = `${d.site}/${d.device}`;
        return `<option value="${esc(v)}">${esc(d.label ? `${d.label} (${v})` : v)}${d.activated ? ' — đã kích hoạt' : ''}</option>`;
      }).join('') || '<option value="">Chưa có thiết bị</option>';
      if (cur) sel.value = cur;
    }
  }

  $('#act-mode')?.addEventListener('change', () => {
    const lic = $('#act-mode').value !== 'challenge';
    $('#act-req-label').firstChild.textContent = lic ? 'ID máy của gateway' : 'Mã yêu cầu từ gateway';
    $('#act-req').placeholder = lic ? 'GW7K2M9X' : 'GW7K-2M9X-A4QP-8RTC';
  });

  $('#act-go')?.addEventListener('click', async () => {
    msg('');
    const sel = $('#act-dev').value;
    const request = $('#act-req').value.trim();
    const mode = $('#act-mode')?.value === 'challenge' ? 'challenge' : 'license';
    if (!sel) return msg('Chưa có thiết bị để kích hoạt. Hãy thêm thiết bị ở trên.', 'err');
    if (!request) return msg(mode === 'license' ? 'Hãy nhập ID máy (in trên tem hoặc hiện trên gateway).' : 'Hãy nhập mã yêu cầu hiển thị trên gateway.', 'err');
    const [site, device] = sel.split('/');
    const d = hwDevices.find((x) => x.site === site && x.device === device);
    const call = (force) => api(`/api/admin/hardware/${encodeURIComponent(site)}/${encodeURIComponent(device)}/activate`, 'POST',
      { request, days: Number($('#act-days').value) || 0, force, mode });
    try {
      let r;
      try {
        r = await call(false);
      } catch (e) {
        if (!/đã được kích hoạt cho một máy khác/.test(e.message)) throw e;
        if (!confirm(`${sel} đã kích hoạt cho một máy khác${d?.activatedHw ? ` (ID ${d.activatedHw.slice(0, 12)}…)` : ''}.\nTiếp tục sẽ chuyển sang máy mới; máy cũ vẫn giữ mã cũ cho tới khi hết hạn. Tiếp tục?`)) throw new Error('Đã huỷ, chưa thay đổi gì.');
        r = await call(true);
      }
      $('#act-code').value = r.code;
      lastLicense = r.licenseFile || null;
      $('#act-lic').hidden = !lastLicense;
      $('#act-out').hidden = false;
      msg(`Đã tạo mã kích hoạt cho ${sel}${r.exp ? ` (hết hạn ${fmtTs(r.exp * 1000)})` : ' (không hết hạn)'}. Gõ mã này vào gateway.${r.activations > 1 ? ` Chú ý: máy này đã được cấp mã ${r.activations} lần — nếu bạn không reset máy, hãy kiểm tra có bị chép (clone) không.` : ''}`, 'ok');
      await loadHw();
    } catch (e) { msg(e.message, 'err'); }
  });

  async function loadDup() {
    const panel = $('#dup-panel');
    if (!panel) return;
    try {
      const j = await api('/api/admin/duplicate-suspects');
      const items = j.items || [];
      panel.hidden = !items.length;
      $('#dup-list').innerHTML = items.map((i) => `<div class="hw"><div><small>${esc(fmtTs(i.ts))}</small><br>${esc(i.detail || '')}</div></div>`).join('');
    } catch { panel.hidden = true; }
  }

  $('#gk-new')?.addEventListener('click', () => {
    const al = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const b = crypto.getRandomValues(new Uint8Array(10));
    $('#gk-hw').value = Array.from(b, (x) => al[x % 32]).join('');
    $('#gk-key').value = '';
  });

  $('#gk-go')?.addEventListener('click', async () => {
    msg('');
    const hw = $('#gk-hw').value.trim();
    if (!hw) return msg('Nhập ID máy hoặc bấm "Tạo ID mới".', 'err');
    try {
      const r = await api('/api/admin/gateway-key', 'POST', { hw });
      $('#gk-hw').value = r.hw;
      $('#gk-key').value = r.key;
      $('#gk-file').hidden = false;
      msg(`Khoá của máy ${r.hw} đã tạo. Nạp vào gateway và đừng để lộ ra ngoài.`, 'ok');
    } catch (e) { msg(e.message, 'err'); }
  });

  // File khoá cho bản cài PC của khách: {v, hw, key}. Gateway PC cất bằng DPAPI/TPM khi cài.
  $('#gk-file')?.addEventListener('click', () => {
    const hw = $('#gk-hw').value.trim(); const key = $('#gk-key').value;
    if (!hw || !key) return msg('Hãy lấy khoá nạp trước.', 'err');
    const blob = new Blob([JSON.stringify({ v: 1, hw, key }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `plciot-gateway-${hw}.key.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    msg('Đã tải file khoá. Gửi riêng cho khách cùng bộ cài, không đăng công khai.', 'ok');
  });

  // Giấy phép một file cho gateway PC không internet: khách nhập/dán một lần, PC tự kiểm với ID máy của nó.
  let lastLicense = null;
  $('#act-lic')?.addEventListener('click', () => {
    if (!lastLicense) return;
    const blob = new Blob([JSON.stringify(lastLicense, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `plciot-license-${lastLicense.hw}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    msg('Đã tải file giấy phép. Gửi riêng cho khách; file chỉ dùng được trên máy có đúng ID này.', 'ok');
  });

  $('#act-copy')?.addEventListener('click', async () => {
    const t = $('#act-code').value;
    try { await navigator.clipboard.writeText(t); msg('Đã sao chép mã kích hoạt.', 'ok'); } catch {
      $('#act-code').select();
      msg('Hãy nhấn Ctrl+C để sao chép mã đang được chọn.', 'ok');
    }
  });

  async function loadTypes() {
    try {
      const r = await fetch(`${base}/api/v1/ui/types`);
      const data = await r.json();
      if (r.ok && Array.isArray(data.types) && data.types.length) {
        typeCatalog = data.types.map((t) => ({ id: t.id, title: t.title || t.id }));
      }
    } catch { /* giữ fallback */ }
  }

  async function loadUsers() {
    const j = await api(`/api/admin/users?${qs(pg.u)}`);
    roles = j.roles; users = j.users; scopesAll = j.scopes || scopesAll;
    if (Array.isArray(j.gatewaySolutions) && j.gatewaySolutions.length) gatewaySolutions = j.gatewaySolutions;
    defSolution = j.defaultSolution || 'basic';
    renderHw();   // danh sách giải pháp dùng chung cho form tạo mã và từng dòng gateway
    pg.u.total = j.total ?? users.length;
    if (!users.length && pg.u.off > 0) { pg.u.off = Math.max(0, pg.u.off - PAGE); return loadUsers(); }
    render();
  }

  async function load() {
    try {
      await loadTypes();
      await loadUsers();
      await loadHw();
      await loadDup();
    } catch (e) {
      $('#list').textContent = '';
      msg(e.message, 'err');
      if (/quản trị|đăng nhập lại|khoá/.test(e.message)) setTimeout(() => location.replace('index.html'), 2500);
    }
  }

  /* ---------- (Ghép cặp bằng mã admin đã bỏ: gateway tự đăng ký bằng tài khoản người dùng) ---------- */
  // Tự làm mới danh sách gateway + mã ghép cặp (gateway vừa nhập mã là hiện ngay, không cần tải lại trang)
  setInterval(() => {
    if (document.hidden || $('#qr-modal')?.classList.contains('on')) return;
    if (curTab === 'gw') loadHw().catch(() => {});
  }, 8000);
  loadCapacity().catch(() => {});
  setInterval(() => { if (!document.hidden && (curTab === 'cap' || !document.querySelector('#at-cap-dot')?.dataset.set)) loadCapacity().catch(() => {}); }, 60000);
  { let st = 'gw'; try { st = localStorage.getItem('admTab') || 'gw'; } catch { /* */ } showAdminTab(st); }
  const PR_ICON = { tank: '🛢', pump: '⛽', env: '🌡', valve: '🚰', motor: '⚙️', energy: '⚡', pressure: '🧭', conveyor: '📦', di: '⬇️', do: '⬆️', custom: '➕' };

  $('#qp-go')?.addEventListener('click', () => run(async () => {
    const qr = $('#qp-qr').value.trim();
    if (!qr) throw new Error('Dán QR hoặc link tem.');
    const r = await api('/api/admin/qr-preview', 'POST', { qr });
    $('#qp-out').innerHTML = `<p class="help" style="margin-top:0"><b>${esc(r.label || `${r.site}/${r.device}`)}</b> · <code>${esc(r.site)}/${esc(r.device)}</code>${r.profile ? ` · ${esc(r.profile)}` : ''} · ${r.claimed ? 'tem đã có chủ' : 'tem chưa có chủ'} — chỉ xem, không gắn vào tài khoản nào.</p>`
      + (r.devices.map((d) => `<div style="margin:8px 0"><b>${PR_ICON[d.icon] || ''} ${esc(d.title)}</b> <code>${esc(d.childId)}</code>${d.color ? ` <span class="tag">${esc(d.color)}</span>` : ''}
        <ul style="margin:4px 0 0 18px;padding:0">${d.widgets.map((w) => `<li>${esc(w.label)} <code>${esc(w.bind || '')}</code> · ${esc(w.kind)}${w.cmd ? ' · điều khiển' : ''}${w.onText || w.offText ? ` · ${esc(w.onText || '')}/${esc(w.offText || '')}` : ''}${w.low != null || w.high != null ? ` · ngưỡng ${w.low ?? '—'}…${w.high ?? '—'}` : ''}</li>`).join('')}</ul></div>`).join('') || '<p class="help">Gateway chưa khai thiết bị con nào.</p>');
  }, 'Xem thử xong (không lưu gì).'));

  async function loadCapacity() {
    const c = await api('/api/admin/vps-capacity');
    const col = { ok: '#16a34a', warn: '#d97706', crit: '#dc2626' }[c.level] || '#64748b';
    const dot = $('#at-cap-dot'); if (dot) { dot.dataset.set = '1'; dot.textContent = { ok: 'Ổn', warn: 'Chú ý', crit: 'Nguy cấp' }[c.level] || ''; dot.style.cssText = `background:${col};color:#fff`; }
    const b = $('#cap-badge'); b.textContent = { ok: 'Ổn', warn: 'Chú ý', crit: 'Nguy cấp' }[c.level] || c.level; b.style.cssText = `background:${col};color:#fff`;
    $('#cap-alerts').innerHTML = c.alerts.map((a) => `<p style="margin:6px 0;padding:8px 10px;border-radius:8px;border:1px solid ${col};color:${col}">⚠ ${esc(a)}</p>`).join('');
    const gb = (mb) => (mb / 1024).toFixed(1);
    const bar = (pct, label) => `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between"><span>${esc(label)}</span><b>${pct}%</b></div><div style="height:8px;border-radius:4px;background:var(--line,#e5e7eb)"><div style="height:8px;border-radius:4px;width:${Math.min(100, pct)}%;background:${pct >= c.thresholds.crit ? '#dc2626' : pct >= c.thresholds.warn ? '#d97706' : '#16a34a'}"></div></div></div>`;
    $('#cap-body').innerHTML =
      (c.disk ? bar(c.disk.usedPct, `Đĩa thật: ${c.disk.freeGb} GB trống / ${c.disk.totalGb} GB`) : '')
      + bar(c.db.pctOfUsable, `Cơ sở dữ liệu: ${gb(c.db.mb)} GB / ${c.usableGb} GB dùng được`)
      + bar(c.projected.pctOfUsable, `Đĩa dự kiến khi các gói đầy thời gian lưu: ${gb(c.projected.mb)} GB`)
      + `<p style="margin:8px 0">Tổng <b>${c.widgets}</b> widget (cảnh báo ${c.thresholds.wWarn}, mốc chuyển VPS ${c.thresholds.wMax}) · sao lưu trên VPS ${gb(c.backupsMb)} GB`
      + (c.growthMbPerDay != null ? ` · DB tăng ~${c.growthMbPerDay} MB/ngày${c.daysLeft != null ? `, còn ~${c.daysLeft} ngày đến khi đầy` : ''}` : ' · chưa đủ dữ liệu để ước tốc độ tăng (cần ≥ 2 ngày)')
      + ` · RAM app ${c.mem.rssMb} MB${c.mem.limitMb ? ` / giới hạn ${c.mem.limitMb} MB` : ''}</p>`
      + `<table style="width:100%;border-collapse:collapse"><tr><th align="left">Gói</th><th align="right">Người dùng</th><th align="right">Widget</th><th align="right">MB/widget</th><th align="right">Đĩa dự kiến</th></tr>`
      + c.plans.map((p) => `<tr><td>${esc(p.label)}</td><td align="right">${p.users}</td><td align="right">${p.widgets}</td><td align="right">${p.mbPerWidget}</td><td align="right">${gb(p.projectedMb)} GB</td></tr>`).join('') + '</table>'
      + `<p class="help" style="margin:8px 0 0">Đĩa dùng được lấy từ <code>PRICING_DISK_USABLE_GB</code> (đặt theo VPS thật). Ngưỡng: <code>CAP_WARN_PCT</code>, <code>CAP_CRIT_PCT</code>, <code>CAP_WIDGETS_WARN</code>, <code>CAP_WIDGETS_MAX</code>.</p>`;
  }

  /* ---------- Giải pháp: mục trong ô chọn ↔ thư mục webapp ---------- */
  let solView = { items: [], folders: [] };
  async function loadSolutions() {
    solView = await api('/api/admin/solutions');
    const nb = $('#at-sol-n'); if (nb) nb.textContent = solView.items.length + 1;
    const pt = (p) => `Webapp ${p?.webapp ? '✓' : '—'} · Gateway ${p?.gateway ? '✓' : '—'}`;
    const fo = (sel) => solView.folders.map((f) => `<option value="${esc(f.folder)}"${f.folder === sel ? ' selected' : ''}>${esc(f.folder)} — ${esc(f.title)} (${pt(f.parts)})</option>`).join('');
    $('#sol-list').innerHTML = `<div class="u" style="padding:8px 0;border-bottom:1px solid var(--line)"><b>Cơ bản</b> <span class="help">(mã <code>basic</code> — luôn có, thư mục <code>webapp/</code>) ${solView.default === 'basic' ? '· mặc định' : ''}</span></div>`
      + solView.items.map((it) => `<div class="u sol" data-id="${esc(it.id)}" style="padding:8px 0;border-bottom:1px solid var(--line);display:grid;gap:6px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));align-items:center">
        <div><b>${esc(it.id)}</b>${solView.default === it.id ? ' <span class="tag">mặc định</span>' : ''}<div class="help" style="margin:0">${it.users} gateway${it.missing ? ' · <b style="color:#c0392b">thiếu thư mục</b>' : (it.version ? ' · v' + esc(it.version) : '') + ' · ' + pt(it.parts)}</div></div>
        <input data-f="title" value="${esc(it.title)}" maxlength="60" title="Tên hiển thị trong ô chọn">
        <select data-f="folder" title="Thư mục webapp">${fo(it.folder)}${it.missing ? `<option value="${esc(it.folder)}" selected>${esc(it.folder)} (mất)</option>` : ''}</select>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="enabled"${it.enabled ? ' checked' : ''}> hiện trong ô chọn</label>
        <button data-sa="del" class="fit">Xoá</button></div>`).join('');
    $('#sol-folder').innerHTML = fo('');
    const ig = (solView.ignored || []).map((f) => `${f.folder} (${f.reason})`);
    $('#sol-hint').textContent = (solView.folders.length ? 'Thư mục có dấu nhận diện (solution.json: "kind": "plciot-solution") tự có mục (mã = tên thư mục); webapp/ và gateway/ là hai thư mục riêng — thiếu phần nào thì mục không hiện ở ô chọn tương ứng. Danh sách tự cập nhật. “Thêm” chỉ để tạo thêm mục tên khác trỏ cùng thư mục.' : 'Chưa có thư mục giải pháp nào trong solutions/ trên server.') + (ig.length ? ` Bị bỏ qua: ${ig.join('; ')}.` : '');
  }
  $('#sol-add')?.addEventListener('click', () => {
    const id = $('#sol-id').value.trim(); const folder = $('#sol-folder').value;
    run(async () => { await api('/api/admin/solutions', 'POST', { id, title: $('#sol-title').value.trim() || id, folder }); $('#sol-id').value = ''; $('#sol-title').value = ''; await loadSolutions(); }, 'Đã thêm mục vào ô chọn.');
  });
  $('#sol-list')?.addEventListener('change', (e) => {
    const row = e.target.closest('.sol'); const f = e.target.dataset.f; if (!row || !f) return;
    const val = f === 'enabled' ? e.target.checked : e.target.value.trim();
    run(async () => { await api(`/api/admin/solutions/${encodeURIComponent(row.dataset.id)}`, 'PATCH', { [f]: val }); await loadSolutions(); }, 'Đã lưu.');
  });
  $('#sol-list')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sa="del"]'); const row = e.target.closest('.sol'); if (!b || !row) return;
    if (!confirm(`Xoá mục “${row.dataset.id}” khỏi ô chọn? (không xoá thư mục webapp)`)) return;
    run(async () => { await api(`/api/admin/solutions/${encodeURIComponent(row.dataset.id)}`, 'DELETE'); await loadSolutions(); }, 'Đã xoá mục.');
  });

  async function run(fn, okText) {
    msg('');
    try { await fn(); msg(okText, 'ok'); await load(); } catch (e) { msg(e.message, 'err'); }
  }
  window.AdminCore = { api, msg, esc, run, showQr, fmtTs };   // cho admin-find.js (tab Tìm kiếm)

  $('#hw-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-hw]');
    const row = e.target.closest('.hw');
    if (!b || !row) return;
    const site = row.dataset.site;
    const device = row.dataset.device;
    const d = hwDevices.find((x) => x.site === site && x.device === device);
    if (b.dataset.hw === 'qr') {
      run(async () => {
        const r = await api(`/api/admin/hardware/${encodeURIComponent(site)}/${encodeURIComponent(device)}/qr`);
        await showQr(r);
      }, '');
    } else if (b.dataset.hw === 'revoke') {
      const who = d?.claimedUsername ? `tài khoản "${d.claimedUsername}"` : 'tài khoản đang dùng';
      if (!confirm(`Thu hồi ${site}/${device}?

• Gỡ thiết bị khỏi ${who} (người đó mất quyền xem/điều khiển).
• QR cũ và kit gateway cũ hết hiệu lực.
• Tạo QR mới để thêm lại (webapp hoặc gateway).`)) return;
      run(async () => {
        const r = await api(`/api/admin/hardware/${encodeURIComponent(site)}/${encodeURIComponent(device)}/revoke`, 'POST', {});
        await loadHw();
        await showQr(r);
      }, 'Đã thu hồi: thiết bị đã gỡ khỏi tài khoản đang dùng và QR cũ hết hiệu lực. QR mới đang hiện trong hộp QR.');
    } else if (b.dataset.hw === 'unbind') {
      if (!confirm(`Gỡ ràng buộc máy của ${site}/${device}?\n\nTem và tài khoản MQTT giữ nguyên. Máy đang dùng vẫn chạy cho tới khi bị ngắt; máy KHÁC (hoặc máy mới) sẽ gắn được lần kế tiếp.`)) return;
      run(async () => {
        await api(`/api/admin/hardware/${encodeURIComponent(site)}/${encodeURIComponent(device)}/unbind`, 'POST', {});
        await loadHw();
      }, 'Đã gỡ ràng buộc máy. Tem này gắn được với máy mới.');
    } else if (b.dataset.hw === 'reissue') {
      if (!confirm('Tem cũ sẽ hết hiệu lực. Tiếp tục?')) return;
      run(async () => {
        const r = await api(`/api/admin/hardware/${encodeURIComponent(site)}/${encodeURIComponent(device)}/reissue`, 'POST', {});
        await loadHw();
        await showQr(r);
      }, 'Đã phát hành tem mới.');
    } else if (b.dataset.hw === 'del') {
      if (!confirm(`Xoá đăng ký ${site}/${device}? Người dùng sẽ không claim được tem cũ.`)) return;
      run(async () => {
        await api(`/api/admin/hardware/${encodeURIComponent(site)}/${encodeURIComponent(device)}${d?.claimed ? '?force=1' : ''}`, 'DELETE');
        await loadHw();
      }, 'Đã xoá thiết bị.');
    }
  });

  $('#qr-close').onclick = closeQr;
  $('#qr-modal').addEventListener('click', (e) => { if (e.target === $('#qr-modal')) closeQr(); });
  $('#qr-print').onclick = () => window.print();
  $('#qr-copy').onclick = async () => {
    const t = lastQr?.loginUrl || lastQr?.qr || '';
    try {
      await navigator.clipboard.writeText(t);
      msg('Đã sao chép link claim.', 'ok');
    } catch {
      msg('Không sao chép được — chọn và copy thủ công.', 'err');
    }
  };
  $('#qr-copy-enroll')?.addEventListener('click', async () => {
    const body = lastQr?.gateway?.enrollBody || (lastQr?.qr ? { qr: lastQr.qr } : null);
    if (!body) return msg('Chưa có QR.', 'err');
    const text = JSON.stringify({
      url: lastQr?.gateway?.enroll?.url || '/api/v1/gateway/enroll',
      body,
    }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      msg('Đã sao chép enroll JSON (dán vào firmware/C#).', 'ok');
    } catch {
      msg('Không sao chép được — chọn khối JSON phía trên.', 'err');
    }
  });
  $('#qr-mqtt-kit')?.addEventListener('click', () => run(async () => {
    if (!lastQr?.site || !lastQr?.device) throw new Error('Chưa có tem.');
    const r = await api(
      `/api/admin/hardware/${encodeURIComponent(lastQr.site)}/${encodeURIComponent(lastQr.device)}/mqtt-kit`,
      'POST',
      {},
    );
    await showQr({ ...lastQr, ...r, gateway: r.gateway });
    const text = JSON.stringify({
      mqtt: r.gateway?.mqtt,
      topics: r.gateway?.topics,
      pack: r.gateway?.pack,
      payloadExample: r.gateway?.payloadExample,
    }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      msg('Đã sao chép MQTT (có password) + pack.', 'ok');
    } catch {
      msg('Đã hiện MQTT (có password) bên dưới.', 'ok');
    }
  }, ''));

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
      if (!u.disabled && !confirm(`Khoá ${u.username}? Họ bị đăng xuất và mất quyền MQTT ngay.`)) return;
      run(() => api(`/api/admin/users/${id}`, 'PATCH', { disabled: !u.disabled }), u.disabled ? 'Đã mở khoá.' : 'Đã khoá.');
    } else if (b.dataset.act === 'logout') {
      if (confirm(`Đăng xuất ${u.username} khỏi mọi thiết bị?`)) run(() => api(`/api/admin/users/${id}`, 'PATCH', { revokeSessions: true }), 'Đã đăng xuất mọi máy.');
    } else if (b.dataset.act === 'site') {
      const site = prompt('Nhà máy mới:', u.site); if (!site) return;
      const device = prompt('Thiết bị mới:', u.device); if (!device) return;
      run(() => api(`/api/admin/users/${id}`, 'PATCH', { site, device }), 'Đã đổi site/thiết bị.');
    } else if (b.dataset.act === 'del') {
      if (!confirm(`Xoá vĩnh viễn ${u.username}? Không thể hoàn tác (nên dùng Khoá nếu chỉ tạm dừng).`)) return;
      run(() => api(`/api/admin/users/${id}`, 'DELETE'), 'Đã xoá.');
    }
  });

  load();
})();
