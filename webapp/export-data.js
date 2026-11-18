'use strict';
/* Xuất dữ liệu lịch sử (Cài đặt → Thông tin tài khoản → "Xuất dữ liệu lịch sử"): CSV (Excel) · TXT (Tab) · JSON.
   Gọi GET /api/history/export — server tự giới hạn trong thời hạn lưu của gói và đúng thiết bị của tài khoản. */
(function () {
  const go = document.getElementById('exp-go');
  if (!go) return;
  const $ = (id) => document.getElementById(id);
  const msg = $('exp-msg');
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.style.color = bad ? 'var(--bad, #c0392b)' : ''; } };
  const day = (d) => d.toISOString().slice(0, 10);
  const from = $('exp-from'), to = $('exp-to');
  if (from && to) { const now = new Date(); to.value = day(now); from.value = day(new Date(now.getTime() - 7 * 86400e3)); }

  // Danh sách gateway của tài khoản (lấy từ dashboard) để chọn gateway cần xuất; mặc định = gateway đang xem nếu biết.
  const gwSel = $('exp-gw');
  async function loadGateways() {
    const s = session(); if (!gwSel || !s || !s.token) return;
    try {
      const r = await fetch(`${s.apiBase || location.origin}/api/v1/ui/dashboard`, { headers: { Authorization: `Bearer ${s.token}` } });
      if (!r.ok) return;
      const dash = await r.json();
      const seen = new Map();
      for (const d of dash.devices || []) if (d.gw && d.gw.site && d.gw.device) seen.set(d.gw.site + '/' + d.gw.device, d.gw);
      if (!seen.size) { gwSel.hidden = true; return; }
      let cfg = {}; try { cfg = JSON.parse(localStorage.getItem('cfg')) || {}; } catch { /* */ }
      gwSel.innerHTML = '';
      for (const [k, g] of seen) { const o = document.createElement('option'); o.value = k; o.textContent = `Gateway ${g.device} (${g.site})`; gwSel.appendChild(o); }
      const cur = cfg.site && cfg.dev ? cfg.site + '/' + cfg.dev : '';
      if (seen.has(cur)) gwSel.value = cur;
    } catch { /* không có danh sách: dùng thiết bị mặc định của tài khoản */ }
  }
  loadGateways();
  document.querySelector('[data-tab="set"]')?.addEventListener('click', loadGateways);

  function session() { try { return JSON.parse(localStorage.getItem('session')); } catch { return null; } }

  go.addEventListener('click', async () => {
    const s = session();
    if (!s || !s.token) { say('Cần đăng nhập để xuất dữ liệu.', true); return; }
    const fmt = $('exp-fmt').value;
    const since = from.value ? new Date(from.value + 'T00:00:00').getTime() : 0;
    const until = to.value ? new Date(to.value + 'T00:00:00').getTime() + 86400e3 : Date.now();
    if (until <= since) { say('Ngày kết thúc phải sau ngày bắt đầu.', true); return; }
    go.disabled = true; say('Đang tạo tệp…');
    try {
      const base = s.apiBase || location.origin;
      const r = await fetch(`${base}/api/history/export?format=${encodeURIComponent(fmt)}&since=${since}&until=${until}${gwSel && !gwSel.hidden && gwSel.value ? '&site=' + encodeURIComponent(gwSel.value.split('/')[0]) + '&gw=' + encodeURIComponent(gwSel.value.split('/')[1]) : ''}`, { headers: { Authorization: `Bearer ${s.token}` } });
      if (r.status === 401) { say('Phiên đăng nhập hết hạn — đăng nhập lại.', true); return; }
      if (r.status === 403) { say('Tài khoản này không có quyền xuất dữ liệu.', true); return; }
      if (!r.ok) { say('Không xuất được (' + r.status + ').', true); return; }
      const blob = await r.blob();
      const ext = fmt === 'tsv' ? 'txt' : fmt;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `plciot-${from.value || 'all'}_${to.value || 'now'}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      say(`Đã tải tệp (${Math.max(1, Math.round(blob.size / 1024))} KB). Dữ liệu chỉ nằm trong thời hạn lưu của gói.`);
    } catch (e) { say('Lỗi mạng: ' + (e && e.message ? e.message : e), true); }
    finally { go.disabled = false; }
  });
}());
