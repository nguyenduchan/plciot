'use strict';
/* Trang quản trị: thêm user, đổi vai trò, đổi site/thiết bị, khoá, đăng xuất mọi máy, xoá. Chỉ role admin. */
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
    invalid_username: 'Username 3–48 ký tự (chữ, số, _).',
    invalid_role: 'Vai trò không hợp lệ.',
    username_in_use: 'Username đã có tài khoản.',
    invalid_site_or_device: 'Site/thiết bị chỉ gồm chữ, số, "_" và "-" (tối đa 48 ký tự).',
    last_admin: 'Không thể hạ quyền/khoá/xoá admin cuối cùng (hoặc chính bạn).',
    user_not_found: 'Không tìm thấy người dùng.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
    step_up_required: 'Cần xác nhận bằng vân tay / Authenticator.',
    reauth_required: 'Hãy đăng xuất rồi đăng nhập lại trước khi thao tác quản trị.',
    admin_not_allowlisted: 'Username không nằm trong ADMIN_USERNAMES.',
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
    { id: 'iot-hub', title: 'Gateway (nhiều device con)' },
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

  function typeOptionsHtml(selected, excludeHub) {
    return typeCatalog
      .filter((t) => !excludeHub || t.id !== 'iot-hub')
      .map((t) => `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''}>${esc(t.id)} — ${esc(t.title)}</option>`)
      .join('');
  }

  function fillProfileSelect() {
    const sel = $('#hw-profile');
    if (!sel) return;
    const cur = sel.value || 'iot-hub';
    sel.innerHTML = typeOptionsHtml(cur, false);
    if (![...sel.options].some((o) => o.value === cur)) sel.value = typeCatalog[0]?.id || 'generic';
    else sel.value = cur;
    toggleSeedBox();
  }

  function toggleSeedBox() {
    const box = $('#hw-seed-box');
    if (!box) return;
    const hub = $('#hw-profile')?.value === 'iot-hub';
    box.hidden = !hub;
    if (hub && !$('#hw-seed-rows')?.children.length) addSeedRow();
  }

  function addSeedRow(pre = {}) {
    const host = $('#hw-seed-rows');
    if (!host) return;
    const row = document.createElement('div');
    row.className = 'hw-seed-row';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 1.2fr 1.4fr auto;gap:8px;margin-bottom:8px;align-items:end';
    row.innerHTML = `
      <label style="margin:0">childId<input class="seed-id" autocapitalize="off" placeholder="pump1" value="${esc(pre.childId || '')}"></label>
      <label style="margin:0">Loại<select class="seed-type">${typeOptionsHtml(pre.type || 'pump', true)}</select></label>
      <label style="margin:0">Tên hiển thị<input class="seed-title" placeholder="Bơm nước" value="${esc(pre.title || '')}"></label>
      <button type="button" class="fit danger seed-rm" title="Xoá">×</button>`;
    host.appendChild(row);
    row.querySelector('.seed-rm').onclick = () => row.remove();
  }

  function collectSeedUiMeta() {
    if ($('#hw-profile')?.value !== 'iot-hub') return undefined;
    const seed = [];
    $('#hw-seed-rows')?.querySelectorAll('.hw-seed-row').forEach((row) => {
      const childId = row.querySelector('.seed-id')?.value.trim();
      const type = row.querySelector('.seed-type')?.value;
      const title = row.querySelector('.seed-title')?.value.trim();
      if (!childId || !type) return;
      seed.push({ childId, type, title: title || undefined });
    });
    if (!seed.length) throw new Error('Gateway cần ít nhất một device con (nút + Thêm device con).');
    return { seed };
  }

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
    $('#hw-count').textContent = hwDevices.length;
    $('#hw-list').innerHTML = hwDevices.map((d) => `
      <div class="hw" data-site="${esc(d.site)}" data-device="${esc(d.device)}">
        <div><b>${esc(d.label || `${d.site}/${d.device}`)}</b>
          ${d.claimed ? '<span class="tag">đã gắn</span>' : '<span class="tag viewer">chưa gắn</span>'}
          <small><code>${esc(d.site)}</code> / <code>${esc(d.device)}</code>
            ${d.profile ? ` · <b>${esc(d.profile)}</b>` : ' · <span class="tag viewer">chưa profile</span>'}
            ${d.note ? ` · ${esc(d.note)}` : ''}
            ${d.claimedUsername ? ` · user ${esc(d.claimedUsername)}` : ''}
            · tạo ${esc(fmtTs(d.createdAt))}</small></div>
        <div class="acts">
          <button data-hw="qr">Xem / in QR</button>
          <button data-hw="reissue">Phát hành lại tem</button>
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
    const j = await api('/api/admin/hardware');
    hwDevices = j.devices || [];
    const cfg = $('#hw-cfg');
    if (cfg) {
      cfg.textContent = j.configured
        ? '✓ Khoá ký QR đã cấu hình.'
        : '⚠ Chưa có CLAIM_ROOT_* — không tạo được tem. Chạy: node cloud/app/scripts/provision-device-qr.js gen-keys';
      cfg.style.color = j.configured ? 'var(--ok)' : 'var(--warn)';
    }
    renderHw();
  }

  async function loadTypes() {
    try {
      const r = await fetch(`${base}/api/v1/ui/types`);
      const data = await r.json();
      if (r.ok && Array.isArray(data.types) && data.types.length) {
        typeCatalog = data.types.map((t) => ({ id: t.id, title: t.title || t.id }));
      }
    } catch { /* giữ fallback */ }
    fillProfileSelect();
  }

  async function load() {
    try {
      await loadTypes();
      const j = await api('/api/admin/users');
      roles = j.roles; users = j.users; scopesAll = j.scopes || scopesAll;
      $('#n-scopes').innerHTML = scopeBoxes(scopesAll, 'data-nsc');
      $('#n-role').innerHTML = roleOpts('operator');
      render();
      await loadHw();
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

  $('#hw-profile')?.addEventListener('change', toggleSeedBox);
  $('#hw-seed-add')?.addEventListener('click', () => addSeedRow());

  $('#hw-add').onclick = () => run(async () => {
    const site = $('#hw-site').value.trim();
    const device = $('#hw-dev').value.trim() || 'gw01';
    if (!site) throw new Error('Nhập mã nhà máy (site).');
    const profile = $('#hw-profile')?.value || 'generic';
    const uiMeta = collectSeedUiMeta();
    const r = await api('/api/admin/hardware', 'POST', {
      site,
      device,
      label: $('#hw-label').value.trim(),
      note: $('#hw-note').value.trim(),
      profile,
      uiMeta,
    });
    $('#hw-label').value = '';
    $('#hw-note').value = '';
    const rows = $('#hw-seed-rows');
    if (rows) rows.innerHTML = '';
    toggleSeedBox();
    await loadHw();
    await showQr(r);
  }, 'Đã thêm thiết bị. In tem QR và dán lên máy.');

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
    } else if (b.dataset.hw === 'reissue') {
      const unclaim = d?.claimed && confirm('Thiết bị đã gắn user. Phát hành lại sẽ huỷ liên kết claim (user cũ phải quét tem mới)?');
      if (d?.claimed && !unclaim) return;
      if (!confirm('Tem cũ sẽ hết hiệu lực. Tiếp tục?')) return;
      run(async () => {
        const r = await api(`/api/admin/hardware/${encodeURIComponent(site)}/${encodeURIComponent(device)}/reissue`, 'POST', { unclaim: Boolean(d?.claimed) });
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

  $('#n-add').onclick = () => run(async () => {
    await api('/api/admin/users', 'POST', {
      username: $('#n-phone').value.trim() || undefined,
      scopes: [...document.querySelectorAll('[data-nsc]')].filter((c) => c.checked).map((c) => c.dataset.nsc),
      role: $('#n-role').value, site: $('#n-site').value.trim() || undefined, device: $('#n-dev').value.trim() || undefined,
    });
    $('#n-phone').value = '';
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
      if (!u.disabled && !confirm(`Khoá ${u.username}? Họ bị đăng xuất và mất quyền MQTT ngay.`)) return;
      run(() => api(`/api/admin/users/${id}`, 'PATCH', { disabled: !u.disabled }), u.disabled ? 'Đã mở khoá.' : 'Đã khoá.');
    } else if (b.dataset.act === 'logout') {
      if (confirm(`Đăng xuất ${u.username} khỏi mọi thiết bị?`)) run(() => api(`/api/admin/users/${id}`, 'PATCH', { revokeSessions: true }), 'Đã đăng xuất mọi máy.');
    } else if (b.dataset.act === 'site') {
      const site = prompt('Site mới:', u.site); if (!site) return;
      const device = prompt('Thiết bị mới:', u.device); if (!device) return;
      run(() => api(`/api/admin/users/${id}`, 'PATCH', { site, device }), 'Đã đổi site/thiết bị.');
    } else if (b.dataset.act === 'del') {
      if (!confirm(`Xoá vĩnh viễn ${u.username}? Không thể hoàn tác (nên dùng Khoá nếu chỉ tạm dừng).`)) return;
      run(() => api(`/api/admin/users/${id}`, 'DELETE'), 'Đã xoá.');
    }
  });

  load();
})();
