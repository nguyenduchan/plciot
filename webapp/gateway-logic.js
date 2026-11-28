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

  // ------------------------------------------------------------------ hộp hẹn giờ (nút ⏰) — GIỐNG BÁO THỨC ĐIỆN THOẠI
  // Danh sách: mỗi mốc = giờ lớn + "Lặp lại …" + CÔNG TẮC bật/tắt (gạt là lưu ngay, như báo thức). Chạm vào mốc → màn sửa: giờ bật,
  // giờ tắt, công tắc "Lặp lại" (bật → chọn ngày trong tuần, mặc định mọi ngày; tắt → chạy 1 LẦN vào lần tới của giờ đã đặt), Xoá, Huỷ/Lưu.
  // Mốc 1 lần đã chạy xong tự hiện công tắc TẮT (như báo thức "Không lặp lại" sau khi reo); bật lại → tính ngày mới.
  // Mốc đang TẮT chỉ lưu trên server (current.timersOff) — gateway chỉ nhận mốc đang bật (firmware cũ không hiểu cờ tắt).
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
  /** Mốc 1 lần đã qua (ngày trước hôm nay, hoặc hôm nay mà giờ cuối đã qua) = đã chạy xong. */
  function expired(t, tzMin) {
    if (!t.Date) return false;
    const n = localNow(tzMin), today = ymd(n);
    if (t.Date !== today) return t.Date < today;
    const last = [t.On, t.Off].filter(Boolean).sort().pop();
    const [h, m] = last.split(':').map(Number);
    return h * 60 + m <= n.getUTCHours() * 60 + n.getUTCMinutes();
  }
  const timeText = (t) => (t.On && t.Off ? `${t.On} → ${t.Off}` : t.On ? `Bật ${t.On}` : `Tắt ${t.Off}`);
  function repeatText(t, tzMin) {
    if (t.Date) return expired(t, tzMin) ? `1 lần · đã chạy ${dmy(t.Date)}` : `1 lần · ${dmy(t.Date)}`;
    const d = t.Days?.length ? t.Days : [1, 2, 3, 4, 5, 6, 7];
    if (d.length === 7) return 'Hằng ngày';
    if (d.join() === '1,2,3,4,5') return 'Ngày thường (T2–T6)';
    if (d.join() === '6,7') return 'Cuối tuần';
    return d.map((x) => DAYS[x - 1]).join(', ');
  }

  async function openTimer(gw, ch, label) {
    const L = cache.get(gw) || (await fetchLogic(gw)).body;
    const tz = Number(L?.current?.tz ?? 420);
    // danh sách làm việc: mốc đang bật (gateway báo) + mốc đang tắt (server); mốc 1 lần đã chạy → hiện tắt
    let items = [
      ...(L?.current?.timers?.[ch] || []).map((t) => ({ ...t, En: !expired(t, tz) })),
      ...(L?.current?.timersOff?.[ch] || []).map((t) => ({ ...t, En: false })),
    ];
    const box = document.createElement('div');
    box.className = 'gl-modal';
    box.innerHTML = `<div role="dialog" aria-modal="true" class="al-dlg"></div>`;
    document.body.append(box);
    const dlg = box.firstElementChild;
    const close = () => box.remove();
    let busy = false;

    /** Gửi toàn bộ danh sách (mốc bật → gateway, mốc tắt → server). Lỗi: trả về thông báo, danh sách cũ giữ nguyên. */
    async function save(next) {
      const payload = next.map((t) => {
        const o = { En: t.En !== false }; if (t.On) o.On = t.On; if (t.Off) o.Off = t.Off;
        if (t.Date) { o.Date = o.En && expired(t, tz) ? onceDate(t.On || t.Off, tz) : t.Date; o.Days = []; }   // bật lại mốc 1 lần đã chạy: lần tới
        else if (t.Days?.length && t.Days.length < 7) o.Days = t.Days;
        return o;
      });
      busy = true;
      const r = await withStepUp('PUT', '/api/v1/gateway-logic/timer', { gw, id: String(ch), timers: payload }, 'Xác nhận đổi hẹn giờ');
      busy = false;
      if (!r.ok) return r.body.error === 'cancelled' ? 'Đã huỷ.' : S.errText(r.body.error);
      items = payload;
      await fetchLogic(gw);
      window.DevicesUi?.render?.();
      return null;
    }

    function list(msg = '') {
      dlg.onclick = dlg.oninput = null;   // bỏ trình xử lý của màn sửa
      dlg.innerHTML = `
        <div class="al-top"><h3>⏰ Hẹn giờ — ${esc(label)}</h3><button type="button" class="fit al-x" aria-label="Đóng">✕</button></div>
        <p class="muted al-sub">Gateway tự bật/tắt đúng giờ, kể cả khi mất mạng. Giữa hai mốc vẫn bật/tắt tay được.</p>
        <div class="al-list">${items.length ? items.map((t, i) => `
          <div class="al-item${t.En === false ? ' off' : ''}" data-i="${i}">
            <button type="button" class="al-open" data-i="${i}"><b class="al-time">${esc(timeText(t))}</b><small>${esc(repeatText(t, tz))}</small></button>
            <label class="al-sw" title="${t.En === false ? 'Đang tắt — gạt để bật' : 'Đang bật — gạt để tắt'}"><input type="checkbox" data-i="${i}" ${t.En === false ? '' : 'checked'}><span></span></label>
          </div>`).join('') : '<p class="muted al-empty">Chưa có hẹn giờ.</p>'}</div>
        <div class="al-err">${esc(msg)}</div>
        <button type="button" class="primary al-add"${items.length >= 4 ? ' disabled title="Tối đa 4 hẹn giờ"' : ''}>+ Thêm hẹn giờ</button>`;
    }

    function edit(i) {
      const isNew = i < 0;
      const t = isNew ? { On: '06:00', Off: '18:00', En: true } : items[i];
      const rep = !t.Date;   // đang lặp lại?
      const days = t.Date ? [1, 2, 3, 4, 5, 6, 7] : (t.Days?.length ? t.Days : [1, 2, 3, 4, 5, 6, 7]);
      dlg.innerHTML = `
        <div class="al-top"><button type="button" class="fit al-back">Huỷ</button><h3>${isNew ? 'Thêm hẹn giờ' : 'Sửa hẹn giờ'}</h3><button type="button" class="primary fit al-ok">Lưu</button></div>
        <div class="al-form">
          <label class="al-row"><span>Bật lúc</span><input type="time" class="al-on" value="${esc(t.On || '')}"></label>
          <label class="al-row"><span>Tắt lúc</span><input type="time" class="al-off" value="${esc(t.Off || '')}"></label>
          <p class="muted al-hint">Để trống một ô nếu chỉ cần bật hoặc chỉ cần tắt.</p>
          <div class="al-row"><span>Lặp lại</span><label class="al-sw"><input type="checkbox" class="al-rep" ${rep ? 'checked' : ''}><span></span></label></div>
          <div class="gl-days al-days"${rep ? '' : ' hidden'}>${DAYS.map((d, k) => `<label class="${days.includes(k + 1) ? 'on' : ''}"><input type="checkbox" value="${k + 1}" ${days.includes(k + 1) ? 'checked' : ''}>${d}</label>`).join('')}</div>
          <p class="muted al-hint al-once"></p>
          <div class="al-err"></div>
          ${isNew ? '' : '<button type="button" class="danger al-del">Xoá hẹn giờ</button>'}
        </div>`;
      const q = (s) => dlg.querySelector(s);
      const hint = () => {
        const on = q('.al-rep').checked, at = q('.al-on').value || q('.al-off').value;
        q('.al-days').hidden = !on;
        q('.al-once').textContent = on ? '' : (at ? `Không lặp lại — chạy 1 lần, ngày ${dmy(onceDate(at, tz))}.` : 'Không lặp lại — chạy 1 lần.');
      };
      hint();
      dlg.oninput = hint;
      dlg.onclick = async (e) => {
        const dl = e.target.closest('.al-days label');
        if (dl) { setTimeout(() => { dl.classList.toggle('on', dl.querySelector('input').checked); }); return; }
        if (e.target.closest('.al-back')) return list();
        if (busy) return;
        if (e.target.closest('.al-del')) {
          const err = await save(items.filter((_, k) => k !== i));
          if (err) { q('.al-err').textContent = err; return; }
          return list();
        }
        if (!e.target.closest('.al-ok')) return;
        const on = q('.al-on').value, off = q('.al-off').value;
        if (!on && !off) { q('.al-err').textContent = 'Cần giờ bật hoặc giờ tắt.'; return; }
        if (on && on === off) { q('.al-err').textContent = 'Giờ bật và giờ tắt phải khác nhau.'; return; }
        const n = { En: true }; if (on) n.On = on; if (off) n.Off = off;
        if (q('.al-rep').checked) {
          const d = [...dlg.querySelectorAll('.al-days input:checked')].map((x) => Number(x.value));
          if (!d.length) { q('.al-err').textContent = 'Chọn ít nhất một ngày, hoặc tắt "Lặp lại".'; return; }
          if (d.length < 7) n.Days = d;
        } else {
          n.Date = onceDate(on || off, tz); n.Days = [];
        }
        const okBtn = q('.al-ok'); okBtn.disabled = true; okBtn.textContent = 'Đang lưu…';
        const err = await save(isNew ? [...items, n] : items.map((x, k) => (k === i ? n : x)));   // lưu = bật (như báo thức vừa chỉnh)
        okBtn.disabled = false; okBtn.textContent = 'Lưu';
        if (err) { q('.al-err').textContent = err; return; }
        list();
      };
    }

    box.addEventListener('click', (e) => { if (e.target === box) close(); });
    dlg.addEventListener('click', async (e) => {
      if (!dlg.querySelector('.al-list')) return;   // đang ở màn sửa: edit() tự xử lý
      if (e.target.closest('.al-x')) return close();
      if (e.target.closest('.al-add')) return edit(-1);
      const o = e.target.closest('.al-open'); if (o) return edit(Number(o.dataset.i));
    });
    dlg.addEventListener('change', async (e) => {
      const sw = e.target.closest('.al-list .al-sw input'); if (!sw || busy) return;
      const i = Number(sw.dataset.i);
      const next = items.map((x, k) => (k === i ? { ...x, En: sw.checked } : x));
      sw.disabled = true;
      const err = await save(next);   // gạt công tắc = lưu ngay (như báo thức)
      list(err || '');
    });
    list();
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
