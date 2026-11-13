'use strict';
/**
 * Dashboard thiết bị theo UI contract (GET /api/v1/ui/dashboard).
 * Thêm thiết bị: quét/dán QR → server tự chọn type/widget.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* đầy bộ nhớ */ } },
  };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  let dashboard = null;
  const live = {}; // childId → { key: value }

  function session() {
    return LS.get('session', null);
  }

  async function api(method, path, body) {
    const s = session();
    if (!s?.token || s.demo) return { ok: false, data: { error: 'unauthorized' } };
    const r = await fetch(`${s.apiBase || location.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${s.token}`,
        'Content-Type': 'application/json',
        ...(LS.get('ctl', null)?.token ? { 'X-Control-Token': LS.get('ctl').token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  function toast(msg, bad) {
    if (window.toast) return window.toast(msg, bad);
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('err', Boolean(bad));
    t.hidden = false;
    setTimeout(() => { t.hidden = true; }, 3200);
  }

  // Webapp nhiều gateway: số liệu sống khoá theo "<topic gateway>|<childId>" để hai gateway trùng tên thiết bị con không đè nhau
  const lk = (d) => `${d.gw?.base || dashboard?.telemetry?.topicBase || ''}|${d.childId}`;
  const gwKey = (d) => (d.gw?.site && d.gw?.device ? `${d.gw.site}/${d.gw.device}` : undefined);
  function val(dev, bind) {
    const o = live[lk(dev)];
    if (!o) return null;
    return o[bind];
  }

  /** Icon nhỏ mô tả giá trị (mức nước → giọt nước, nhiệt độ → nhiệt kế…). */
  const wic = (w) => (window.PlcIcons ? `<span class="wic" aria-hidden="true">${window.PlcIcons.value(w.bind || w.id, w.kind)}</span>` : '');

  /** Icon của thiết bị theo danh mục chuẩn: mã icon gateway gửi → loại → tên/mã thiết bị (loại chung chung như dynamic không lấn át tên). */
  const GENERIC_TYPE = /^(dynamic|generic|iot-hub|custom|device)$/i;
  const iconFor = (d) => (window.PlcIcons ? window.PlcIcons.pick(d.icon, GENERIC_TYPE.test(d.type || '') ? null : d.type, d.title, d.childId, d.type) : 'gear');
  const RUN_KEY = /^(run|q_run|on|running|start|q_on|enable|q_start)$/i;
  const SPEED_KEY = /(speed|rpm|freq|^sp$)/i;
  /** Trạng thái chạy + tốc độ quay của một thiết bị (suy từ số liệu sống) → điều khiển hiệu ứng icon. */
  function devState(d) {
    const o = live[lk(d)] || {};
    let on = null; let pct = null;
    for (const w of d.widgets || []) {
      if (w.locked || !w.bind) continue;
      const v = o[w.bind];
      if (RUN_KEY.test(w.bind) && v != null) on = Number(v) === 1 || v === true;
      if (SPEED_KEY.test(w.bind) && Number.isFinite(Number(v))) { const mx = Number(w.max ?? 100) || 100; pct = (Number(v) / mx) * 100; }
    }
    if (on == null) on = Object.keys(o).length > 0;   // không có khoá chạy/dừng (bồn, cảm biến): có số liệu = đang hoạt động
    if (on && pct === 0 && /^(pump|fan|motor|conveyor|compressor|mixer|generator|chiller|vfd)$/.test(iconFor(d))) on = false;
    return { on, spin: window.PlcIcons ? window.PlcIcons.spinSeconds(on ? pct : null) : '2.4' };
  }

  const icStyle = () => document.documentElement.dataset.icStyle || '3d';
  const FLAT_GAUGE = new Set(['scada', 'carbon']);   // kiểu phẳng: thanh tiến trình thay đồng hồ tròn
  const POLAR = (cx, cy, r, deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];

  /** Đồng hồ tròn 270° (kiểu Grafana/ThingsBoard): vạch chia, cung giá trị đổi màu theo ngưỡng, vùng thấp/cao, núm chỉ. */
  function radialSvg(pct, lvl, lowP, highP, has) {
    const R = 46; const C = 2 * Math.PI * R; const arc = C * 0.75;
    const col = lvl === 'high' ? '#f2495c' : lvl === 'low' ? '#f2b705' : 'var(--acc,#3b82f6)';
    const ticks = Array.from({ length: 11 }, (_, i) => {
      const a = 135 + 27 * i; const long = i % 5 === 0;
      const [x1, y1] = POLAR(60, 60, long ? 36 : 38, a); const [x2, y2] = POLAR(60, 60, 42, a);
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="currentColor" stroke-opacity="${long ? .55 : .28}" stroke-width="${long ? 1.8 : 1.2}"/>`;
    }).join('');
    const zone = (from, to, c) => `<circle cx="60" cy="60" r="55" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="butt" stroke-dasharray="0 ${(2 * Math.PI * 55 * 0.75 * from / 100).toFixed(1)} ${(2 * Math.PI * 55 * 0.75 * (to - from) / 100).toFixed(1)} ${(2 * Math.PI * 55).toFixed(1)}" transform="rotate(135 60 60)" opacity=".85"/>`;
    const zones = (lowP != null && lowP > 0 ? zone(0, lowP, '#f2b705') : '') + (highP != null && highP < 100 ? zone(highP, 100, '#f2495c') : '');
    const [kx, ky] = POLAR(60, 60, R, 135 + 270 * pct / 100);
    return `<svg class="rg-svg" viewBox="0 6 120 112" aria-hidden="true">
      <circle class="rg-track" cx="60" cy="60" r="${R}" fill="none" stroke="currentColor" stroke-opacity=".13" stroke-width="10" stroke-linecap="round" stroke-dasharray="${arc.toFixed(1)} ${C.toFixed(1)}" transform="rotate(135 60 60)"/>
      <g class="rg-zones">${zones}</g><g class="rg-ticks">${ticks}</g>
      <circle class="rg-arc" cx="60" cy="60" r="${R}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(has ? Math.max(0.01, arc * pct / 100) : 0).toFixed(1)} ${C.toFixed(1)}" transform="rotate(135 60 60)"/>
      ${has ? `<circle class="rg-knob" cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="5.5" fill="#fff" stroke="${col}" stroke-width="3"/>` : ''}
    </svg>`;
  }

  /** Bồn trụ 3D: thân kính, nước có mặt elip, thước chia, đổi màu khi chạm ngưỡng. */
  function tank3dSvg(pct, lvl, has) {
    const H = 52; const h = has ? H * pct / 100 : 0; const y = 18 + H - h;
    const liq = lvl === 'high' ? 'fill="#e0626d"' : lvl === 'low' ? 'fill="#f2b705"' : 'fill="url(#g3-liq)"';
    const top = lvl === 'high' ? '#ff9aa4' : lvl === 'low' ? '#ffe08a' : '#a8d8ff';
    return `<svg class="t3-svg" viewBox="0 0 70 84" aria-hidden="true">
      <ellipse cx="30" cy="70" rx="22" ry="7" fill="#1d2530"/>
      <path d="M8 18v52a22 7 0 0 0 44 0V18z" fill="rgba(255,255,255,.07)"/>
      ${h > 0.5 ? `<path d="M8 ${y.toFixed(1)}v${(70 - y).toFixed(1)}a22 7 0 0 0 44 0V${y.toFixed(1)}z" ${liq} opacity=".92"/><ellipse cx="30" cy="${y.toFixed(1)}" rx="22" ry="7" fill="${top}" opacity=".95"/>` : ''}
      <ellipse cx="30" cy="18" rx="22" ry="7" fill="rgba(255,255,255,.1)" stroke="rgba(255,255,255,.55)" stroke-width="1.4"/>
      <path d="M8 18v52a22 7 0 0 0 44 0V18" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.6"/>
      <path d="M13 24v42" stroke="#fff" stroke-opacity=".35" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M56 22h6M56 35h4M56 48h6M56 61h4" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
  }

  function widgetHtml(dev, w) {
    // Vượt giới hạn widget của gói: làm mờ, KHÔNG hiện/cập nhật số liệu, không điều khiển; bấm vào để biết lý do + nâng gói
    if (w.locked) {
      return `<div class="dw locked" data-locked="1" data-wid="${esc(w.id)}" role="button" tabindex="0" aria-label="Widget bị khoá — bấm để xem lý do"><div class="k">${esc(w.label)}</div><div class="v">🔒 <small>Đã khoá</small></div></div>`;
    }
    const v = val(dev, w.bind);
    const show = v == null || v === '' ? '—' : (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v);
    const unit = w.unit ? ` <small>${esc(w.unit)}</small>` : '';
    if (w.kind === 'gauge') {
      const min = Number(w.min ?? 0); const max = Number(w.max ?? 100);
      const n = Number(v);
      const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, ((n - min) / (max - min || 1)) * 100)) : 0;
      const lvl = Number.isFinite(n) && w.low != null && n <= w.low ? 'low' : Number.isFinite(n) && w.high != null && n >= w.high ? 'high' : '';
      if (!FLAT_GAUGE.has(icStyle())) {        // đồng hồ tròn kiểu Grafana / ThingsBoard (kiểu SCADA giữ thanh phẳng)
        const zp = (x) => (x == null ? null : Math.max(0, Math.min(100, ((Number(x) - min) / (max - min || 1)) * 100)));
        return `<div class="dw gauge rg ${lvl}" data-wid="${esc(w.id)}"><div class="k">${wic(w)}${esc(w.label)}${lvl ? ` <b class="lvl">${lvl === 'low' ? 'Mức thấp' : 'Mức cao'}</b>` : ''}</div>
        <div class="rg-wrap">${radialSvg(pct, lvl, zp(w.low), zp(w.high), Number.isFinite(n))}<div class="rg-val"><b>${esc(show)}</b>${w.unit ? `<small>${esc(w.unit)}</small>` : ''}</div></div>
        <div class="rg-range"><span>${esc(min)}</span><span>${esc(max)}</span></div></div>`;
      }
      return `<div class="dw gauge ${lvl}" data-wid="${esc(w.id)}"><div class="k">${wic(w)}${esc(w.label)}${lvl ? ` <b class="lvl">${lvl === 'low' ? 'Mức thấp' : 'Mức cao'}</b>` : ''}</div>
        <div class="gauge-bar"><i style="width:${pct}%"></i></div>
        <div class="v">${esc(show)}${unit}</div></div>`;
    }
    if (w.kind === 'tank') {
      // bồn nước: cột chứa dọc, đổi màu + chữ khi chạm ngưỡng thấp/cao (giống thẻ bồn của GatewayApp)
      const min = Number(w.min ?? 0); const max = Number(w.max ?? 100); const n = Number(v);
      const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, ((n - min) / (max - min || 1)) * 100)) : 0;
      const lvl = Number.isFinite(n) && w.low != null && n <= w.low ? 'low' : Number.isFinite(n) && w.high != null && n >= w.high ? 'high' : '';
      if (icStyle() === 'grafana' || icStyle() === 'carbon') {   // thanh bar gauge ngang kiểu Grafana / Carbon
        return `<div class="dw tankw bargauge ${lvl}" data-wid="${esc(w.id)}"><div class="k">${wic(w)}${esc(w.label)}${lvl ? ` <b class="lvl">${lvl === 'low' ? 'Mức thấp' : 'Mức cao'}</b>` : ''}</div>
        <div class="bg-bar"><i style="width:${pct}%"></i></div><div class="v">${esc(show)}${unit}</div></div>`;
      }
      if (icStyle() !== 'scada') {        // bồn trụ 3D có mặt nước + thước chia (kiểu SCADA giữ cột phẳng)
        return `<div class="dw tankw tank3d ${lvl}" data-wid="${esc(w.id)}">${tank3dSvg(pct, lvl, Number.isFinite(n))}
        <div><div class="k">${wic(w)}${esc(w.label)}${lvl ? ` <b class="lvl">${lvl === 'low' ? 'Mức thấp' : 'Mức cao'}</b>` : ''}</div><div class="v">${esc(show)}${unit}</div></div></div>`;
      }
      return `<div class="dw tankw ${lvl}" data-wid="${esc(w.id)}"><div class="tank"><i style="height:${pct}%"></i></div>
        <div><div class="k">${wic(w)}${esc(w.label)}${lvl ? ` <b class="lvl">${lvl === 'low' ? 'Mức thấp' : 'Mức cao'}</b>` : ''}</div><div class="v">${esc(show)}${unit}</div></div></div>`;
    }
    if (w.kind === 'ring') {
      const pct = Math.max(0, Math.min(100, Number(v) || 0));
      return `<div class="dw ringw" data-wid="${esc(w.id)}"><div class="ring" style="--p:${pct}"><span>${esc(show)}${v != null ? '%' : ''}</span></div>
        <div class="k">${wic(w)}${esc(w.label)}</div></div>`;
    }
    if (w.kind === 'toggle') {
      const on = Number(v) === 1 || v === true;
      const c = w.cmd || {};
      // ★ = lệnh nguy hiểm: mỗi lần phải xác nhận (Face ID / Authenticator / mật khẩu). Tem có thể đặt sẵn (khoá, không bỏ được).
      const star = c.key != null
        ? `<button type="button" class="dw-star ${c.critical ? 'on' : ''}" data-dev="${esc(dev.id)}" data-wid="${esc(w.id)}" data-key="${esc(c.key)}" data-crit="${c.critical ? 1 : 0}" ${c.criticalLocked ? 'disabled' : ''} title="${c.critical ? (c.criticalLocked ? 'Lệnh nguy hiểm do tem đặt' : 'Bỏ đánh dấu nguy hiểm') : 'Đánh dấu lệnh nguy hiểm'}">${c.critical ? '★' : '☆'}</button>`
        : '';
      const info = [c.critical ? `⚠ Nguy hiểm — xác nhận từng lần${c.criticalLocked ? ' (tem đặt)' : ''}` : '', c.limits ? `Giới hạn ${c.limits.min}–${c.limits.max}` : ''].filter(Boolean).join(' · ');
      return `<div class="dw ctlw ${c.critical ? 'crit' : ''}" data-wid="${esc(w.id)}"><div class="k">${wic(w)}${esc(w.label)} ${star}</div>
        <button type="button" class="fit dw-toggle ${on ? 'on' : ''}" data-dev="${esc(dev.id)}" data-wid="${esc(w.id)}">${on ? `● ${esc(w.onText || 'Bật')}` : `○ ${esc(w.offText || 'Tắt')}`}<small>bấm để ${on ? esc(w.offText || 'Tắt') : esc(w.onText || 'Bật')}</small></button>${info ? `<div class="d muted dw-info">${esc(info)}</div>` : ''}</div>`;
    }
    if (w.kind === 'slider') {
      // thanh trượt đặt giá trị (vd tốc độ bơm): thả tay mới gửi lệnh {child,key,v}, giá trị thật hiện qua telemetry
      const min = Number(w.min ?? 0); const max = Number(w.max ?? 100); const step = Number(w.step ?? 1);
      const n = Number(v);
      const cur = Number.isFinite(n) ? n : min;
      const lim = w.cmd?.limits;
      const sk = `${dev.id}|${w.id}`;
      if (staged[sk] !== undefined && staged[sk] === cur) delete staged[sk];     // thiết bị đã tới đúng giá trị đã chọn
      const pend = staged[sk] !== undefined;
      const sval = pend ? staged[sk] : cur;
      const pendText = pend ? `Chưa gửi — thiết bị đang ở ${show}${w.unit ? ' ' + w.unit : ''}, giá trị mới ${sval}${w.unit ? ' ' + w.unit : ''}. Bấm “Gửi lệnh” để áp dụng hoặc “Huỷ”.` : '';
      const unitTxt = w.unit ? `<span class="dw-nu">${esc(w.unit)}</span>` : '';
      const rangeTxt = `Khoảng ${min}–${max}${lim ? `, giới hạn ${lim.min}–${lim.max}` : ''}${step !== 1 ? `, bước ${step}` : ''}`;
      // Số đang đặt = ô NHẬP SỐ lớn nằm TRÊN thanh trượt (ngón tay không che khuất; chạm vào để gõ chính xác bằng bàn phím), cạnh nút −/+.
      return `<div class="dw ctlw${pend ? ' pending' : ''}" data-wid="${esc(w.id)}"><div class="k">${wic(w)}${esc(w.label)}</div>
        <div class="dw-numrow dw-vtop"><button type="button" class="dw-step" data-d="-1" aria-label="Giảm ${step}">−</button><input type="number" class="dw-numin" inputmode="decimal" enterkeyhint="done" min="${min}" max="${max}" step="${Math.min(step, 1)}" value="${sval}" aria-label="${esc(w.label)} — nhập số bằng bàn phím"><button type="button" class="dw-step" data-d="1" aria-label="Tăng ${step}">+</button>${unitTxt}<button type="button" class="dw-cancel" data-dev="${esc(dev.id)}" data-wid="${esc(w.id)}" tabindex="${pend ? 0 : -1}">Huỷ</button></div>
        <div class="slider-row"><input type="range" class="dw-slider" data-dev="${esc(dev.id)}" data-wid="${esc(w.id)}" min="${min}" max="${max}" step="${step}" value="${sval}" aria-label="${esc(w.label)}"${pend ? ' data-dirty="1"' : ''}>
          <button type="button" class="dw-send${pend ? ' dirty' : ''}" data-dev="${esc(dev.id)}" data-wid="${esc(w.id)}"${pend ? '' : ' disabled'}>Gửi lệnh</button></div>
        <div class="dw-pendinfo" aria-live="polite">${esc(pendText)}</div>
        <div class="d muted dw-info">${esc(rangeTxt)}</div></div>`;
    }
    if (w.kind === 'status' || w.kind === 'chip') {
      const on = Number(v) === 1 || v === true || (typeof v === 'number' && v > 0);
      return `<div class="dw" data-wid="${esc(w.id)}"><div class="k">${wic(w)}${esc(w.label)}</div>
        <div class="chip ${on ? 'on' : ''}"><i class="lamp"></i>${esc(w.onText || w.offText ? (on ? (w.onText || 'Bật') : (w.offText || 'Tắt')) : String(show))}</div></div>`;
    }
    if (w.kind === 'sparkline' || w.kind === 'line' || w.kind === 'bar') {
      return `<div class="dw" data-wid="${esc(w.id)}"><div class="k">${wic(w)}${esc(w.label)}</div>
        <div class="v">${esc(show)}${unit}</div><div class="d muted">biểu đồ live</div></div>`;
    }
    // kpi / text / default
    return `<div class="dw" data-wid="${esc(w.id)}"><div class="k">${wic(w)}${esc(w.label)}</div>
      <div class="v">${esc(show)}${unit}</div></div>`;
  }

  /** Mã biểu tượng gateway gửi trong config (icon) → emoji (không cần font/ảnh riêng, chạy trên điện thoại). */
  const DEV_ICON = { tank: '🛢', pump: '⛽', env: '🌡', valve: '🚰', motor: '⚙️', energy: '⚡', pressure: '🧭', conveyor: '📦', di: '⬇️', do: '⬆️', custom: '➕' };

  /** HTML một thẻ thiết bị. readonly = xem thử: không nút gỡ, không điều khiển được. */
  function cardHtml(d, readonly) {
    const st = devState(d);
    const icon = window.PlcIcons ? `<span class="dev-ic" aria-hidden="true">${window.PlcIcons.device(iconFor(d), { on: st.on, speed: st.spin })}</span>` : '';
    return `<article class="dev-card${window.PlcIcons?.category ? ` cat-${window.PlcIcons.category(iconFor(d))}` : ''}${d.color ? ` acc-${esc(d.color)}` : ''}${readonly ? ' readonly' : ''}${st.on ? '' : ' is-off'}" data-id="${esc(d.id)}" data-child="${esc(d.childId)}" data-type="${esc(d.type)}">
      <header>${icon}<h3>${esc(d.title)}</h3><span class="muted">${esc(TYPE_VI[d.type] || d.type)}</span>
      </header>
      <div class="dev-widgets">${d.widgets.map((w) => widgetHtml(d, w)).join('')}</div>
    </article>`;
  }

  // ---- Làm mượt: cập nhật số liệu TẠI CHỖ thay vì dựng lại cả lưới -------------------------------------------------
  // Trước đây mỗi gói telemetry gọi render() → gán lại innerHTML cả lưới: thanh trượt đang kéo bị huỷ/nhảy về giá trị cũ,
  // thanh bồn/gauge mất hiệu ứng chuyển động. Giờ: cấu trúc không đổi thì chỉ "vá" (morph) phần số liệu; phần tử giữ nguyên.
  let lastSig = '';
  let activeSlider = null;                 // thanh trượt người dùng đang kéo/vừa thả: không đụng tới trong lúc đó
  const hold = new Map();                  // "<gw>|<child>|<field>" → { v, until }: giá trị vừa gửi, bỏ qua telemetry cũ cho tới khi gateway xác nhận
  const holdKey = (dev, w) => `${lk(dev)}|${w.bind}`;
  const setHold = (dev, w, v) => hold.set(holdKey(dev, w), { v: Number(v), until: Date.now() + 3500 });
  const clearHold = (dev, w) => hold.delete(holdKey(dev, w));
  // Giá trị thanh trượt người dùng đã chọn nhưng CHƯA gửi: lưu ở đây để không mất khi lưới dựng lại, và luôn hiện rõ "chưa gửi".
  const staged = {};                       // "<dev.id>|<w.id>" → số
  const PENDING_TTL_MS = 60000;            // quên quá 60 giây thì bỏ, nhưng PHẢI báo cho người dùng (không im lặng nhảy về số cũ)
  const releaseSlider = (sl) => setTimeout(() => { if (activeSlider === sl) activeSlider = null; }, 900);

  function morph(a, b) {
    if (a.nodeType === 3 || b.nodeType === 3) { if (a.nodeType === 3 && b.nodeType === 3 && a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    if (a.nodeType !== 1 || b.nodeType !== 1) return;
    for (const at of [...a.attributes]) if (at.name !== 'disabled' && !b.hasAttribute(at.name)) a.removeAttribute(at.name);
    for (const at of [...b.attributes]) if (at.name !== 'disabled' && a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    if (a.tagName === 'INPUT') { if (a !== activeSlider && a !== document.activeElement && a.value !== b.getAttribute('value')) a.value = b.getAttribute('value'); return; }
    const ac = a.childNodes; const bc = b.childNodes;
    if (ac.length !== bc.length) { a.innerHTML = b.innerHTML; return; }
    for (let i = 0; i < ac.length; i++) {
      if (ac[i].nodeType !== bc[i].nodeType || (ac[i].nodeType === 1 && ac[i].tagName !== bc[i].tagName)) { a.innerHTML = b.innerHTML; return; }
      morph(ac[i], bc[i]);
    }
  }

  function structSig(order, byId, banner) {
    return JSON.stringify([banner, dashboard?.gateways?.length || 0, order.map((id) => {
      const d = byId[id];
      return d && [d.id, d.title, d.icon, d.color, d.type, d.gw, d.widgets.map((w) => [w.id, w.kind, w.label, w.locked, w.unit, w.min, w.max, w.step, w.low, w.high, w.onText, w.offText, w.cmd])];
    })]);
  }

  /** Cập nhật hiệu ứng icon theo trạng thái chạy/dừng + tốc độ quay (không dựng lại icon). */
  function syncCardState(cardEl, d) {
    const st = devState(d);
    cardEl.classList.toggle('is-off', !st.on);
    const svg = cardEl.querySelector('.dev-ic .ic');
    if (svg) { svg.classList.toggle('on', st.on); svg.style.setProperty('--spin', `${st.spin}s`); }
  }

  function patchLive(host, order, byId) {
    for (const id of order) {
      const d = byId[id]; if (!d) continue;
      const cardEl = host.querySelector(`.dev-card[data-id="${id}"]`);
      const box = cardEl?.querySelector('.dev-widgets');
      if (!box) continue;
      syncCardState(cardEl, d);
      d.widgets.forEach((w, i) => {
        const el = box.children[i]; if (!el) return;
        if (activeSlider && el.contains(activeSlider)) return;   // đang kéo: để nguyên
        const t = document.createElement('template');
        t.innerHTML = widgetHtml(d, w).trim();
        if (t.content.firstElementChild) morph(el, t.content.firstElementChild);
      });
    }
  }

  function render() {
    const host = $('#dev-grid');
    if (!host) return;
    if (loadErr && !dashboard?.devices?.length) {
      const why = ({ unauthorized: 'phiên đăng nhập hết hạn — hãy đăng nhập lại', session_revoked: 'phiên đã bị thu hồi — hãy đăng nhập lại', app_locked: 'ứng dụng đang khoá — mở khoá rồi thử lại', login_step_up_required: 'cần xác thực thêm — đăng nhập lại', network: 'không có kết nối mạng' })[loadErr.code] || `lỗi ${loadErr.code}`;
      host.innerHTML = `<div class="dev-empty muted">Không tải được danh sách thiết bị (${esc(why)}).<br><button type="button" class="primary" id="dev-retry">Thử lại</button> <button type="button" id="dev-relogin">Đăng nhập lại</button></div>`;
      $('#dev-retry')?.addEventListener('click', () => { loadRetried = false; load().catch(() => {}); });
      $('#dev-relogin')?.addEventListener('click', () => { try { localStorage.removeItem('session'); } catch { /* */ } location.replace('login.html'); });
      lastSig = '';
      return;
    }
    if (!dashboard?.devices?.length) {
      host.innerHTML = `<div class="dev-empty muted">Chưa có thiết bị.<br>Bấm <b>+ Thêm</b>, dán/quét QR tem — widget tự hiện (không cần sơ đồ SCADA).</div>`;
      lastSig = '';
      return;
    }
    const order = dashboard.layout?.simple?.order || dashboard.devices.map((d) => d.id);
    const byId = Object.fromEntries(dashboard.devices.map((d) => [d.id, d]));
    const pl = dashboard.plan;
    const banner = pl && pl.locked > 0
      ? `<div class="plan-banner" id="plan-banner">🔒 <span>Gói ${esc(pl.label || 'Miễn phí')} chỉ dùng ${pl.widgetLimit} widget — ${pl.locked} widget đang bị khoá (làm mờ, không cập nhật dữ liệu).</span><button type="button" class="primary" id="plan-up">Nâng gói</button></div>`
      : '';
    const sig = structSig(order, byId, banner);
    if (sig === lastSig && host.querySelector('.dev-card')) { patchLive(host, order, byId); return; }   // chỉ số liệu đổi: vá tại chỗ
    lastSig = sig;
    // Nhóm theo gateway: mỗi nhóm có tiêu đề + nút "Gỡ gateway" (gỡ cả gateway, không gỡ lẻ từng thiết bị/widget)
    const groups = [];
    for (const id of order) {
      const d = byId[id]; if (!d) continue;
      const key = d.gw ? `${d.gw.site}/${d.gw.device}` : '';
      let g = groups.find((x) => x.key === key);
      if (!g) { g = { key, gw: d.gw, devs: [] }; groups.push(g); }
      g.devs.push(d);
    }
    host.innerHTML = banner + groups.map((g) => `
      <section class="gw-group" data-gw="${esc(g.key)}">
        <div class="gw-head"><span class="gw-ic" aria-hidden="true">${window.PlcIcons ? window.PlcIcons.device('gear', { on: false }) : ''}</span>
          <div class="gw-title"><b>${esc(g.gw ? `${g.gw.site} / ${g.gw.device}` : 'Thiết bị')}</b><small>${g.devs.length} thiết bị · ${g.devs.reduce((n, d) => n + d.widgets.length, 0)} widget</small></div>
          ${g.gw ? `<button type="button" class="fit danger gw-rm" data-site="${esc(g.gw.site)}" data-device="${esc(g.gw.device)}" data-n="${g.devs.length}" title="Gỡ cả gateway khỏi tài khoản">Gỡ gateway</button>` : ''}</div>
        <div class="gw-cards">${g.devs.map((d) => cardHtml(d, false)).join('')}</div>
      </section>`).join('');

    host.querySelectorAll('.gw-rm').forEach((b) => {
      b.onclick = async () => {
        const name = `${b.dataset.site}/${b.dataset.device}`;
        if (!confirm(`Gỡ gateway ${name} khỏi tài khoản?\nToàn bộ ${b.dataset.n} thiết bị của gateway này sẽ bị gỡ cùng lúc (không gỡ lẻ từng thiết bị). Thêm lại bằng cách quét QR.`)) return;
        b.disabled = true;
        const r = await api('DELETE', `/api/gateways/${encodeURIComponent(b.dataset.site)}/${encodeURIComponent(b.dataset.device)}`);
        if (!r.ok) { b.disabled = false; return toast(`Không gỡ được gateway. ${window.ErrText(r.data?.error, r.status)}`, true); }
        toast(`Đã gỡ gateway ${name}.`);
        await load();
      };
    });

    host.querySelectorAll('.dw.locked').forEach((el) => {
      el.onclick = () => window.PlanUi?.show('widget_locked');
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.PlanUi?.show('widget_locked'); } };
    });
    host.querySelector('#plan-up')?.addEventListener('click', () => window.PlanUi?.goUpgrade());
    host.querySelectorAll('.dw-star').forEach((b) => {
      b.onclick = async () => {
        const want = b.dataset.crit !== '1';
        let r = await api('POST', `/api/devices/${b.dataset.dev}/critical`, { key: b.dataset.key, critical: want });
        if (r.status === 401 && r.data?.error === 'step_up_required' && window.Ctl?.unlock && await window.Ctl.unlock(r.data)) {
          r = await api('POST', `/api/devices/${b.dataset.dev}/critical`, { key: b.dataset.key, critical: want });
        }
        if (!r.ok) return toast(`Chưa đổi được đánh dấu. ${window.ErrText(r.data?.error, r.status)}`, true);
        dashboard = r.data.dashboard; render();
        toast(want ? 'Đã đánh dấu lệnh nguy hiểm: mỗi lần sẽ phải xác nhận.' : 'Đã bỏ đánh dấu.');
      };
    });
    // Thanh trượt: kéo chỉ ĐẶT giá trị chờ gửi; lệnh chỉ đi khi bấm nút "Gửi lệnh" (tránh gửi nhầm khi chạm/kéo)
    host.querySelectorAll('.dw-slider').forEach((sl) => {
      const box = sl.closest('.dw');
      const out = box.querySelector('output');
      const btn = box.querySelector('.dw-send');
      const info = box.querySelector('.dw-pendinfo');
      const find = () => {
        const dev = dashboard.devices.find((x) => x.id === sl.dataset.dev);
        return { dev, w: dev?.widgets?.find((x) => x.id === sl.dataset.wid) };
      };
      const cancelBtn = box.querySelector('.dw-cancel');
      const skey = `${sl.dataset.dev}|${sl.dataset.wid}`;
      let idle = null;
      const clearDirty = () => {
        clearTimeout(idle); delete sl.dataset.dirty; activeSlider = null; delete staged[skey];
        btn.disabled = true; btn.classList.remove('dirty'); if (info) info.textContent = '';
        box.classList.remove('pending');
      };
      const cancelDirty = () => { clearDirty(); render(); };       // bỏ giá trị chưa gửi, trả về số liệu thật
      if (cancelBtn) cancelBtn.onclick = () => { cancelDirty(); };
      if (staged[skey] !== undefined) {                           // dựng lại lưới khi đang có giá trị chưa gửi: giữ hẹn giờ quên
        clearTimeout(idle); idle = setTimeout(() => { const v = staged[skey]; cancelDirty(); toast(`Giá trị ${v} chưa gửi đã bị bỏ sau 60 giây. Thiết bị vẫn giữ giá trị cũ.`); }, PENDING_TTL_MS);
      }
      const grab = () => { activeSlider = sl; };
      sl.addEventListener('pointerdown', grab); sl.addEventListener('touchstart', grab, { passive: true });
      for (const ev of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) sl.addEventListener(ev, () => { if (!sl.dataset.dirty) releaseSlider(sl); });
      const numin = box.querySelector('.dw-numin');
      // Dùng chung cho thanh trượt (chỉnh thô), ô nhập số và nút −/+ (chỉnh chính xác): kẹp trong khoảng, làm tròn theo bước, đồng bộ hai chiều.
      const stage = (raw, from) => {
        const { dev, w } = find();
        const lo = Number(sl.min), hi = Number(sl.max), st = Number(sl.step) || 1;
        let n = Number(raw);
        if (!Number.isFinite(n)) return;
        const lim = w?.cmd?.limits;
        const L = lim ? Math.max(lo, Number(lim.min)) : lo; const H = lim ? Math.min(hi, Number(lim.max)) : hi;
        const out_ = n < L || n > H;
        const fine = (from === 'num' || from === 'refresh') ? Math.min(st, 1) : st;   // gõ bàn phím: bước mịn (gõ 66 ra 66); kéo / −/+: theo bước widget
        n = Math.min(H, Math.max(L, Math.round((n - lo) / fine) * fine + lo));
        n = Math.round(n * 1e6) / 1e6;
        sl.value = String(n);
        if (numin && from !== 'num') numin.value = String(n);
        activeSlider = sl; sl.dataset.dirty = '1';
        if (out) out.textContent = String(n);
        const cur = Number(val(dev, w?.bind));
        const changed = !Number.isFinite(cur) || cur !== n;
        if (changed) staged[skey] = n; else delete staged[skey];
        btn.disabled = !changed; btn.classList.toggle('dirty', changed);
        box.classList.toggle('pending', changed);
        if (info) info.textContent = changed ? `Chưa gửi — thiết bị đang ở ${Number.isFinite(cur) ? cur : '?'}${w?.unit ? ' ' + w.unit : ''}, giá trị mới ${n}${w?.unit ? ' ' + w.unit : ''}${out_ ? ` (đã đưa về giới hạn ${L}–${H})` : ''}. Bấm “Gửi lệnh” để áp dụng hoặc “Huỷ”.` : '';
        clearTimeout(idle);
        // Quên thì bỏ, nhưng KHÔNG im lặng nhảy về số cũ: báo rõ cho người dùng.
        if (changed) idle = setTimeout(() => { const v = staged[skey]; cancelDirty(); toast(`Giá trị ${v} chưa gửi đã bị bỏ sau 60 giây. Thiết bị vẫn giữ giá trị cũ.`); }, PENDING_TTL_MS);
      };
      sl.oninput = () => stage(sl.value, 'slider');
      if (numin) {
        numin.addEventListener('focus', () => { activeSlider = sl; try { numin.select(); } catch { /* */ } });
        numin.addEventListener('input', () => { if (numin.value.trim() !== '' && Number.isFinite(Number(numin.value))) stage(numin.value, 'num'); });
        numin.addEventListener('change', () => { if (numin.value.trim() === '') { numin.value = sl.value; return; } stage(numin.value, 'refresh'); });   // rời ô: chuẩn hoá hiển thị
        numin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); numin.blur(); } });
        numin.addEventListener('blur', () => { if (!sl.dataset.dirty) releaseSlider(sl); });
      }
      box.querySelectorAll('.dw-step').forEach((sb) => {
        sb.onclick = () => {
          const base = staged[skey] !== undefined ? staged[skey] : Number(val(find().dev, find().w?.bind));
          const b0 = Number.isFinite(base) ? base : Number(sl.value);
          stage(b0 + Number(sb.dataset.d) * (Number(sl.step) || 1), 'step');
        };
      });
      btn.onclick = () => {
        const { dev, w } = find();
        if (!w?.cmd?.key || !window.Ctl?.send || btn.disabled) return;
        const prev = live[lk(dev)]?.[w.bind];
        const next = staged[skey] !== undefined ? Number(staged[skey]) : Number(sl.value);
        live[lk(dev)] = { ...live[lk(dev)], [w.bind]: next };
        setHold(dev, w, next);
        clearDirty();
        btn.disabled = true; btn.textContent = 'Đang gửi…';
        window.Ctl.send({ child: dev.childId, key: w.cmd.key, v: next, gw: gwKey(dev) }).then((r) => {
          if (r?.ok) return toast('Đã gửi lệnh tới thiết bị.');
          clearHold(dev, w);
          live[lk(dev)] = { ...live[lk(dev)], [w.bind]: prev };
          render();
          if (r?.error === 'cancelled') return toast('Đã huỷ lệnh, thiết bị không thay đổi.');
          if (/^sub_|^widget_locked$/.test(r?.error || '')) window.PlanUi?.show(r.error);   // lỗi do gói: hộp giải thích + nút "Nâng gói"
          else toast(`Lệnh chưa được gửi, thiết bị không thay đổi. ${window.ErrText(r?.error || 'network', r?.status)}`, true);
        }).finally(() => { btn.textContent = 'Gửi lệnh'; });
      };
    });
    host.querySelectorAll('.dw-toggle').forEach((b) => {
      b.onclick = () => {
        const dev = dashboard.devices.find((x) => x.id === b.dataset.dev);
        const w = dev?.widgets?.find((x) => x.id === b.dataset.wid);
        if (!w?.cmd) return;
        const cur = Number(val(dev, w.bind)) === 1;
        const next = cur ? (w.cmd.off ?? 0) : (w.cmd.on ?? 1);
        if (typeof window.command === 'function' && w.cmd.a != null) {
          window.command(w.cmd.a, next);
        } else if (w.cmd.key != null && window.Ctl?.send) {
          // thiết bị con của hub: lệnh {child,key,v} đi /api/control/cmd (cùng xác thực bước hai), kết quả thật hiện qua telemetry
          b.disabled = true;
          // cập nhật lạc quan: nút đổi ngay, telemetry của PLC xác nhận (hoặc sửa lại) sau; lỗi thì trả về giá trị cũ
          const prev = live[lk(dev)]?.[w.bind];
          live[lk(dev)] = { ...live[lk(dev)], [w.bind]: next };
          setHold(dev, w, next);
          render();
          window.Ctl.send({ child: dev.childId, key: w.cmd.key, v: next, gw: gwKey(dev) }).then((r) => {
            if (r?.ok) return toast('Đã gửi lệnh tới thiết bị.');
            clearHold(dev, w);
            live[lk(dev)] = { ...live[lk(dev)], [w.bind]: prev };
            render();
            if (r?.error === 'cancelled') return toast('Đã huỷ lệnh, thiết bị không thay đổi.');
            if (/^sub_|^widget_locked$/.test(r?.error || "")) window.PlanUi?.show(r.error);   // lỗi do gói: hộp giải thích + nút "Nâng gói"
            else toast(`Lệnh chưa được gửi, thiết bị không thay đổi. ${window.ErrText(r?.error || "network", r?.status)}`, true);
          }).finally(() => { b.disabled = false; });
        } else {
          live[lk(dev)] = { ...live[lk(dev)], [w.bind]: next };
          render();
          toast('Đã gửi (demo/local)');
        }
      };
    });
  }

  let loadErr = null;
  let loadRetried = false;
  async function load() {
    const s = session();
    if (!s?.token || s.demo) {
      dashboard = { devices: [], layout: { simple: { order: [] } } };
      render();
      return;
    }
    const mode = (LS.get('cfg', {})?.uiMode === 'pro') ? 'pro' : 'simple';
    let r;
    try { r = await api('GET', `/api/v1/ui/dashboard?mode=${mode}`); } catch { r = { ok: false, status: 0, data: { error: 'network' } }; }
    if (!r.ok) {
      // Không im lặng hiện "trống": báo rõ lý do + nút thử lại; thử lại tự động một lần (iOS hay mở app lúc mạng/phiên chưa sẵn sàng).
      loadErr = { code: r.data?.error || `http_${r.status || 0}`, status: r.status || 0 };
      if (!loadRetried) { loadRetried = true; setTimeout(() => { load().catch(() => {}); }, 1500); }
      dashboard = { devices: [] };
      render();
      return;
    }
    loadErr = null; loadRetried = false;
    dashboard = r.data;
    window.PlanUi?.update(null, dashboard.plan);
    render();
  }

  const TYPE_VI = { env: 'Môi trường', pump: 'Bơm', switch: 'Công tắc', relay: 'Rơ-le', energy: 'Điện năng', tank: 'Bồn chứa', motor: 'Động cơ', conveyor: 'Băng tải', sensor: 'Cảm biến', valve: 'Van', light: 'Đèn', fan: 'Quạt' };

  // ---- Mã QR của tôi: lưu chính mã QR đã nạp (trên máy này) và hiển thị lại ----------------------
  function qrInfo(qr) {
    try {
      const b = qr.replace(/-/g, '+').replace(/_/g, '/');
      const j = JSON.parse(decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4)))));
      return { site: j.site || '', device: j.device || '' };
    } catch { return { site: '', device: '' }; }
  }
  function myQrs() { const v = LS.get('myQrs', []); return Array.isArray(v) ? v : []; }
  function rememberQr(qr) {
    const i = qrInfo(qr);
    const list = myQrs().filter((x) => x.qr !== qr);
    list.unshift({ qr, site: i.site, device: i.device, at: Date.now() });
    LS.set('myQrs', list.slice(0, 20));
  }
  let mqIdx = 0;
  function renderMyQr() {
    const list = myQrs();
    mqIdx = Math.min(Math.max(mqIdx, 0), Math.max(0, list.length - 1));
    const cur = list[mqIdx];
    $('#mq-empty').hidden = Boolean(cur);
    $('#mq-canvas').parentElement.hidden = !cur;
    $('#mq-copy').disabled = $('#mq-save').disabled = !cur;
    $('#mq-name').textContent = cur ? (cur.device || 'Thiết bị') : '';
    $('#mq-sub').textContent = cur ? (cur.site ? `Nhà máy ${cur.site}` : '') : '';
    $('#mq-dots').innerHTML = list.length > 1 ? list.map((_, i) => `<i class="${i === mqIdx ? 'on' : ''}" data-i="${i}"></i>`).join('') : '';
    if (cur && window.QRCode) window.QRCode.toCanvas($('#mq-canvas'), cur.qr, { width: 300, margin: 2, errorCorrectionLevel: 'M' });
  }
  function openMyQr() {
    stopCamera();
    const m = $('#dev-modal'); if (m) m.hidden = true;
    mqIdx = 0; renderMyQr(); $('#mq').hidden = false;
  }
  function closeMyQr() { $('#mq').hidden = true; }
  async function copyMyQr() {
    const cur = myQrs()[mqIdx]; if (!cur) return;
    try { await navigator.clipboard.writeText(cur.qr); toast('Đã sao chép mã QR. Dán vào ô "Nhập mã thủ công" để thêm thiết bị.'); } catch { toast('Không sao chép được vì trình duyệt không cho phép. Hãy dùng "Lưu ảnh" thay thế.', true); }
  }
  function saveMyQr() {
    const cur = myQrs()[mqIdx]; if (!cur) return;
    const a = document.createElement('a');
    a.href = $('#mq-canvas').toDataURL('image/png'); a.download = `qr-${cur.device || 'thiet-bi'}.png`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /** manual=true: hiện ô nhập mã/chọn ảnh. Mặc định "+ Thêm" mở thẳng màn quét camera. */
  function openModal(manual) {
    if (manual !== true) return toggleCamera();
    const m = $('#dev-modal');
    if (!m) return;
    m.hidden = false;
    $('#dev-qr')?.focus();
  }
  function closeModal() {
    stopCamera();
    const m = $('#dev-modal');
    if (m) m.hidden = true;
  }

  // ---- Đọc QR từ ảnh / camera ------------------------------------------------------------
  // Dùng BarcodeDetector (Chrome/Edge/Android). Nếu có thêm vendor/jsQR.js (tuỳ chọn) thì dùng làm dự phòng cho Safari/Firefox.
  let camStream = null; let camTimer = null;

  async function loadJsQr() {
    if (window.jsQR) return window.jsQR;
    await new Promise((ok) => {
      const s = document.createElement('script');
      s.src = 'vendor/jsQR.js'; s.onload = ok; s.onerror = ok;
      document.head.appendChild(s);
    });
    return window.jsQR || null;
  }

  /** source: ImageBitmap | HTMLVideoElement | HTMLImageElement → chuỗi QR hoặc null. */
  async function decodeQr(source) {
    if ('BarcodeDetector' in window) {
      try {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        const r = await det.detect(source);
        if (r[0]?.rawValue) return r[0].rawValue;
        return null;
      } catch { /* thử jsQR */ }
    }
    const jsqr = await loadJsQr();
    if (!jsqr) throw new Error('no_decoder');
    const w = source.videoWidth || source.width; const h = source.videoHeight || source.height;
    if (!w || !h) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return jsqr(img.data, w, h)?.data || null;
  }

  function gotQr(text) {
    const ta = $('#dev-qr');
    if (ta) ta.value = text.trim();
    submitQr();
  }

  async function pickImage(file) {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const text = await decodeQr(bmp);
      if (bmp.close) bmp.close();
      if (!text) return toast('Không tìm thấy mã QR trong ảnh. Hãy chọn ảnh rõ nét, thấy đủ cả mã, không bị cắt hoặc mờ.', true);
      stopCamera();
      gotQr(text);
    } catch (e) {
      toast(e.message === 'no_decoder' ? 'Trình duyệt này chưa hỗ trợ đọc QR từ ảnh. Hãy dùng "Nhập mã thủ công" và dán chuỗi QR.' : 'Không mở được ảnh này. Hãy chọn ảnh định dạng PNG hoặc JPG.', true);
    }
  }

  // Màn quét toàn màn hình (#qs): camera sau, khung quét, đèn flash, ảnh trong máy, nhập mã tay.
  let torchOn = false;

  function stopCamera() {
    if (camTimer) { clearInterval(camTimer); camTimer = null; }
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    torchOn = false;
    const v = $('#qs-video'); if (v) v.srcObject = null;
    const box = $('#qs'); if (box) box.hidden = true;
  }

  // Nhận diện trình duyệt + hệ điều hành để hướng dẫn ĐÚNG chỗ bật quyền camera (iPhone: Chrome/Firefox/Edge là app riêng, quyền nằm ở Cài đặt của iPhone)
  function browserInfo() {
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    const inApp = /Zalo|FBAN|FBAV|FB_IAB|Messenger|Instagram|Line\/|MicroMessenger|TikTok|Telegram/i.test(ua);
    let name = 'Safari';
    if (/CriOS/i.test(ua)) name = 'Chrome';
    else if (/FxiOS/i.test(ua)) name = 'Firefox';
    else if (/EdgiOS|EdgA|Edg\//i.test(ua)) name = 'Edge';
    else if (/OPiOS|OPR\//i.test(ua)) name = 'Opera';
    else if (/SamsungBrowser/i.test(ua)) name = 'Samsung Internet';
    else if (/Firefox/i.test(ua)) name = 'Firefox';
    else if (/Chrome/i.test(ua)) name = 'Chrome';
    else if (!ios) name = 'trình duyệt';
    return { ios, inApp, name };
  }

  /** Các bước bật quyền camera theo đúng trình duyệt đang dùng. */
  function camSteps() {
    const { ios, inApp, name } = browserInfo();
    if (inApp) return ['Bấm nút <b>⋯</b> hoặc <b>⋮</b> ở góc màn hình', 'Chọn <b>Mở bằng trình duyệt</b> (Chrome hoặc Safari)', 'Mở lại trang này rồi bấm <b>Quét bằng camera</b>'];
    if (ios && name === 'Safari') return ['Bấm biểu tượng <b>aA</b> bên trái thanh địa chỉ Safari', 'Chọn <b>Cài đặt trang web</b> (Website Settings)', 'Mục <b>Camera</b> → chọn <b>Cho phép</b>', 'Quay lại và bấm <b>Thử lại</b>'];
    if (ios) return [`Mở ứng dụng <b>Cài đặt</b> của iPhone (biểu tượng bánh răng)`, `Kéo xuống tìm <b>${name}</b> và bấm vào`, 'Bật công tắc <b>Camera</b>', `Quay lại ${name}, tải lại trang rồi bấm <b>Thử lại</b>`];
    if (name === 'Firefox') return ['Bấm biểu tượng <b>ổ khoá 🔒</b> bên trái thanh địa chỉ', 'Chọn <b>Quyền</b> → <b>Camera</b> → <b>Cho phép</b>', 'Quay lại và bấm <b>Thử lại</b>'];
    return [`Bấm biểu tượng <b>ổ khoá 🔒</b> (hoặc ⚙) bên trái thanh địa chỉ ${name}`, 'Chọn <b>Quyền</b> (Permissions)', 'Mục <b>Camera</b> → chọn <b>Cho phép</b>', 'Nếu không thấy: <b>Cài đặt</b> điện thoại → <b>Ứng dụng</b> → trình duyệt → <b>Quyền</b> → <b>Camera</b>', 'Quay lại và bấm <b>Thử lại</b>'];
  }

  function camHelp(err) {
    const { inApp, name, ios } = browserInfo();
    const e = err?.name || '';
    if (inApp) return 'Trình duyệt trong ứng dụng (Zalo/Messenger…) không cho dùng camera. Hãy mở link này bằng Chrome hoặc Safari, hoặc bấm "Chụp ảnh QR".';
    if (e === 'NotAllowedError' || e === 'SecurityError') {
      return ios && name !== 'Safari'
        ? `Camera đang bị chặn cho ${name}. Mở Cài đặt iPhone → ${name} → bật Camera, hoặc bấm "Chụp ảnh QR".`
        : `Camera đang bị chặn cho trang này trên ${name}. Bấm "Cách bật quyền camera" bên dưới hoặc "Chụp ảnh QR".`;
    }
    if (e === 'NotFoundError' || e === 'OverconstrainedError') return 'Không tìm thấy camera trên thiết bị này. Hãy bấm "Chụp ảnh QR" hoặc nhập mã thủ công.';
    if (e === 'NotReadableError' || e === 'AbortError') return 'Camera đang được ứng dụng khác dùng. Đóng ứng dụng đó rồi thử lại, hoặc bấm "Chụp ảnh QR".';
    return 'Không mở được camera' + (e ? ` (${e})` : '') + '. Hãy bấm "Chụp ảnh QR" (dùng ứng dụng camera của máy) hoặc nhập mã thủ công.';
  }

  // Trình duyệt KHÔNG cho trang web mở thẳng màn hình cài đặt của Chrome/Safari (chặn vì bảo mật) → hiện hướng dẫn từng bước
  // đúng loại máy kèm nút "Thử lại" và "Chụp ảnh QR" (không cần quyền camera)
  function showCamHelp(err) {
    document.getElementById('cam-help')?.remove();
    const steps = camSteps();
    const { name } = browserInfo();
    const el = document.createElement('div');
    el.id = 'cam-help'; el.className = 'cam-help';
    el.innerHTML = `<div class="sheet" role="dialog" aria-label="Bật quyền camera">
      <h3>Bật quyền camera cho ${name}</h3>
      <p class="note">Trình duyệt không cho trang web tự mở phần cài đặt, nên làm theo ${steps.length} bước:</p>
      <ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <div class="row"><button type="button" class="primary" id="ch-retry">Thử lại</button><button type="button" class="fit" id="ch-cap">Chụp ảnh QR</button><button type="button" class="fit" id="ch-close">Đóng</button></div>
    </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
    el.querySelector('#ch-close').onclick = () => el.remove();
    el.querySelector('#ch-retry').onclick = () => { el.remove(); toggleCamera(); };
    el.querySelector('#ch-cap').onclick = () => { el.remove(); document.getElementById('dev-cap-file')?.click(); };
  }

  async function toggleCamera() {
    if (camStream) return stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Trình duyệt hoặc thiết bị này không dùng được camera (cần mở bằng HTTPS). Hãy chọn ảnh QR hoặc nhập mã thủ công.', true);
      return openModal(true);
    }
    try {
      // QR tem dài (~240 ký tự) khá dày: xin khung 720p để jsQR đọc được khi QR nhỏ trong khung
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e1) {
      // Bị từ chối quyền thì thử lại vô ích; lỗi khác (ràng buộc độ phân giải, không có camera sau) thì xin camera bất kỳ
      if (e1?.name === 'NotAllowedError' || e1?.name === 'SecurityError') { toast(camHelp(e1), true); showCamHelp(e1); return openModal(true); }
      try { camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
      catch (e2) { toast(camHelp(e2), true); return openModal(true); }
    }
    const m = $('#dev-modal'); if (m) m.hidden = true;
    const v = $('#qs-video');
    v.srcObject = camStream;
    $('#qs').hidden = false;
    await v.play().catch(() => {});
    const caps = camStream.getVideoTracks()[0]?.getCapabilities?.() || {};
    $('#qs-torch').hidden = !caps.torch;
    let busy = false;
    camTimer = setInterval(async () => {
      if (busy || !camStream) return;
      busy = true;
      try {
        const text = await decodeQr(v);
        if (text) { stopCamera(); gotQr(text); }
      } catch (e) {
        if (e.message === 'no_decoder') {
          stopCamera();
          toast('Trình duyệt này chưa hỗ trợ quét QR bằng camera. Hãy chọn ảnh QR hoặc nhập mã thủ công.', true);
          openModal(true);
        }
      } finally { busy = false; }
    }, 250);
  }

  async function toggleTorch() {
    const t = camStream?.getVideoTracks()[0]; if (!t) return;
    torchOn = !torchOn;
    try { await t.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
    $('#qs-torch').setAttribute('aria-label', torchOn ? 'Tắt đèn flash' : 'Bật đèn flash');
  }

  // Lý do thất bại viết cho người dùng phổ thông (bảng dùng chung ở errors.js): chuyện gì xảy ra + nên làm gì.
  function explainAddError(r) {
    const s = session();
    if (!s?.token || s.demo) {
      return {
        ok: false, title: 'Không thêm được thiết bị', code: 'unauthorized',
        reason: 'Bạn đang ở chế độ dùng thử hoặc chưa đăng nhập nên chưa thể thêm thiết bị.',
        hint: 'Đăng xuất, đăng nhập bằng tài khoản thật rồi thêm lại.',
      };
    }
    const i = window.ErrInfo(r.data?.error, r.status);
    return { ok: false, title: 'Không thêm được thiết bị', ...i };
  }

  /** Hộp kết quả giữa màn hình: giữ đến khi người dùng bấm, không tự tắt như toast. */
  function showResult({ ok, title, reason, hint = '', code = '' }) {
    const box = $('#qr-res'); if (!box) return toast(`${title}. ${reason}`, !ok);
    box.className = `qr-res ${ok ? 'ok' : 'bad'}`;
    $('#qr-res-icon').textContent = ok ? '✓' : '✕';
    $('#qr-res-title').textContent = title;
    $('#qr-res-reason').textContent = reason;
    $('#qr-res-hint').textContent = hint;
    $('#qr-res-code').textContent = !ok && code ? `Mã lỗi: ${code}` : '';
    $('#qr-res-retry').hidden = ok;
    $('#qr-res-close').textContent = ok ? 'Xong' : 'Đóng';
    box.hidden = false;
    $(ok ? '#qr-res-close' : '#qr-res-retry')?.focus();
  }

  /** Admin quét QR: hiện đúng giao diện user sẽ thấy, chỉ xem (không điều khiển, không lưu vào tài khoản). */
  function showReview(rv) {
    showResult({
      ok: true,
      title: 'Xem thử (admin) — chưa gắn vào tài khoản',
      reason: `${rv.label || `${rv.site}/${rv.device}`} · ${rv.devices.length} thiết bị${rv.claimed ? ' · tem đã có chủ' : ''}.`,
      hint: 'Tài khoản admin chỉ xem giao diện, không trở thành chủ gateway. User thường quét QR này để dùng thật.',
    });
    const card = document.querySelector('#qr-res .qr-res-card');
    card.querySelector('.qr-prev')?.remove();
    const prev = document.createElement('div');
    prev.className = 'qr-prev';
    prev.innerHTML = rv.devices.map((d) => cardHtml(d, true)).join('') || '<p class="muted">Gateway chưa khai thiết bị con nào.</p>';
    card.insertBefore(prev, card.querySelector('.qr-res-actions'));
    $('#qr-res-close')?.addEventListener('click', () => prev.remove(), { once: true });
  }

  function hideResult(retry) {
    const box = $('#qr-res'); if (box) box.hidden = true;
    if (retry) openModal(true);
  }

  async function submitQr() {
    // QR in trên tem / hiện ở gateway là link login.html?claim=… → lấy phần claim (chuỗi thô vẫn dùng được)
    let qr = ($('#dev-qr')?.value || '').trim();
    const m = /[?&#]claim=([^&#\s]+)/.exec(qr);
    if (m) { try { qr = decodeURIComponent(m[1]); } catch { qr = m[1]; } }
    if (!qr) return toast('Chưa có mã QR. Hãy dán chuỗi mã in trên tem hoặc do quản trị viên cấp vào ô trống.', true);
    const btn = $('#dev-add-go');
    if (btn) btn.disabled = true;
    try {
      let r;
      try {
        r = await api('POST', '/api/devices', { qr });
      } catch {
        return showResult(explainAddError({ ok: false, data: { error: 'network' } }));
      }
      if (!r.ok) return showResult(explainAddError(r));
      if (r.data.review) {   // tài khoản admin: chỉ xem thử, không gắn thiết bị / không thành chủ gateway
        closeModal();
        if ($('#dev-qr')) $('#dev-qr').value = '';
        return showReview(r.data);
      }
      rememberQr(qr);
      closeModal();
      if ($('#dev-qr')) $('#dev-qr').value = '';
      const added = r.data.added || [];
      const fresh = added.filter((a) => !a.already);
      const names = (fresh.length ? fresh : added).map((a) => TYPE_VI[a.type] || a.childId).join(', ');
      showResult(fresh.length
        ? { ok: true, title: 'Thêm thiết bị thành công', reason: `Đã thêm ${fresh.length} thiết bị: ${names}.`, hint: 'Dữ liệu sẽ hiện ngay ở màn hình Thiết bị.' }
        : { ok: true, title: 'Thiết bị đã có sẵn', reason: added.length ? `Tài khoản của bạn đã có: ${names}.` : 'Không có thay đổi nào.', hint: 'Bạn không cần thêm lại.' });
      if (r.data.dashboard) {
        dashboard = r.data.dashboard;
        render();
      } else await load();
      // Đồng bộ site/dev cfg nếu server đổi gateway
      if (window.applySiteFromDevices) await window.applySiteFromDevices(r.data.site, r.data.gateway);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** MQTT: monitor từ d.*; conveyor legacy r[] vẫn đọc được. Type/UI từ dashboard server. */
  function onTelemetry(payload, base) {
    if (!payload || typeof payload !== 'object') return;
    const dd = payload.d || payload.data;   // `data` = tên trong giao thức Dynamic Discovery
    if (dd && typeof dd === 'object') {
      for (const [childId, obj] of Object.entries(dd)) {
        if (obj && typeof obj === 'object') {
          const k = `${base || dashboard?.telemetry?.topicBase || ''}|${childId}`;
          const fresh = { ...obj };
          for (const f of Object.keys(fresh)) {   // vừa gửi lệnh: giữ giá trị người dùng chọn cho tới khi gateway xác nhận (hoặc hết 3,5 giây)
            const h = hold.get(`${k}|${f}`);
            if (!h) continue;
            if (Date.now() > h.until || Number(fresh[f]) === h.v) hold.delete(`${k}|${f}`); else delete fresh[f];
          }
          live[k] = { ...live[k], ...fresh };
        }
      }
    }
    if (Array.isArray(payload.r) && dashboard?.devices) {
      for (const d of dashboard.devices) {
        if (d.type !== 'conveyor') continue;
        const r = payload.r;
        const count = (r[14] || 0) + (r[15] || 0) * 65536;
        live[lk(d)] = {
          ...live[lk(d)],
          count,
          runReq: r[6] || 0,
          runPct: r[8] === 1 ? 100 : 0,
          speed: 0,
        };
      }
    }
    render();
  }

  function injectDemoLive() {
    if (!dashboard?.devices?.length) return;
    for (const d of dashboard.devices) {
      if (d.type === 'env') {
        live[lk(d)] = { t: 26 + Math.random() * 4, h: 55 + Math.random() * 10 };
      } else if (d.type === 'pump') {
        live[lk(d)] = { run: 1, hours: 12.4, flow: 30 + Math.random() * 20 };
      } else if (d.type === 'switch' || d.type === 'relay') {
        live[lk(d)] = { on: live[lk(d)]?.on ?? 0 };
      } else if (d.type === 'energy') {
        live[lk(d)] = { kw: 1.2 + Math.random(), kwh: 340 };
      } else if (d.type === 'tank') {
        live[lk(d)] = { level: 40 + Math.random() * 40 };
      } else if (d.type === 'motor') {
        live[lk(d)] = { run: 1, rpm: 1400 };
      }
    }
    render();
  }

  /** Gateway publish <base>/config: server đã upsert → tải lại dashboard (debounce vì ingest ghi DB trước khi UI hỏi). */
  let cfgTimer = null;
  function onConfig() {
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => { load().catch(() => {}); }, 1500);
  }

  document.addEventListener('plc-icstyle', () => { lastSig = ''; render(); renderSample(); });   // đổi kiểu/màu/chuyển động: vẽ lại ngay (cả thẻ mẫu ở Cài đặt)
  /** Thẻ mẫu ở Cài đặt → Kiểu hiển thị: đổi kiểu / màu / chuyển động là thấy thay đổi ngay, không cần sang tab Thiết bị. */
  function renderSample() {
    const host = document.getElementById('ic-live'); if (!host) return;
    const d = { id: 'sample', childId: '__sample', type: 'pump', icon: 'pump', title: 'Bơm mẫu', widgets: [
      { id: 's1', kind: 'tank', bind: 'level', label: 'Mức nước', unit: '%', min: 0, max: 100, low: 15, high: 90 },
      { id: 's2', kind: 'gauge', bind: 'flow', label: 'Lưu lượng', unit: 'L/phút', min: 0, max: 100, low: 15, high: 85 },
      { id: 's3', kind: 'toggle', bind: 'run', label: 'Bơm', onText: 'Chạy', offText: 'Dừng', cmd: { key: 'run' } }] };
    live[lk(d)] = { level: 62, flow: 48, run: 1 };
    host.innerHTML = cardHtml(d, true);
  }
  document.addEventListener('DOMContentLoaded', renderSample);

  window.DevicesUi = { load, onConfig, onTelemetry, injectDemoLive, openModal, getDashboard: () => dashboard };

  document.addEventListener('DOMContentLoaded', () => {
    $('#dev-add')?.addEventListener('click', openModal);
    $('#dev-modal-close')?.addEventListener('click', closeModal);
    $('#dev-add-go')?.addEventListener('click', submitQr);
    $('#dev-scan')?.addEventListener('click', toggleCamera);
    $('#qr-res-retry')?.addEventListener('click', () => hideResult(true));
    $('#qr-res-close')?.addEventListener('click', () => hideResult(false));
    $('#qs-back')?.addEventListener('click', stopCamera);
    $('#qs-torch')?.addEventListener('click', toggleTorch);
    $('#qs-gallery')?.addEventListener('click', () => $('#dev-file')?.click());
    $('#qs-mine')?.addEventListener('click', openMyQr);
    $('#mq-back')?.addEventListener('click', closeMyQr);
    $('#mq-copy')?.addEventListener('click', copyMyQr);
    $('#mq-save')?.addEventListener('click', saveMyQr);
    $('#mq-dots')?.addEventListener('click', (e) => { const i = e.target.dataset?.i; if (i != null) { mqIdx = +i; renderMyQr(); } });
    $('#qs-manual')?.addEventListener('click', () => { stopCamera(); openModal(true); });
    $('#dev-pick')?.addEventListener('click', () => $('#dev-file')?.click());
    // "Chụp ảnh QR": mở app camera của máy (không cần cấp quyền camera cho trang web) rồi đọc QR từ ảnh vừa chụp
    $('#dev-cap')?.addEventListener('click', () => $('#dev-cap-file')?.click());
    $('#dev-cap-file')?.addEventListener('change', (e) => { pickImage(e.target.files?.[0]); e.target.value = ''; });
    $('#dev-file')?.addEventListener('change', (e) => { pickImage(e.target.files?.[0]); e.target.value = ''; });
    $('#dev-modal')?.addEventListener('click', (e) => { if (e.target.id === 'dev-modal') closeModal(); });
    // Laptop: dán ảnh (Ctrl+V) hoặc kéo-thả ảnh QR vào màn quét / khung nhập mã
    const scanOpen = () => !$('#qs')?.hidden || !$('#dev-modal')?.hidden;
    const imgOf = (dt) => [...(dt?.files || [])].find((f) => f.type.startsWith('image/'));
    document.addEventListener('paste', (e) => {
      const f = scanOpen() && imgOf(e.clipboardData);
      if (f) { e.preventDefault(); pickImage(f); }
    });
    document.addEventListener('dragover', (e) => { if (scanOpen()) e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      const f = scanOpen() && imgOf(e.dataTransfer);
      if (f) { e.preventDefault(); pickImage(f); }
    });
    load();
  });
}());
