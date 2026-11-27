'use strict';
/*
 * "Cho phép hỗ trợ từ xa" (server: remoteAdmin.js). Chủ gateway bật thì quản trị viên hệ thống cài đặt được gateway TỪ XA
 * bằng app GatewayAdmin (cấu hình thiết bị, logic khi mất mạng…) — như kỹ thuật viên ngồi tại chỗ. Mặc định TẮT; tắt có hiệu lực ngay.
 * Webapp KHÔNG có phần cài đặt logic: chỉ công tắc đồng ý này.
 */
(function () {
  const S = window.Security; if (!S) return;
  const { api } = S;
  const sec = document.getElementById('rs-sec'); const body = document.getElementById('rs-body'); const msgEl = document.getElementById('rs-msg');
  if (!sec || !body) return;
  S.addErrors({ not_owner: 'Gateway này không thuộc tài khoản của bạn.' });
  const esc = (t) => S.escHtml(String(t ?? ''));
  const msg = (t, bad) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.style.color = bad ? 'var(--bad,#c33)' : ''; } };

  async function load() {
    body.innerHTML = '<span class="muted">Đang tải…</span>';
    const r = await api('GET', '/api/v1/remote-support');
    if (!r.ok) { body.textContent = ''; return msg(S.errText(r.body.error), true); }
    const gws = r.body.gateways || [];
    if (!gws.length) { body.innerHTML = '<span class="muted">Chưa có gateway nào.</span>'; return; }
    body.innerHTML = gws.map((g) => `<label class="row" style="justify-content:space-between;gap:8px;border-top:1px solid var(--line,#333);padding:8px 0;cursor:pointer">
        <span><b>${esc(g.name || g.device)}</b><span class="muted" style="display:block">ID ${esc(g.device)} · ${g.allowed ? 'Đang cho phép hỗ trợ từ xa' : 'Không cho phép'}</span></span>
        <input type="checkbox" data-gw="${esc(`${g.site}/${g.device}`)}" ${g.allowed ? 'checked' : ''} style="width:22px;height:22px">
      </label>`).join('');
    body.querySelectorAll('[data-gw]').forEach((cb) => cb.addEventListener('change', async () => {
      const [site, device] = cb.dataset.gw.split('/');
      if (cb.checked && !confirm(`Cho phép quản trị viên cài đặt gateway ${cb.dataset.gw} từ xa?\n\nQuản trị viên sẽ xem và sửa được cấu hình gateway (thiết bị, logic khi mất mạng…) như kỹ thuật viên tại chỗ. Bạn tắt lại lúc nào cũng được, có hiệu lực ngay.`)) { cb.checked = false; return; }
      cb.disabled = true;
      const p = await api('PUT', '/api/v1/remote-support', { site, device, allowed: cb.checked });
      cb.disabled = false;
      if (!p.ok) { cb.checked = !cb.checked; return msg(S.errText(p.body.error), true); }
      msg(p.body.allowed ? `Đã cho phép hỗ trợ từ xa cho ${cb.dataset.gw}.` : `Đã tắt hỗ trợ từ xa cho ${cb.dataset.gw}.`);
      load();
    }));
  }
  sec.addEventListener('toggle', () => { if (sec.open) load(); });
})();
