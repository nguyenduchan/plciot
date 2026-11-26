'use strict';
/*
 * Lịch sử hệ thống (server: mcuOta.js). Minh bạch cho chủ trạm: phiên bản đang chạy, bản cập nhật nhà phát triển đề xuất,
 * ai duyệt / ai cài đặt từ xa / gateway báo gì (ghép PC lạ, nạp firmware chưa duyệt hoặc sai chữ ký, tự quay về bản cũ, chế độ an toàn…).
 * Board Waveshare chỉ cài bản mới trong 15 phút sau khi CHỦ TRẠM bấm "Cho phép cập nhật" (cần Face ID / TOTP như điều khiển).
 */
(function () {
  const S = window.Security; if (!S) return;
  const { api, unlock, LS } = S;
  const sec = document.getElementById('sh-sec'); const body = document.getElementById('sh-body'); const msgEl = document.getElementById('sh-msg');
  if (!sec || !body) return;
  S.addErrors({
    forbidden_gateway: 'Gateway này không thuộc tài khoản của bạn.',
    not_mcu: 'Gateway PC tự cập nhật qua phần mềm gateway (nút Cập nhật trên máy).',
    no_release: 'Chưa có bản firmware mới trên máy chủ.',
  });
  const esc = (t) => S.escHtml(String(t ?? ''));
  const msg = (t, bad) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.style.color = bad ? 'var(--bad,#c33)' : ''; } };
  const when = (ts) => (ts ? new Date(ts).toLocaleString('vi-VN') : '—');
  const TYPE = {
    ota_approve: 'Duyệt cập nhật', radmin_rpc: 'Cài đặt từ xa', radmin_consent_on: 'Bật hỗ trợ từ xa', radmin_consent_off: 'Tắt hỗ trợ từ xa',
    gateway_lost_report: 'Báo mất', ota_rollback: 'Quay về bản cũ', ota_badsig: 'Firmware sai chữ ký', ota_denied: 'Từ chối cập nhật',
    pc_paired: 'Ghép PC quản trị', pc_pair_request: 'PC lạ xin ghép', login_fail: 'Đăng nhập sai', safe_mode: 'Chế độ an toàn', factory_reset: 'Xoá cấu hình',
  };

  async function withStepUp(method, path, payload) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await api(method, path, payload);
      if (r.status === 401 && r.body.error === 'step_up_required') {
        LS.del('ctl');
        if (attempt < 2 && await unlock({ ...r.body, title: 'Xác nhận cho phép cập nhật firmware' })) continue;
        return { ok: false, body: { error: 'cancelled' } };
      }
      return r;
    }
    return { ok: false, body: { error: 'cancelled' } };
  }

  function card(h) {
    const kind = h.kind === 'mcu' ? 'Waveshare' : 'Gateway PC';
    const upd = h.updateAvailable && h.release
      ? `<div style="border:1px solid var(--line,#444);border-radius:10px;padding:10px;margin:8px 0">
          <b>Bản mới: ${esc(h.release.version)}</b> <span class="muted">${esc(when(h.release.builtAt && Date.parse(h.release.builtAt)))}</span>
          ${h.release.notes ? `<div class="muted" style="white-space:pre-wrap;margin:6px 0">${esc(h.release.notes)}</div>` : ''}
          <div class="muted" style="margin:6px 0">Gateway chỉ cài trong 15 phút sau khi bạn cho phép; trước khi khởi động lại các đầu ra được TẮT; bản mới không chạy ổn thì tự quay về bản cũ.</div>
          <button class="primary fit" data-ota="${esc(`${h.site}/${h.device}`)}">Cho phép cập nhật (15 phút)</button>
        </div>`
      : (h.kind === 'mcu' && h.release ? '<div class="muted">Đang chạy bản mới nhất.</div>' : '');
    const ev = (h.events || []).slice(0, 30).map((e) => `<div style="display:flex;gap:8px;padding:4px 0;border-top:1px dashed var(--line,#333)">
        <span class="muted" style="flex:0 0 auto;min-width:9.5em">${esc(when(e.ts))}</span>
        <span style="${e.alert ? 'color:var(--bad,#e5484d)' : ''}">${e.alert ? '🔴 ' : ''}<b>${esc(TYPE[e.type] || e.type)}</b> · ${esc(e.text)}</span></div>`).join('');
    return `<div style="border-top:1px solid var(--line,#333);padding:10px 0">
      <div><b>${esc(`${h.site}/${h.device}`)}</b> <span class="muted">· ${kind} · phiên bản ${esc(h.version || '—')} · liên lạc lần cuối ${esc(when(h.lastSeen))}</span></div>
      ${upd}
      <div style="margin-top:6px">${ev || '<span class="muted">Chưa có sự kiện.</span>'}</div>
    </div>`;
  }

  async function load() {
    body.innerHTML = '<span class="muted">Đang tải…</span>';
    const g = await api('GET', '/api/v1/remote-support');
    if (!g.ok) { body.textContent = ''; return msg(S.errText(g.body.error), true); }
    const gws = g.body.gateways || [];
    if (!gws.length) { body.innerHTML = '<span class="muted">Chưa có gateway nào.</span>'; return; }
    const hs = await Promise.all(gws.map((x) => api('GET', `/api/v1/system-history?gw=${encodeURIComponent(`${x.site}/${x.device}`)}`)));
    body.innerHTML = hs.filter((h) => h.ok).map((h) => card(h.body)).join('');
    body.querySelectorAll('[data-ota]').forEach((b) => b.addEventListener('click', async () => {
      const gw = b.dataset.ota;
      if (!confirm(`Cho phép gateway ${gw} cập nhật firmware trong 15 phút tới?\n\nGateway sẽ tự tải bản mới, kiểm chữ ký nhà phát triển rồi cài. Các đầu ra (bơm, van…) được TẮT trong lúc khởi động lại (~20 giây).`)) return;
      b.disabled = true;
      const r = await withStepUp('POST', '/api/v1/ota/approve', { gw });
      b.disabled = false;
      if (!r.ok) return msg(S.errText(r.body.error), true);
      msg(`Đã cho phép ${gw} cập nhật lên ${r.body.version} — gateway sẽ tự cài trong vài phút.`);
      setTimeout(load, 1500);
    }));
  }
  sec.addEventListener('toggle', () => { if (sec.open) load(); });
})();
