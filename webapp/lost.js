'use strict';
/*
 * Báo mất trộm gateway (server: hwBlock.js + hwReports.js). Chủ báo → gateway bị KHOÁ TẠM ngay → admin duyệt (giữ khoá) hoặc từ chối.
 * Cần yếu tố thứ hai (TOTP / Face ID) như điều khiển: Security.unlock. Chủ tìm lại máy thì huỷ báo cáo chưa duyệt → mở khoá.
 */
(function () {
  const S = window.Security; if (!S) return;
  const { api, unlock, LS } = S;
  const sec = document.getElementById('lost-sec'); const body = document.getElementById('lost-body'); const msgEl = document.getElementById('lost-msg');
  if (!sec || !body) return;
  S.addErrors({
    forbidden_gateway: 'Gateway này không thuộc tài khoản của bạn.',
    already_reported: 'Gateway này đã được báo mất và đang chờ admin duyệt.',
    already_blocked: 'Gateway này đã bị khoá.',
    report_limit: 'Báo mất quá nhiều lần hôm nay — liên hệ nhà cung cấp.',
    no_hardware: 'Gateway chưa gắn thiết bị thật nên chưa khoá được.',
    not_pending: 'Báo cáo đã được xử lý.',
    gateway_locked: 'Gateway đang bị khoá (báo mất) — không gửi được lệnh.',
  });
  const esc = (t) => S.escHtml(String(t ?? ''));
  const STATE = { pending: 'đã khoá tạm — chờ admin duyệt', approved: 'đã khoá (admin đã duyệt)', rejected: 'admin từ chối', cancelled: 'bạn đã huỷ', released: 'đã mở khoá' };
  const msg = (t, bad) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.style.color = bad ? 'var(--bad,#c33)' : ''; } };

  /** Gọi API cần step-up: nếu server đòi yếu tố thứ hai thì mở khoá rồi thử lại (giống control.js). */
  async function withStepUp(method, path, payload) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await api(method, path, payload);
      if (r.status === 401 && r.body.error === 'step_up_required') {
        LS.del('ctl');
        if (attempt < 2 && await unlock({ ...r.body, title: 'Xác nhận báo mất gateway' })) continue;
        return { ok: false, body: { error: 'cancelled' } };
      }
      return r;
    }
    return { ok: false, body: { error: 'cancelled' } };
  }

  async function load() {
    body.innerHTML = '<span class="muted">Đang tải…</span>';
    const [d, l] = await Promise.all([api('GET', '/api/v1/ui/dashboard'), api('GET', '/api/gateway/lost')]);
    if (!d.ok) { body.textContent = ''; return msg(S.errText(d.body.error), true); }
    const reports = l.ok ? l.body.reports || [] : [];
    const gws = (d.body.gateways || []).filter((g) => g.site && g.device);
    if (!gws.length) { body.innerHTML = '<span class="muted">Chưa có gateway nào.</span>'; return; }
    body.innerHTML = gws.map((g) => {
      const key = `${g.site}/${g.device}`;
      const mine = reports.filter((r) => r.site === g.site && r.device === g.device);
      const open = mine.find((r) => r.status === 'pending' || r.status === 'approved');
      const last = mine[0];
      return `<div class="row" style="justify-content:space-between;gap:8px;border-top:1px solid var(--line,#333);padding:8px 0">
        <div><b>${esc(key)}</b>${open ? `<div class="muted">⚠ ${esc(STATE[open.status])} · ${new Date(open.createdAt).toLocaleString('vi-VN')}</div>`
          : last ? `<div class="muted">Báo cáo gần nhất: ${esc(STATE[last.status] || last.status)}</div>` : ''}</div>
        ${open && open.status === 'pending' ? `<button class="fit" data-cancel="${open.id}">Đã tìm thấy — mở khoá</button>`
          : open ? '' : `<button class="fit danger" data-lost="${esc(key)}">Báo mất</button>`}
      </div>`;
    }).join('');
    body.querySelectorAll('[data-lost]').forEach((b) => b.addEventListener('click', async () => {
      const gw = b.dataset.lost;
      if (!confirm(`Báo mất gateway ${gw}?\n\nGateway bị KHOÁ NGAY: dừng đọc/điều khiển, từ chối mọi đăng nhập và ghép PC. Admin sẽ xem xét; bạn có thể huỷ nếu tìm lại được máy.`)) return;
      const reason = prompt('Lý do / hoàn cảnh (vd. mất ở kho, bị trộm ngày…):', '');
      if (reason === null) return;
      const r = await withStepUp('POST', '/api/gateway/lost', { gw, reason });
      if (r.ok) msg('Đã báo mất: gateway bị khoá tạm, chờ admin duyệt.'); else if (r.body.error !== 'cancelled') msg(S.errText(r.body.error), true);
      load().catch(() => {});
    }));
    body.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Bạn đã tìm thấy gateway? Huỷ báo mất sẽ mở khoá gateway.')) return;
      const r = await withStepUp('POST', `/api/gateway/lost/${b.dataset.cancel}/cancel`, {});
      if (r.ok) msg('Đã huỷ báo mất: gateway được mở khoá.'); else if (r.body.error !== 'cancelled') msg(S.errText(r.body.error), true);
      load().catch(() => {});
    }));
  }
  sec.addEventListener('toggle', () => { if (sec.open) load().catch((e) => msg(String(e.message || e), true)); });
}());
