'use strict';
/* Console vận hành IoT: gói subscribe, thiết bị MQTTS, tenant, DB. Chỉ admin. */
(function () {
  const $ = (s) => document.querySelector(s);
  let session = null;
  try { session = JSON.parse(localStorage.getItem('session')); } catch {}
  if (!session?.token || session.demo) { location.replace('login.html'); return; }
  const base = session.apiBase || location.origin;

  const ERR = {
    forbidden: 'Không có quyền admin.',
    unauthorized: 'Phiên hết hạn.',
    step_up_required: 'Cần xác nhận vân tay / Authenticator.',
    reauth_required: 'Đăng nhập lại trước khi thao tác.',
    unknown_plan: 'Gói không hợp lệ.',
    tenant_exists: 'Tenant đã tồn tại.',
    invalid_tenant_id: 'Id tenant không hợp lệ.',
    tenant_required: 'Cần tenant id.',
    invalid_site_or_device: 'Site/device chỉ chữ số _ -',
    device_not_found: 'Không thấy thiết bị.',
    rate_limited: 'Thao tác quá nhanh.',
    admin_network_denied: 'Chưa mở từ PC nhà / IP allow / CF Access. Đánh dấu PC nhà trên Tổng quan, hoặc SSH tunnel.',
    device_id_required: 'Trình duyệt chưa có mã thiết bị. Mở lại trang trên HTTPS và thử lại.',
    device_proof_required: 'Cần chữ ký thiết bị (HTTPS + trình duyệt hỗ trợ). Thử lại trên đúng PC nhà.',
    device_proof_invalid: 'Chữ ký thiết bị không khớp — không dùng được máy giả / UUID copy.',
    home_pc_limit: 'Đã đủ số PC nhà. Gỡ một máy cũ trước.',
    unknown_flag: 'Cờ không hợp lệ.',
    open_required: 'Thiếu open true/false.',
    login_paused: 'Đăng nhập đang tạm dừng.',
    remote_control_paused: 'Điều khiển từ xa đang tạm dừng.',
    partner_api_paused: 'Partner API đang tạm dừng.',
    deploy_disabled: 'Chưa bật DEPLOY_ENABLED trên server.',
    deploy_busy: 'Đang đồng bộ — chờ xong.',
    deploy_failed: 'Đồng bộ thất bại.',
    repo_not_mounted: 'Chưa mount repo Git vào container (/repo).',
  };

  function msg(text, cls) { const m = $('#msg'); m.textContent = text || ''; m.className = cls || ''; }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function deviceIdHeader() {
    try {
      const id = localStorage.getItem('devId') && JSON.parse(localStorage.getItem('devId'));
      return id ? { 'X-Device-Id': String(id) } : {};
    } catch { return {}; }
  }

  async function api(path, method = 'GET', body, retried) {
    let ctlTok = null;
    try { ctlTok = JSON.parse(localStorage.getItem('ctl'))?.token; } catch {}
    let payload = body ? { ...body } : undefined;
    let devHeaders = deviceIdHeader();
    // Mọi ghi admin: ký device-proof (chống giả PC nhà bằng copy UUID)
    const needProof = method !== 'GET' && method !== 'HEAD' && window.SecurityDevice?.proof;
    if (needProof) {
      try {
        const uid = session.userId || (JSON.parse(localStorage.getItem('session') || '{}').userId);
        const d = await window.SecurityDevice.proof(uid || 'admin', path);
        payload = { ...(payload || {}), publicKey: d.publicKey, deviceProof: d.deviceProof };
        devHeaders = { 'X-Device-Id': d.deviceId };
      } catch (e) {
        if (path.includes('home-pc') || path.includes('/ops/')) throw new Error('device_proof_required');
      }
    }
    const r = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...devHeaders,
        ...(ctlTok ? { 'X-Control-Token': ctlTok } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && data.error === 'step_up_required' && !retried && window.Ctl) {
      try { localStorage.removeItem('ctl'); } catch {}
      if (await window.Ctl.unlock(data)) return api(path, method, body, true);
    }
    if (!r.ok) throw new Error(ERR[data.error] || data.error || `Lỗi ${r.status}`);
    return data;
  }

  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    ['overview', 'monitor', 'subs', 'devices', 'tenants', 'policy', 'db'].forEach((t) => {
      const el = $(`#tab-${t}`);
      if (el) el.classList.toggle('hidden', t !== name);
    });
    if (name === 'overview') loadOverview();
    if (name === 'monitor') { loadMonitor(); loadDeploy(); }
    if (name === 'subs') loadSubs();
    if (name === 'devices') loadDevices();
    if (name === 'tenants') loadTenants();
    if (name === 'policy') loadPolicy();
    if (name === 'db') loadDb();
  }

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  async function loadOverview() {
    try {
      const j = await api('/api/admin/ops/overview');
      $('#stats').innerHTML = [
        ['users', j.users, 'Tài khoản'],
        ['active', j.activeUsers, 'Đang mở'],
        ['devices', j.devices, 'Thiết bị IoT'],
        ['tenants', j.tenants, 'Tenant'],
        ['exp', j.expiredPlans, 'Gói hết hạn'],
        ['ev', j.history?.total ?? 0, 'Sự kiện MQTT'],
      ].map(([, n, l]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('');
      $('#ingest-help').textContent =
        `Ingest: yêu cầu thiết bị đã biết = ${j.ingest.requireKnown}; gói còn hạn = ${j.ingest.requireActiveSub}. `
        + `Namespace ưu tiên: ${j.contract?.preferredNs || 'plc'}.`;
      await loadHomePc();
    } catch (e) { msg(e.message, 'err'); }
  }

  async function loadHomePc() {
    try {
      const h = await api('/api/admin/ops/home-pc');
      const st = $('#home-pc-status');
      const btn = $('#home-pc-trust');
      if (h.isHomePc) {
        st.innerHTML = '<span class="tag ok">PC nhà</span> ' + esc(h.hint);
        if (btn) btn.textContent = 'PC này đã là máy nhà ✓';
      } else {
        st.textContent = h.hint || 'Chưa đánh dấu.';
        if (btn) btn.textContent = 'Đánh dấu PC này là máy nhà';
      }
      $('#home-pc-list').innerHTML = (h.pcs || []).length
        ? '<b>Đã tin:</b> ' + h.pcs.map((p) =>
          `<div class="row-card"><code>${esc(p.deviceId.slice(0, 8))}…</code> ${esc(p.label || '')}
            <button type="button" data-revoke-home="${esc(p.deviceId)}">Gỡ</button></div>`).join('')
        : '<span class="help">Chưa có PC nhà nào.</span>';
    } catch (e) { $('#home-pc-status').textContent = e.message; }
  }

  $('#home-pc-trust')?.addEventListener('click', async () => {
    try {
      await api('/api/admin/ops/home-pc/trust', 'POST', { label: 'PC nhà' });
      msg('Đã đánh dấu PC nhà (khoá thiết bị đã gắn).', 'ok');
      loadHomePc();
    } catch (e) { msg(e.message, 'err'); }
  });

  $('#home-pc-list')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke-home]');
    if (!b || !confirm('Gỡ PC nhà này?')) return;
    try {
      await api(`/api/admin/ops/home-pc/${encodeURIComponent(b.dataset.revokeHome)}`, 'DELETE');
      msg('Đã gỡ.', 'ok');
      loadHomePc();
    } catch (err) { msg(err.message, 'err'); }
  });

  let monTimer = null;
  function fmtUptime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m ${s % 60}s`;
  }

  async function loadMonitor() {
    try {
      const j = await api('/api/admin/ops/monitor');
      const c = j.counts || {};
      const s = j.server || {};
      const pulse = j.live?.ingestOpen ? 'pulse' : 'pulse bad';
      $('#mon-stats').innerHTML = [
        [c.users, 'Users'],
        [c.activeUsers, 'Active'],
        [c.devices, 'Devices'],
        [c.activeBlocks, 'Blocks'],
        [c.denies1h, 'Deny/1h'],
        [c.securityFails24h, 'Fail/24h'],
      ].map(([n, l]) => `<div class="stat"><b>${esc(n ?? 0)}</b><span>${esc(l)}</span></div>`).join('');
      $('#mon-server').innerHTML =
        `<span class="${pulse}"></span>Process OK · uptime <b>${esc(fmtUptime(s.uptimeSec))}</b>`
        + ` · RSS ${esc(s.memoryMb?.rss)} MB · heap ${esc(s.memoryMb?.heap)} MB · Node ${esc(s.node)} · pid ${esc(s.pid)}`;
      const cfg = j.config || {};
      $('#mon-cfg').textContent =
        `Env: REGISTRATION_OPEN=${cfg.registrationEnv}; AUTO_GRANT=${cfg.subscribeAutoGrant}; `
        + `INGEST_KNOWN=${cfg.ingestRequireKnown}; RATE_LIMIT_API=${cfg.rateLimitApi}. `
        + `Reject cửa sổ hiện tại: ${JSON.stringify(j.live?.rejectWindow || {})}`;
      $('#mon-flags').innerHTML = (j.flags || []).map((f) => {
        const tag = f.open
          ? '<span class="tag ok">ĐANG BẬT</span>'
          : '<span class="tag bad">ĐÃ TẮT</span>';
        const src = f.source === 'manual' ? 'thủ công' : 'env';
        return `<div class="sw" data-flag="${esc(f.key)}">
          <div class="meta"><b>${esc(f.label)}</b>
            <span class="help">${tag} · nguồn ${esc(src)}${f.danger ? ' · nhạy cảm' : ''}
              ${f.updatedAt ? ' · ' + new Date(f.updatedAt).toLocaleString() : ''}</span>
          </div>
          <div class="acts">
            <button type="button" data-flag-set="${esc(f.key)}" data-open="${f.open ? '0' : '1'}" class="${f.open ? 'danger' : 'primary'}">${f.open ? 'Tắt' : 'Bật'}</button>
            ${f.source === 'manual' ? `<button type="button" data-flag-reset="${esc(f.key)}">Về env</button>` : ''}
          </div>
        </div>`;
      }).join('') || '<p class="help">Không có cờ.</p>';
      $('#mon-attack-stats').innerHTML = [
        [c.denies24h, 'MQTT deny 24h'],
        [c.denies1h, 'MQTT deny 1h'],
        [c.securityFails24h, 'Auth/control fail'],
        [c.blockedDevices, 'Device blocked'],
        [c.disabledUsers, 'User khoá'],
      ].map(([n, l]) => `<div class="stat"><b>${esc(n ?? 0)}</b><span>${esc(l)}</span></div>`).join('');
      const ips = j.security?.topIps || [];
      $('#mon-top-ips').innerHTML = ips.length
        ? `<table><tr><th>IP nghi ngờ</th><th>Lần (24h)</th></tr>${
          ips.map((r) => `<tr><td><code>${esc(r.ip)}</code></td><td>${esc(r.n)}</td></tr>`).join('')
        }</table>`
        : '<p class="help">Chưa thấy IP fail đáng kể (24h).</p>';
      const reasons = j.security?.byDenyReason || [];
      $('#mon-deny-reasons').innerHTML = reasons.length
        ? `<table><tr><th>Lý do deny MQTT</th><th>Số</th></tr>${
          reasons.map((r) => `<tr><td>${esc(r.reason)}</td><td>${esc(r.n)}</td></tr>`).join('')
        }</table>`
        : '<p class="help">Chưa có deny MQTT 24h.</p>';
      const audits = j.security?.recentAudit || [];
      $('#mon-audit').innerHTML = `<table><tr><th>Thời gian</th><th>Sự kiện</th><th>User</th><th>IP</th><th>Chi tiết</th></tr>${
        audits.map((e) => {
          const bad = /fail|denied|unauthorised|rate_limited|pair_fail/.test(e.event);
          return `<tr>
            <td>${new Date(e.ts).toLocaleString()}</td>
            <td>${bad ? `<span class="tag bad">${esc(e.event)}</span>` : esc(e.event)}</td>
            <td>${esc(e.userId ?? '')}</td>
            <td><code>${esc(e.ip || '')}</code></td>
            <td>${esc(e.detail || '')}</td>
          </tr>`;
        }).join('')
      }</table>`;
      const denies = j.security?.recentDenies || [];
      $('#mon-denies').innerHTML = `<table><tr><th>Thời gian</th><th>Lý do</th><th>Nơi</th><th>Kind</th></tr>${
        denies.map((e) => `<tr>
          <td>${new Date(e.ts).toLocaleString()}</td>
          <td>${esc(e.reason)}</td>
          <td>${esc([e.tenantId, e.site, e.device].filter(Boolean).join('/'))}</td>
          <td>${esc(e.kind || '')}</td>
        </tr>`).join('')
      }</table>`;
      if (monTimer) clearInterval(monTimer);
      monTimer = setInterval(() => {
        if (!$('#tab-monitor')?.classList.contains('hidden')) loadMonitor();
      }, 30000);
    } catch (e) { msg(e.message, 'err'); }
  }

  $('#mon-refresh')?.addEventListener('click', () => loadMonitor());

  async function loadDeploy() {
    try {
      const j = await api('/api/admin/ops/deploy');
      const el = $('#deploy-status');
      const log = $('#deploy-log');
      if (!j.enabled) {
        el.innerHTML = '<span class="tag mut">TẮT</span> Đặt <code>DEPLOY_ENABLED=true</code> và mount repo tại <code>/repo</code> (xem docs).';
        $('#deploy-webapp').disabled = true;
        $('#deploy-full').disabled = true;
        return;
      }
      $('#deploy-webapp').disabled = Boolean(j.busy);
      $('#deploy-full').disabled = Boolean(j.busy);
      const r = j.repo || {};
      const bits = [
        j.busy ? '<span class="tag warn">ĐANG CHẠY</span>' : '<span class="tag ok">Sẵn sàng</span>',
        r.available
          ? `branch <code>${esc(r.branch)}</code> · <code>${esc(r.head)}</code>${r.behind ? ' · <span class="tag warn">có bản mới trên remote</span>' : ''}`
          : `Git: ${esc(r.error || 'không sẵn sàng')}`,
        j.shellVersion ? `shell <code>${esc(j.shellVersion)}</code>` : '',
      ];
      if (j.last?.at) {
        bits.push(`lần cuối ${new Date(j.last.at).toLocaleString()} · ${j.last.ok ? 'OK' : 'Lỗi'} · ${esc(j.last.mode || '')}`);
      }
      el.innerHTML = bits.filter(Boolean).join(' · ');
      if (j.last?.log?.length) {
        log.classList.add('show');
        log.textContent = j.last.log.join('\n');
      }
      if (r.describe) {
        el.innerHTML += `<div class="help" style="margin-top:6px">${esc(r.describe)}</div>`;
      }
    } catch (e) {
      $('#deploy-status').textContent = e.message;
    }
  }

  async function runDeploy(mode) {
    const label = mode === 'full' ? 'pull + rebuild container app' : 'git pull + sync bundle';
    if (!confirm(`Chạy ${label}?\nCần Passkey. User sẽ nhận bản mới khi refresh.`)) return;
    try {
      msg('Đang đồng bộ…', '');
      const r = await api('/api/admin/ops/deploy', 'POST', { mode });
      msg(r.hint || 'Đã đồng bộ.', 'ok');
      const log = $('#deploy-log');
      log.classList.add('show');
      log.textContent = JSON.stringify({
        mode: r.mode,
        head: r.after?.head,
        bundleVersion: r.bundleVersion,
        bundlesUpdated: r.bundlesUpdated,
        pendingRebuild: r.pendingRebuild,
      }, null, 2);
      if (r.pendingRebuild) {
        msg('Đã kéo code; server đang rebuild — chờ 1–2 phút rồi F5.', 'ok');
      }
      loadDeploy();
      loadMonitor();
    } catch (e) { msg(e.message, 'err'); loadDeploy(); }
  }

  $('#deploy-webapp')?.addEventListener('click', () => runDeploy('webapp'));
  $('#deploy-full')?.addEventListener('click', () => runDeploy('full'));
  $('#deploy-refresh')?.addEventListener('click', () => loadDeploy());

  $('#mon-flags')?.addEventListener('click', async (e) => {
    const set = e.target.closest('[data-flag-set]');
    const reset = e.target.closest('[data-flag-reset]');
    try {
      if (set) {
        const open = set.dataset.open === '1';
        const key = set.dataset.flagSet;
        if (!open && key === 'login_open'
          && !confirm('Tắt đăng nhập sẽ khoá OTP/Passkey cho mọi người (kể cả bạn). Chỉ bật lại được qua Console nếu còn session, hoặc SSH. Tiếp tục?')) {
          return;
        }
        await api(`/api/admin/ops/flags/${encodeURIComponent(key)}`, 'PATCH', { open });
        msg(open ? 'Đã bật.' : 'Đã tắt.', 'ok');
        loadMonitor();
      } else if (reset) {
        await api(`/api/admin/ops/flags/${encodeURIComponent(reset.dataset.flagReset)}`, 'PATCH', { reset: true });
        msg('Đã về mặc định env.', 'ok');
        loadMonitor();
      }
    } catch (err) { msg(err.message, 'err'); }
  });

  function planSelect(sel) {
    return ['', 'monitor', 'pro', 'factory'].map((p) =>
      `<option value="${p}"${p === (sel || '') ? ' selected' : ''}>${p || '(legacy)'}</option>`).join('');
  }

  async function loadSubs() {
    try {
      const j = await api('/api/admin/ops/users');
      $('#plan-catalog').innerHTML = (j.plans || []).map((p) =>
        `<div><code>${esc(p.id)}</code> — ${esc(p.label)}; control=${p.remoteControl}; lưu=${p.unlimited ? '∞' : p.retentionDays + ' ngày'}</div>`).join('');
      $('#sub-count').textContent = j.users.length;
      $('#sub-list').innerHTML = j.users.map((u) => {
        const s = u.subscription || {};
        const exp = s.expiresAt ? new Date(s.expiresAt).toISOString().slice(0, 10) : 'never';
        const tags = [
          s.active ? '<span class="tag ok">active</span>' : '<span class="tag bad">hết hạn</span>',
          s.remoteControl ? '<span class="tag">control</span>' : '<span class="tag mut">monitor</span>',
          u.disabled ? '<span class="tag bad">khoá</span>' : '',
        ].join(' ');
        return `<div class="row-card" data-id="${u.id}">
          <div><b>${esc(u.phoneLocal || u.phone)}</b> ${tags}
            <div class="help">${esc(u.site)}/${esc(u.device)} · gói <code>${esc(s.plan)}</code> · hết ${esc(exp)} · lưu ${s.unlimited ? '∞' : (s.retentionDays ?? '?')}d · mqtt <code>${esc(u.mqttUser || '—')}</code></div>
          </div>
          <div class="acts">
            <select data-plan>${planSelect(s.plan === 'legacy' ? '' : s.plan)}</select>
            <input data-exp type="date" title="Hết hạn" value="${s.expiresAt ? new Date(s.expiresAt).toISOString().slice(0, 10) : ''}">
            <button data-act="grant" type="button" class="primary">Gán gói</button>
            <button data-act="off" type="button">Tắt control</button>
            <button data-act="on" type="button">Bật control</button>
          </div>
        </div>`;
      }).join('') || '<p class="help">Chưa có user.</p>';
    } catch (e) { msg(e.message, 'err'); }
  }

  $('#sub-list')?.addEventListener('click', async (e) => {
    const row = e.target.closest('.row-card');
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.dataset.act;
    try {
      if (act === 'grant') {
        const plan = row.querySelector('[data-plan]').value;
        if (!plan) return msg('Chọn gói monitor|pro|factory', 'err');
        const expiresAt = row.querySelector('[data-exp]').value || 'never';
        await api(`/api/admin/ops/users/${id}/plan`, 'POST', { plan, expiresAt });
        msg('Đã gán gói.', 'ok'); loadSubs();
      } else if (act === 'off') {
        await api(`/api/admin/ops/users/${id}/plan`, 'POST', { remoteControl: false });
        msg('Đã tắt điều khiển từ xa.', 'ok'); loadSubs();
      } else if (act === 'on') {
        await api(`/api/admin/ops/users/${id}/plan`, 'POST', { remoteControl: true });
        msg('Đã bật điều khiển từ xa.', 'ok'); loadSubs();
      }
    } catch (err) { msg(err.message, 'err'); }
  });

  async function loadDevices() {
    try {
      const j = await api('/api/admin/ops/devices');
      $('#dev-list').innerHTML = j.devices.map((d) => `
        <div class="row-card">
          <div><b>${esc(d.tenantId)}/${esc(d.site)}/${esc(d.device)}</b>
            ${d.onlineHint ? '<span class="tag ok">online?</span>' : '<span class="tag mut">idle</span>'}
            <span class="tag">${esc(d.topicNs)}</span>
            <div class="help">mqtt <code>${esc(d.mqttUser)}</code> · profile ${esc(d.profile || '—')} · status ${esc(d.lastStatus || '—')}
              · tele ${d.lastTelemetryAt ? new Date(d.lastTelemetryAt).toLocaleString() : '—'}</div>
          </div>
          <div class="acts">
            <button type="button" data-rev="${esc(d.tenantId)}|${esc(d.site)}|${esc(d.device)}" class="danger">Thu hồi</button>
          </div>
        </div>`).join('') || '<p class="help">Chưa có thiết bị — bấm Provision ở trên.</p>';
    } catch (e) { msg(e.message, 'err'); }
  }

  $('#d-add')?.addEventListener('click', async () => {
    try {
      const body = {
        tenantId: $('#d-tenant').value.trim(),
        site: $('#d-site').value.trim(),
        device: $('#d-dev').value.trim(),
        profile: $('#d-profile').value,
        ns: $('#d-ns').value,
      };
      const r = await api('/api/admin/ops/devices', 'POST', body);
      const cred = $('#d-cred');
      cred.classList.add('show');
      cred.textContent = JSON.stringify({
        mqtts: r.mqtt?.mqtts,
        wss: r.mqtt?.wss,
        username: r.mqtt?.username,
        password: r.mqtt?.password,
        topicBase: r.device?.topicBase,
        topics: r.device?.topics,
      }, null, 2);
      msg('Đã cấp credential — copy ngay (password không hiện lại nếu rotate).', 'ok');
      loadDevices();
    } catch (e) { msg(e.message, 'err'); }
  });

  $('#dev-list')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rev]');
    if (!b || !confirm('Thu hồi thiết bị này?')) return;
    const [tenant, site, device] = b.dataset.rev.split('|');
    try {
      await api(`/api/admin/ops/devices/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/${encodeURIComponent(device)}`, 'DELETE');
      msg('Đã thu hồi.', 'ok'); loadDevices();
    } catch (err) { msg(err.message, 'err'); }
  });

  async function loadTenants() {
    try {
      const j = await api('/api/admin/ops/tenants');
      $('#ten-list').innerHTML = j.tenants.map((t) => `
        <div class="row-card" data-tid="${esc(t.id)}">
          <div><b>${esc(t.id)}</b> — ${esc(t.name || '')}
            <span class="tag">${esc(t.subPlan || 'no-plan')}</span>
            <div class="help">${t.devices || 0} thiết bị · API key ${t.hasApiKey ? '✓' : '—'} · hết hạn ${t.subExpiresAt ? new Date(t.subExpiresAt).toISOString().slice(0, 10) : '—'}</div>
          </div>
          <div class="acts">
            <select data-tplan>${planSelect(t.subPlan || '')}</select>
            <input data-texp type="date">
            <button type="button" data-act="tgrant" class="primary">Gán gói</button>
            <button type="button" data-act="trot">Rotate API key</button>
          </div>
        </div>`).join('');
    } catch (e) { msg(e.message, 'err'); }
  }

  $('#t-add')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/ops/tenants', 'POST', {
        id: $('#t-id').value.trim(), name: $('#t-name').value.trim(),
      });
      const c = $('#t-cred');
      c.classList.add('show');
      c.textContent = `API key (một lần):\n${r.apiKey}`;
      msg('Đã tạo tenant.', 'ok'); loadTenants();
    } catch (e) { msg(e.message, 'err'); }
  });

  $('#ten-list')?.addEventListener('click', async (e) => {
    const row = e.target.closest('.row-card');
    if (!row) return;
    const id = row.dataset.tid;
    const act = e.target.dataset.act;
    try {
      if (act === 'tgrant') {
        const plan = row.querySelector('[data-tplan]').value;
        if (!plan) return msg('Chọn gói', 'err');
        const expiresAt = row.querySelector('[data-texp]').value || 'never';
        await api(`/api/admin/ops/tenants/${encodeURIComponent(id)}/plan`, 'POST', { plan, expiresAt });
        msg('Đã gán gói tenant.', 'ok'); loadTenants();
      } else if (act === 'trot') {
        const r = await api(`/api/admin/ops/tenants/${encodeURIComponent(id)}/rotate-key`, 'POST', {});
        const c = $('#t-cred');
        c.classList.add('show');
        c.textContent = `API key mới:\n${r.apiKey}`;
        msg('Đã xoay API key.', 'ok');
      }
    } catch (err) { msg(err.message, 'err'); }
  });

  async function loadPolicy() {
    try {
      const j = await api('/api/admin/ops/policy');
      const c = j.config || {};
      $('#pol-cfg').innerHTML = `
        <div>Thiết bị đã biết: <code>${esc(c.requireKnown)}</code> · Gói còn hạn: <code>${esc(c.requireActiveSub)}</code></div>
        <div>Payload tối đa: <code>${esc(c.maxPayloadBytes)}</code> byte · Flood: <code>${esc(c.flood?.max)}</code> msg / ${esc(c.flood?.windowMs / 1000)}s</div>
        <div>Auto-block sau <code>${esc(c.autoBlock?.n)}</code> deny / ${esc((c.autoBlock?.windowMs || 0) / 1000)}s, hết hạn block ${esc((c.autoBlock?.ttlMs || 0) / 3600000)}h</div>`;
      $('#pol-blocks').innerHTML = (j.blocks || []).map((b) => `
        <div class="row-card">
          <div><span class="tag bad">${esc(b.scope)}</span> <span class="tag mut">${esc(b.mode)}</span>
            <b>${esc([b.tenant_id, b.site, b.device, b.topic_prefix].filter(Boolean).join(' / '))}</b>
            <div class="help">${esc(b.reason)} · ${b.expires_at ? ('hết ' + new Date(b.expires_at).toLocaleString()) : 'vĩnh viễn'} · bởi ${esc(b.created_by)}</div>
          </div>
          <div class="acts"><button type="button" data-unblk="${esc(b.id)}">Gỡ chặn</button></div>
        </div>`).join('') || '<p class="help">Chưa có block thủ công.</p>';
      $('#pol-events').innerHTML = `<table><tr><th>Thời gian</th><th>Lý do</th><th>Nơi</th><th>Kind</th></tr>${
        (j.recentDenies || []).map((e) => `<tr>
          <td>${new Date(e.ts).toLocaleString()}</td>
          <td>${esc(e.reason)}</td>
          <td>${esc([e.tenantId, e.site, e.device].filter(Boolean).join('/'))}</td>
          <td>${esc(e.kind || '')}</td>
        </tr>`).join('')
      }</table>`;
    } catch (e) { msg(e.message, 'err'); }
  }

  $('#p-add')?.addEventListener('click', async () => {
    try {
      await api('/api/admin/ops/policy/blocks', 'POST', {
        scope: $('#p-scope').value,
        tenantId: $('#p-tenant').value.trim() || undefined,
        site: $('#p-site').value.trim() || undefined,
        device: $('#p-dev').value.trim() || undefined,
        topicPrefix: $('#p-topic').value.trim() || undefined,
        reason: $('#p-reason').value.trim() || 'manual',
        hard: $('#p-hard').checked,
      });
      msg('Đã thêm chặn.', 'ok');
      loadPolicy();
    } catch (e) { msg(e.message, 'err'); }
  });

  $('#pol-blocks')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-unblk]');
    if (!b) return;
    try {
      await api(`/api/admin/ops/policy/blocks/${encodeURIComponent(b.dataset.unblk)}`, 'DELETE');
      msg('Đã gỡ chặn.', 'ok');
      loadPolicy();
    } catch (err) { msg(err.message, 'err'); }
  });

  async function loadDb() {
    try {
      const j = await api('/api/admin/ops/db');
      $('#db-tables').innerHTML = `<table><tr><th>Bảng</th><th>Số dòng</th></tr>${
        j.tables.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.rows)}</td></tr>`).join('')
      }</table>`;
      $('#db-kinds').innerHTML = `<table><tr><th>Kind</th><th>Số</th><th>Cuối</th></tr>${
        (j.byKind || []).map((k) => `<tr><td>${esc(k.kind)}</td><td>${esc(k.n)}</td><td>${k.lastTs ? new Date(k.lastTs).toLocaleString() : ''}</td></tr>`).join('')
      }</table>`;
      $('#db-top').innerHTML = `<table><tr><th>Site</th><th>Device</th><th>Msgs</th><th>Cuối</th></tr>${
        (j.topDevices || []).map((d) => `<tr><td>${esc(d.site)}</td><td>${esc(d.device)}</td><td>${esc(d.n)}</td><td>${d.lastTs ? new Date(d.lastTs).toLocaleString() : ''}</td></tr>`).join('')
      }</table>`;
    } catch (e) { msg(e.message, 'err'); }
  }

  // boot
  api('/api/me').then((me) => {
    if (!me.dashboardAdmin) {
      msg('Console chỉ dành cho tài khoản trong ADMIN_DASHBOARD_PHONES / ADMIN_PHONES.', 'err');
      return;
    }
    showTab('overview');
  }).catch((e) => { msg(e.message, 'err'); });
})();
