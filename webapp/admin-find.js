'use strict';
/* Admin → tab "Tìm kiếm": một ô tìm cho CẢ người dùng và gateway; mỗi kết quả là biểu mẫu sửa tại chỗ với mọi thông tin admin sửa được.
 * KHÔNG hiện / không cho sửa thông tin đăng nhập (tên đăng nhập, mật khẩu, passkey, TOTP, mã khôi phục, phiên đăng nhập).
 * Dùng lại các API sẵn có: PATCH /api/admin/users/:id, POST /api/admin/ops/users/:id/plan, PATCH /api/admin/hardware/:site/:device. */
(() => {
  const core = () => window.AdminCore;
  const $ = (s, r = document) => r.querySelector(s);
  const E = (v) => core().esc(v);
  let data = null, seq = 0;

  const SCOPE_LABEL = { telemetry: 'Số liệu', status: 'Trạng thái', ack: 'Phản hồi lệnh', history: 'Lịch sử giờ' };
  const dateOf = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
  const opts = (list, sel, valueOf = (x) => x.id ?? x, textOf = (x) => x.title ?? x.label ?? x, blank) => (blank != null ? `<option value="">${E(blank)}</option>` : '')
    + list.map((x) => `<option value="${E(valueOf(x))}"${String(valueOf(x)) === String(sel) ? ' selected' : ''}>${E(textOf(x))}</option>`).join('');
  const solVal = (id) => (id === 'basic' ? '' : id);
  const solOpts = (list, sel) => list.map((x) => `<option value="${E(solVal(x.id))}"${solVal(x.id) === (sel || '') ? ' selected' : ''}>${E(x.title)}</option>`).join('');

  function userCard(u, o) {
    const gws = u.gateways.length ? u.gateways.map((g) => `<span class="fd-chip" title="${E(g.label)}">${E(g.site)}/${E(g.device)}</span>`).join('') : '<span class="muted">chưa gắn gateway</span>';
    return `<article class="fd-card${u.disabled ? ' dis' : ''}" data-kind="user" data-id="${u.id}">
      <header><b>${E(u.username)}</b> <span class="tag ${E(u.role)}">${E(u.role)}</span>${u.disabled ? ' <span class="tag viewer">đã khoá</span>' : ''}
        <small>#${u.id} · tạo ${E(core().fmtTs(u.createdAt))} · tenant ${E(u.tenantId)} · ${u.widgets} widget · ${E(u.plan.label || u.plan.id)}${u.plan.active ? '' : ' (hết hạn / chưa kích hoạt)'}</small></header>
      <div class="fd-grid">
        <label>Vai trò<select data-f="role">${opts(o.roles, u.role)}</select></label>
        <label>Site<input data-f="site" value="${E(u.site)}" autocapitalize="off" autocomplete="off"></label>
        <label>Thiết bị (gateway chính)<input data-f="device" value="${E(u.device)}" autocapitalize="off" autocomplete="off"></label>
        <label>Gói dịch vụ<select data-f="plan">${opts(o.plans, u.plan.id, (x) => x.id, (x) => x.label || x.id)}</select></label>
        <label>Hạn gói (trống = không hạn)<input data-f="expires" type="date" value="${E(dateOf(u.plan.expiresAt))}"></label>
        <label class="fd-chk"><input data-f="remote" type="checkbox"${u.plan.remoteControl ? ' checked' : ''}> Cho điều khiển từ xa</label>
        <label class="fd-chk"><input data-f="disabled" type="checkbox"${u.disabled ? ' checked' : ''}> Khoá tài khoản</label>
      </div>
      <div class="fd-scopes"><span class="muted">Phạm vi xem:</span> ${o.scopes.map((sc) => `<label class="fd-chk"><input data-sc="${E(sc)}" type="checkbox"${u.scopes.includes(sc) ? ' checked' : ''}> ${E(SCOPE_LABEL[sc] || sc)}</label>`).join('')}</div>
      <div class="fd-gws"><span class="muted">Gateway đã gắn:</span> ${gws}</div>
      <footer><button data-act="save" class="primary fit">Lưu thay đổi</button><span class="fd-st" role="status"></span></footer>
    </article>`;
  }

  function gwCard(g, o) {
    const kids = g.children.length ? g.children.map((c) => `<span class="fd-chip" title="${c.fields} field">${E(c.name || c.id)}</span>`).join('') : '<span class="muted">chưa có setting</span>';
    return `<article class="fd-card" data-kind="gw" data-site="${E(g.site)}" data-device="${E(g.device)}">
      <header><b>${E(g.label || `${g.site}/${g.device}`)}</b> ${g.claimed ? '<span class="tag">đã gắn</span>' : '<span class="tag viewer">chưa gắn</span>'}${g.activated ? ' <span class="tag">đã kích hoạt</span>' : ''}
        <small><code>${E(g.site)}</code> / <code>${E(g.device)}</code> · tạo ${E(core().fmtTs(g.createdAt))}${g.claimedUsername ? ` · user ${E(g.claimedUsername)}` : ''}</small></header>
      <div class="fd-grid">
        <label>Tên gateway<input data-f="label" value="${E(g.label)}" maxlength="80" autocomplete="off"></label>
        <label>Ghi chú<input data-f="note" value="${E(g.note)}" maxlength="200" autocomplete="off"></label>
        <label>Profile<input data-f="profile" value="${E(g.profile)}" list="fd-profiles" autocapitalize="off" autocomplete="off"></label>
      </div>
      <div class="fd-ro"><span class="muted">ID máy</span> ${g.activatedHw ? `<code>${E(g.activatedHw)}</code>` : '—'} · <span class="muted">ID MQTT</span> ${g.mqttId ? `<code>${E(g.mqttId)}</code>${g.mqttStatus && g.mqttStatus !== 'active' ? ` (${E(g.mqttStatus)})` : ''}` : '—'}
        · <span class="muted">Setting</span> ${g.config ? `rev ${g.config.rev}: ${g.config.devices} thiết bị, ${g.config.fields} field` : 'chưa có'}</div>
      <div class="fd-gws"><span class="muted">Thiết bị con:</span> ${kids}</div>
      <footer><button data-act="save" class="primary fit">Lưu thay đổi</button><button data-act="qr" class="fit">Xem / in QR</button><span class="fd-st" role="status"></span></footer>
    </article>`;
  }

  function render() {
    const d = data; if (!d) return;
    const dl = $('#fd-profiles'); if (dl) dl.innerHTML = d.options.profiles.map((p) => `<option value="${E(p)}">`).join('');
    $('#fd-sum').textContent = `${d.users.length + d.moreUsers} người dùng · ${d.gateways.length + d.moreGateways} gateway khớp${d.q ? ` “${d.q}”` : ' (mới nhất)'} — tổng ${d.totals.users} người dùng, ${d.totals.gateways} gateway`;
    $('#fd-users').innerHTML = d.users.map((u) => userCard(u, d.options)).join('') || '<p class="help">Không có người dùng nào khớp.</p>';
    $('#fd-gws').innerHTML = d.gateways.map((g) => gwCard(g, d.options)).join('') || '<p class="help">Không có gateway nào khớp.</p>';
    $('#fd-more-u').textContent = d.moreUsers ? `… còn ${d.moreUsers} người dùng nữa, thu hẹp từ khoá để xem.` : '';
    $('#fd-more-g').textContent = d.moreGateways ? `… còn ${d.moreGateways} gateway nữa, thu hẹp từ khoá để xem.` : '';
  }

  async function search() {
    const my = ++seq;
    const r = await core().api(`/api/admin/search?limit=30&q=${encodeURIComponent($('#fd-q').value.trim())}`);
    if (my !== seq) return;   // đã có lần tìm mới hơn
    data = r; render();
  }
  const debounce = (fn, ms = 300) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };

  const status = (card, text, bad) => { const el = $('.fd-st', card); if (el) { el.textContent = text; el.style.color = bad ? 'var(--bad,#c4262e)' : 'var(--ok,#1f8a4c)'; } };
  const val = (card, f) => { const el = card.querySelector(`[data-f="${f}"]`); return el ? (el.type === 'checkbox' ? el.checked : el.value.trim()) : undefined; };

  async function saveUser(card) {
    const u = data.users.find((x) => String(x.id) === card.dataset.id); if (!u) return;
    const patch = {};
    for (const f of ['role', 'site', 'device']) { const v = val(card, f); if (v !== u[f]) patch[f] = v; }
    if (val(card, 'disabled') !== u.disabled) patch.disabled = val(card, 'disabled');
    const scopes = [...card.querySelectorAll('[data-sc]')].filter((c) => c.checked).map((c) => c.dataset.sc);
    if (scopes.length !== u.scopes.length || scopes.some((x) => !u.scopes.includes(x))) patch.scopes = scopes;
    const plan = val(card, 'plan'), exp = val(card, 'expires'), remote = val(card, 'remote');
    const planChanged = plan !== u.plan.id || exp !== dateOf(u.plan.expiresAt);
    const remoteChanged = remote !== Boolean(u.plan.remoteControl);
    if (!Object.keys(patch).length && !planChanged && !remoteChanged) return status(card, 'Không có thay đổi.');
    if (Object.keys(patch).length) await core().api(`/api/admin/users/${u.id}`, 'PATCH', patch);
    if (planChanged) await core().api(`/api/admin/ops/users/${u.id}/plan`, 'POST', { plan, expiresAt: exp || 'never' });
    if (remoteChanged) await core().api(`/api/admin/ops/users/${u.id}/plan`, 'POST', { remoteControl: remote });
  }

  async function saveGw(card) {
    const g = data.gateways.find((x) => x.site === card.dataset.site && x.device === card.dataset.device); if (!g) return;
    const patch = {};
    for (const f of ['label', 'note', 'profile']) { const v = val(card, f); if (v !== (g[f] || '')) patch[f] = v; }
    if (!Object.keys(patch).length) return status(card, 'Không có thay đổi.');
    await core().api(`/api/admin/hardware/${encodeURIComponent(g.site)}/${encodeURIComponent(g.device)}`, 'PATCH', patch);
  }

  function bind() {
    $('#fd-q')?.addEventListener('input', debounce(() => search().catch((e) => core().msg(e.message, 'err'))));
    $('#fd-res')?.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]'); const card = e.target.closest('.fd-card'); if (!b || !card) return;
      b.disabled = true; status(card, 'Đang lưu…');
      try {
        if (b.dataset.act === 'save') {
          await (card.dataset.kind === 'user' ? saveUser(card) : saveGw(card));
          if ($('.fd-st', card).textContent === 'Đang lưu…') { await search(); const again = document.querySelector(`.fd-card[data-kind="${card.dataset.kind}"][data-${card.dataset.kind === 'user' ? 'id' : 'site'}="${card.dataset.kind === 'user' ? card.dataset.id : card.dataset.site}"]`); if (again) status(again, 'Đã lưu.'); }
        } else if (b.dataset.act === 'qr') {
          const r = await core().api(`/api/admin/hardware/${encodeURIComponent(card.dataset.site)}/${encodeURIComponent(card.dataset.device)}/qr`);
          await core().showQr(r); status(card, '');
        }
      } catch (er) { status(card, er.message, true); } finally { b.disabled = false; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();

  window.AdminFind = { open() { search().catch((e) => core().msg(e.message, 'err')); $('#fd-q')?.focus(); } };
})();
