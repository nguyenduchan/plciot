'use strict';
/*
 * Logic điều khiển gateway (server: cloud/app/src/gatewayLogic.js, docs/GATEWAY-LOGIC.md).
 *   - Cài đặt → "Logic điều khiển gateway": BẢNG logic đang chạy trên từng gateway (chỉ xem) + đề xuất của quản trị viên
 *     (hàng thay đổi tô màu) → chủ trạm DUYỆT (Face ID / TOTP như lệnh điều khiển) hoặc TỪ CHỐI.
 *   - ⏰ cạnh nút bật/tắt (devices.js): chủ trạm tự cài HẸN GIỜ cho DO của board — phần DUY NHẤT webapp sửa được.
 */
(function () {
  const S = window.Security; if (!S) return;
  const { api, unlock, LS } = S;
  S.addErrors({
    logic_not_pending: 'Đề xuất này đã được xử lý hoặc đã có đề xuất mới hơn.',
    logic_rev_conflict: 'Logic trên gateway vừa thay đổi. Tải lại rồi thử lại.',
    logic_rejected: 'Gateway từ chối chương trình (sai cấu hình) — báo quản trị viên.',
    logic_unknown: 'Gateway chưa báo logic đang chạy (firmware cũ hoặc chưa kết nối).',
    timer_invalid: 'Hẹn giờ không hợp lệ: cần giờ bật hoặc giờ tắt (HH:MM), tối đa 4 mốc.',
    gateway_timeout: 'Gateway không phản hồi — kiểm tra gateway đang có mạng rồi thử lại.',
    not_mcu: 'Chỉ board Waveshare có logic chạy trên gateway.',
  });
  const esc = (t) => S.escHtml(String(t ?? ''));
  const when = (ts) => (ts ? new Date(ts).toLocaleString('vi-VN') : '—');
  const DAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

  async function withStepUp(method, path, payload, title) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await api(method, path, payload);
      if (r.status === 401 && r.body.error === 'step_up_required') {
        LS.del('ctl');
        if (attempt < 2 && await unlock({ ...r.body, title })) continue;
        return { ok: false, body: { error: 'cancelled' } };
      }
      return r;
    }
    return { ok: false, body: { error: 'cancelled' } };
  }

  // ------------------------------------------------------------------ bộ nhớ: logic từng gateway (cho nút ⏰)
  const cache = new Map();   // "site/device" → body của GET /api/v1/gateway-logic
  const timerText = (list) => (list || []).map((t) => `${t.On || ''}${t.On && t.Off ? '–' : ''}${t.Off ? (t.On ? t.Off : `tắt ${t.Off}`) : ''}${t.Date ? ` (${t.Date.slice(8, 10)}/${t.Date.slice(5, 7)})` : ''}`).join(', ');   // mốc 1 lần kèm ngày

  /** devices.js gọi khi vẽ nút bật/tắt: {ch, text} nếu là DO của board có logic. */
  function timerOf(gw, child, key) {
    const L = cache.get(gw);
    if (!L?.current?.keys) return null;
    for (const [ch, k] of Object.entries(L.current.keys)) {
      if (k === `${child}.${key}`) return { ch, text: timerText(L.current.timers?.[ch]) };   // ch = số DO (board) hoặc "thiết bị.field" (gateway PC)
    }
    return null;
  }

  const names = new Map();   // "site/device" → tên hiển thị do chủ đặt
  const nameOf = (gw) => names.get(gw) || gw.split('/')[1] || gw;
  const keepNames = (list) => { for (const x of list || []) if (x.name) names.set(`${x.site}/${x.device}`, x.name); };

  async function fetchLogic(gw) {
    const r = await api('GET', `/api/v1/gateway-logic?gw=${encodeURIComponent(gw)}`);
    if (r.ok) cache.set(gw, r.body);
    return r;
  }

  async function preload() {
    if (!LS.get('session', null)?.token) return;
    const g = await api('GET', '/api/v1/remote-support');
    if (!g.ok) return;
    keepNames(g.body.gateways);
    await Promise.all((g.body.gateways || []).map((x) => fetchLogic(`${x.site}/${x.device}`)));
    window.DevicesUi?.render?.();
  }

  // ------------------------------------------------------------------ bảng
  function table(rows, changed = []) {
    const ch = new Set(changed);
    const tr = rows.map((r) => `<tr class="${ch.has(r.ch) ? 'chg' : ''}">
      <td data-h="Đầu ra"><b>${esc(r.name)}</b>${typeof r.ch === 'number' && r.name !== `DO${r.ch}` ? ` <span class="muted">DO${r.ch}</span>` : (typeof r.ch === 'string' && r.name !== r.ch ? ` <span class="muted">${esc(r.ch)}</span>` : '')}${ch.has(r.ch) ? ' <span style="color:#d97706">● thay đổi</span>' : ''}</td>
      <td data-h="Khi điều khiển">${r.user.map(esc).join('<br>')}</td>
      <td data-h="Hẹn giờ">${r.timer.length ? r.timer.map(esc).join('<br>') : '<span class="muted">—</span>'}</td>
      <td data-h="Khi mất mạng">${esc(r.offline)}</td></tr>`).join('');
    return `<div class="gl-wrap"><table class="gl-tbl"><thead><tr><th>Đầu ra</th><th>Khi điều khiển (luôn áp dụng)</th><th>Hẹn giờ</th><th>Khi mất mạng</th></tr></thead><tbody>${tr}</tbody></table></div>`;
  }

  const STATUS = { applied: '✅ Đã áp dụng', rejected: '✖ Đã từ chối', failed: '⚠ Lỗi', superseded: '↷ Bị thay bằng đề xuất mới' };

  function card(L) {
    const gw = `${L.site}/${L.device}`;
    if (!L.current && !L.pending && L.kind !== 'mcu') return '';   // gateway PC bản cũ (chưa báo logic): bỏ qua
    const cur = L.current;
    const p = L.pending;
    const prop = p ? `<div class="gl-prop">
        <div><b>Đề xuất thay đổi</b> <span class="muted">· ${esc(p.by)} · ${esc(when(p.createdAt))}</span></div>
        ${p.note ? `<div style="margin:4px 0">${esc(p.note)}</div>` : ''}
        <div class="muted" style="margin:4px 0">Logic sau khi duyệt (hàng tô màu = thay đổi${p.changed.length ? `: ${p.changed.map((c) => `DO${c}`).join(', ')}` : ' — không có hàng nào khác bản đang chạy'}):</div>
        ${table(p.rows, p.changed)}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
          <button class="primary fit" data-gl-ok="${esc(gw)}" data-id="${p.id}">Duyệt và áp dụng</button>
          <button class="fit" data-gl-no="${esc(gw)}" data-id="${p.id}">Từ chối</button>
        </div>
        <div class="muted" style="margin-top:4px">Duyệt cần xác nhận như lệnh điều khiển. Gateway phải đang có mạng; áp dụng ngay, không khởi động lại.</div>
      </div>` : '';
    const hist = (L.history || []).map((h) => `<div class="muted" style="font-size:13px">${esc(when(h.decidedAt || h.createdAt))} · ${esc(STATUS[h.status] || h.status)} · ${esc(h.by)}${h.note ? ` — ${esc(h.note)}` : ''}${h.decidedBy ? ` · ${esc(h.decidedBy)}` : ''}${h.result ? ` · ${esc(h.result)}` : ''}</div>`).join('');
    return `<div style="border-top:1px solid var(--line,#333);padding:10px 0">
      <div><b>${esc(nameOf(gw))}</b> <span class="muted">· ID ${esc(L.device)} ${cur ? `· bản ${cur.rev} · cập nhật ${esc(when(cur.updatedAt))}` : '· chưa nhận được logic từ gateway'}</span></div>
      ${prop}
      ${cur ? `<div class="muted" style="margin-top:6px">Đang chạy:</div>${table(cur.rows)}` : ''}
      ${hist ? `<details style="margin-top:4px"><summary class="muted">Lịch sử đề xuất</summary>${hist}</details>` : ''}
    </div>`;
  }

  const body = document.getElementById('gl-body'), msgEl = document.getElementById('gl-msg'), sec = document.getElementById('gl-sec');
  const msg = (t, bad) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.style.color = bad ? 'var(--bad,#c33)' : ''; } };

  async function loadSection() {
    if (!body) return;
    body.innerHTML = '<span class="muted">Đang tải…</span>';
    const g = await api('GET', '/api/v1/remote-support');
    if (!g.ok) { body.textContent = ''; return msg(S.errText(g.body.error), true); }
    keepNames(g.body.gateways);
    const rs = await Promise.all((g.body.gateways || []).map((x) => fetchLogic(`${x.site}/${x.device}`)));
    const html = rs.filter((r) => r.ok).map((r) => card(r.body)).join('');
    body.innerHTML = html || '<span class="muted">Chưa có gateway nào báo logic (cần firmware board 0.3.9+ hoặc phần mềm gateway PC mới).</span>';
    body.querySelectorAll('[data-gl-ok]').forEach((b) => b.addEventListener('click', async () => {
      const gw = b.dataset.glOk;
      if (!confirm(`Áp dụng logic mới cho gateway ${nameOf(gw)}?\n\nCác hàng tô màu sẽ thay đổi cách gateway tự bật/tắt thiết bị (kể cả khi mất mạng).`)) return;
      b.disabled = true;
      const r = await withStepUp('POST', '/api/v1/gateway-logic/approve', { gw, id: Number(b.dataset.id) }, 'Xác nhận duyệt logic gateway');
      b.disabled = false;
      if (!r.ok) return msg(r.body.message ? `${S.errText(r.body.error)} (${r.body.message})` : S.errText(r.body.error), true);
      msg(`Đã áp dụng logic mới cho ${gw} (bản ${r.body.rev}).`);
      loadSection(); window.DevicesUi?.render?.();
    }));
    body.querySelectorAll('[data-gl-no]').forEach((b) => b.addEventListener('click', async () => {
      const gw = b.dataset.glNo;
      if (!confirm(`Từ chối đề xuất đổi logic của gateway ${gw}? Gateway giữ nguyên logic đang chạy.`)) return;
      const r = await api('POST', '/api/v1/gateway-logic/reject', { gw, id: Number(b.dataset.id) });
      if (!r.ok) return msg(S.errText(r.body.error), true);
      msg('Đã từ chối đề xuất.');
      loadSection();
    }));
  }
  sec?.addEventListener('toggle', () => { if (sec.open) loadSection(); });

  // ------------------------------------------------------------------ hộp hẹn giờ (nút ⏰)
  // Kiểu báo thức iPhone: chọn ngày = LẶP LẠI các ngày đó; KHÔNG chọn ngày nào = chạy 1 LẦN (lần tới của giờ đã đặt).
  // Mốc 1 lần gửi {Date:"YYYY-MM-DD", Days:[]} theo giờ địa phương của gateway (tz của chương trình).
  const pad = (n) => String(n).padStart(2, '0');
  const localNow = (tzMin) => new Date(Date.now() + tzMin * 60000);   // đọc bằng getUTC*: giờ địa phương của gateway
  const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
  /** Ngày chạy của mốc 1 lần: hôm nay nếu giờ (bật, không có thì tắt) còn ở phía trước, không thì ngày mai. */
  function onceDate(at, tzMin) {
    const n = localNow(tzMin);
    const [h, m] = at.split(':').map(Number);
    if (h * 60 + m <= n.getUTCHours() * 60 + n.getUTCMinutes()) n.setUTCDate(n.getUTCDate() + 1);
    return ymd(n);
  }
  function repText(row, tzMin) {
    const days = [...row.querySelectorAll('.gl-days input:checked')].map((x) => Number(x.value));
    if (days.length === 7) return 'Lặp lại: hằng ngày';
    if (days.length) return `Lặp lại: ${days.map((d) => DAYS[d - 1]).join(', ')}`;
    const at = row.querySelector('.t-on').value || row.querySelector('.t-off').value;
    const old = row.dataset.date;
    if (old && row.dataset.dirty !== '1') return old < ymd(localNow(tzMin)) ? `1 lần — đã chạy ngày ${dmy(old)}` : `1 lần — ngày ${dmy(old)}`;
    return at ? `Không lặp lại — chạy 1 lần, ngày ${dmy(onceDate(at, tzMin))}` : 'Không lặp lại — chạy 1 lần';
  }
  function timerRow(t = {}) {
    const days = t.Date ? [] : t.Days || [1, 2, 3, 4, 5, 6, 7];
    return `<div class="gl-trow" ${t.Date ? `data-date="${esc(t.Date)}"` : ''}>
      <label>Bật <input type="time" class="t-on" value="${esc(t.On || '')}"></label>
      <label>Tắt <input type="time" class="t-off" value="${esc(t.Off || '')}"></label>
      <span class="gl-days">${DAYS.map((d, i) => `<label class="${days.includes(i + 1) ? 'on' : ''}"><input type="checkbox" value="${i + 1}" ${days.includes(i + 1) ? 'checked' : ''}>${d}</label>`).join('')}</span>
      <button type="button" class="fit t-del" title="Xoá mốc">✕</button>
      <div class="muted t-rep" style="font-size:12px;flex-basis:100%"></div></div>`;
  }

  async function openTimer(gw, ch, label) {
    const L = cache.get(gw) || (await fetchLogic(gw)).body;
    const list = L?.current?.timers?.[ch] || [];
    const tz = Number(L?.current?.tz ?? 420);
    const box = document.createElement('div');
    box.className = 'gl-modal';
    box.innerHTML = `<div role="dialog" aria-modal="true">
      <h3 style="margin:0 0 4px">⏰ Hẹn giờ — ${esc(label)}</h3>
      <div class="muted" style="font-size:13px">Gateway tự bật/tắt đúng giờ, kể cả khi mất mạng. Giữa hai mốc bạn vẫn bật/tắt tay được. Để trống "Bật" hoặc "Tắt" nếu chỉ cần một chiều. Không chọn ngày nào = chạy 1 lần.</div>
      <div class="t-list">${list.map(timerRow).join('')}</div>
      <button type="button" class="fit t-add" style="margin:6px 0">+ Thêm mốc</button>
      <div class="t-err" style="color:var(--bad,#c33);min-height:1.2em"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="fit t-cancel">Huỷ</button><button type="button" class="primary fit t-save">Lưu xuống gateway</button></div>
    </div>`;
    document.body.append(box);
    const lst = box.querySelector('.t-list'), err = box.querySelector('.t-err');
    const close = () => box.remove();
    const refresh = () => lst.querySelectorAll('.gl-trow').forEach((r) => { r.querySelector('.t-rep').textContent = repText(r, tz); });
    refresh();
    lst.addEventListener('input', (e) => { const r = e.target.closest('.gl-trow'); if (r) { r.dataset.dirty = '1'; refresh(); } });
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.closest('.t-cancel')) return close();
      if (e.target.closest('.t-del')) return e.target.closest('.gl-trow').remove();
      if (e.target.closest('.t-add')) { if (lst.children.length < 4) { lst.insertAdjacentHTML('beforeend', timerRow({ On: '06:00', Off: '18:00', Days: [] })); refresh(); } else err.textContent = 'Tối đa 4 mốc.'; return; }   // mốc mới: 1 lần (như báo thức mới trên iPhone)
      const dl = e.target.closest('.gl-days label');
      if (dl) { setTimeout(() => { dl.classList.toggle('on', dl.querySelector('input').checked); refresh(); }); }
    });
    box.querySelector('.t-save').addEventListener('click', async () => {
      const timers = [];
      for (const row of lst.querySelectorAll('.gl-trow')) {
        const on = row.querySelector('.t-on').value, off = row.querySelector('.t-off').value;
        const days = [...row.querySelectorAll('.gl-days input:checked')].map((x) => Number(x.value));
        if (!on && !off) { err.textContent = 'Mỗi mốc cần giờ bật hoặc giờ tắt.'; return; }
        if (on && on === off) { err.textContent = 'Giờ bật và giờ tắt phải khác nhau.'; return; }
        const t = {}; if (on) t.On = on; if (off) t.Off = off;
        if (!days.length) {   // chạy 1 lần: giữ ngày cũ nếu không sửa mốc, không thì lần tới của giờ đã đặt
          t.Date = row.dataset.date && row.dataset.dirty !== '1' ? row.dataset.date : onceDate(on || off, tz);
          t.Days = [];
        } else if (days.length < 7) t.Days = days;
        timers.push(t);
      }
      const btn = box.querySelector('.t-save');
      btn.disabled = true; btn.textContent = 'Đang gửi…'; err.textContent = '';
      const r = await withStepUp('PUT', '/api/v1/gateway-logic/timer', { gw, id: String(ch), timers }, 'Xác nhận đổi hẹn giờ');
      btn.disabled = false; btn.textContent = 'Lưu xuống gateway';
      if (!r.ok) { err.textContent = r.body.error === 'cancelled' ? 'Đã huỷ.' : S.errText(r.body.error); return; }
      close();
      await fetchLogic(gw);
      window.DevicesUi?.render?.();
      window.toast?.(timers.length ? 'Đã lưu hẹn giờ xuống gateway.' : 'Đã xoá hẹn giờ.');
    });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.dw-timer');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    openTimer(b.dataset.gw, b.dataset.ch, b.dataset.label || b.dataset.ch);
  });

  window.GwLogic = { timerOf, reload: preload };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(preload, 1500)); else setTimeout(preload, 1500);
})();
