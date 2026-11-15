'use strict';
/* Giải pháp "Năng lượng mặt trời" (lớp phủ lên webapp cơ bản):
 *   Tổng quan  — sơ đồ dòng năng lượng PV → inverter → tải / lưới / pin + chỉ số nhanh (thẻ thiết bị của bản cơ bản vẫn nằm bên dưới)
 *   Năng lượng — sản lượng theo giờ/ngày, tổng kết, CO₂ tránh được
 *   Thiết bị   — inverter / pin / công tơ: trạng thái trực tuyến, số liệu chính, cảnh báo, thêm thiết bị bằng QR
 * Dùng lại đúng luồng số liệu của bản cơ bản (DevicesUi.onTelemetry, d.<thiết bị>.<field>); đăng nhập, chat, gói, cài đặt… là mã của bản cơ bản. */
(function () {
  const dash = document.getElementById('tab-dash');
  const nav = document.getElementById('nav');
  const main = document.querySelector('main');
  if (!dash || !nav || !main) return;

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const LSget = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };

  /* ------------------------------------------------------------------ số liệu */
  // Tên field gateway có thể gửi (kW hoặc W); khoá đầu tiên có số liệu thắng.
  // grid: + = mua điện, − = bán lên lưới; batt: + = đang sạc, − = đang xả.
  const KEYS = {
    pv: [['pv_kw', 1], ['pv_power', 1], ['solar_kw', 1], ['pac_kw', 1], ['pv_w', 1e-3], ['pac', 1e-3], ['kw', 1]],
    load: [['load_kw', 1], ['home_kw', 1], ['consumption_kw', 1], ['load_w', 1e-3], ['load', 1e-3]],
    grid: [['grid_kw', 1], ['grid_w', 1e-3], ['grid', 1e-3]],
    batt: [['batt_kw', 1], ['bat_kw', 1], ['batt_w', 1e-3], ['bat_w', 1e-3]],
    soc: [['batt_soc', 1], ['bat_soc', 1], ['soc', 1]],
    today: [['e_today', 1], ['yield_today', 1], ['kwh_today', 1], ['today_kwh', 1]],
    total: [['e_total', 1], ['yield_total', 1], ['kwh_total', 1], ['total_kwh', 1], ['kwh', 1]],
  };
  const FAULT = /^(fault|alarm|err|error|fault_code|alarm_code)$/i;
  const vals = {};                 // field → số mới nhất (gộp mọi thiết bị)
  const devs = new Map();          // childId → { v: {field: số}, ts }
  let lastTs = 0;
  let demo = false, demoSeen = false;

  const num = (x) => { const n = Number(x); return x != null && x !== '' && typeof x !== 'boolean' && Number.isFinite(n) ? n : null; };
  const pick = (list) => { for (const [k, m] of list) { const v = num(vals[k]); if (v != null) return v * m; } return null; };
  const f1 = (v, d = 1) => (v == null ? '—' : v.toFixed(d));
  const EPS = 0.005;

  /* ------------------------------------------------------------------ lịch sử sản lượng (lưu trên thiết bị này) */
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const HKEY = 'solarKwh';         // { "YYYY-MM-DDTHH": kWh }
  const realHist = LSget(HKEY, {});
  let hist = realHist;
  // chạy thử: lịch sử mẫu 30 ngày (chỉ trong bộ nhớ, không ghi đè lịch sử thật)
  const demoHist = (() => {
    const h = {}, now = new Date();
    for (let d = 0; d < 30; d++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d), k = dayKey(day), f = 0.55 + 0.45 * Math.abs(Math.sin(d * 1.7));
      for (let hr = 6; hr < 18; hr++) {
        if (d === 0 && hr > now.getHours()) break;
        h[`${k}T${pad(hr)}`] = Math.sin(((hr - 6 + 0.5) / 12) * Math.PI) * 4.2 * f;
      }
    }
    return h;
  })();
  let lastInt = 0, lastSave = 0;
  function integrate(pvKw, now) {
    if (pvKw != null && lastInt && now - lastInt < 120000 && pvKw > 0) {
      const d = new Date(now), k = `${dayKey(d)}T${pad(d.getHours())}`;
      hist[k] = (hist[k] || 0) + pvKw * (now - lastInt) / 3.6e6;
    }
    lastInt = now;
    if (now - lastSave > 30000) {
      lastSave = now;
      const cut = dayKey(new Date(now - 45 * 864e5));
      for (const k of Object.keys(hist)) if (k.slice(0, 10) < cut) delete hist[k];
      if (hist === realHist) LSset(HKEY, hist);
    }
  }
  const sumDay = (key) => { let s = 0; for (let h = 0; h < 24; h++) s += hist[`${key}T${pad(h)}`] || 0; return s; };

  function ingest(p) {
    const d = p && (p.d || p.data);
    if (!d || typeof d !== 'object') return;
    const now = Date.now();
    for (const [id, o] of Object.entries(d)) {
      if (!o || typeof o !== 'object') continue;
      const rec = devs.get(id) || { v: {}, ts: 0 };
      for (const [k, v] of Object.entries(o)) { rec.v[k.toLowerCase()] = v; vals[k.toLowerCase()] = v; }
      rec.ts = now; devs.set(id, rec);
    }
    lastTs = now;
    integrate(pick(KEYS.pv), now);
  }

  /* ------------------------------------------------------------------ Tổng quan: sơ đồ dòng năng lượng */
  const card = document.createElement('div');
  card.id = 'solar-card';
  card.innerHTML = '<h2><span class="sun"></span>Hệ thống điện mặt trời<span class="st" id="solar-st">Chờ dữ liệu…</span></h2>'
    + '<svg id="solar-flow" viewBox="0 0 340 250" role="img" aria-label="Sơ đồ dòng năng lượng"></svg>'
    + '<div class="solar-kpis" id="solar-kpis"></div><p class="muted" id="solar-demo" hidden>Đang hiển thị dữ liệu mẫu (chế độ chạy thử).</p>';
  dash.insertBefore(card, dash.firstChild);

  const node = (x, y, w, label, val, unit, color) =>
    `<rect class="box" x="${x}" y="${y}" width="${w}" height="56" rx="10" style="stroke:${color}"/>`
    + `<text x="${x + w / 2}" y="${y + 18}" text-anchor="middle">${label}</text>`
    + `<text class="v" x="${x + w / 2}" y="${y + 38}" text-anchor="middle">${val}</text>`
    + `<text class="u" x="${x + w / 2}" y="${y + 51}" text-anchor="middle">${unit}</text>`;
  // v > 0: chảy theo chiều vẽ đường; v < 0: ngược; 0: dây tĩnh
  const wire = (d, v, color) => `<path class="wire" d="${d}"/>` + (v ? `<path class="flow${v < 0 ? ' rev' : ''}" d="${d}" style="stroke:${color}"/>` : '');
  const dir = (v) => (v != null && Math.abs(v) > EPS ? Math.sign(v) : 0);

  function kpiValues() {
    const pv = pick(KEYS.pv), load = pick(KEYS.load);
    const now = new Date();
    const today = pick(KEYS.today) ?? (Object.keys(hist).some((k) => k.startsWith(dayKey(now))) ? sumDay(dayKey(now)) : null);
    const total = pick(KEYS.total);
    const self = pv != null && load != null && pv > EPS ? Math.min(100, Math.round((Math.min(pv, load) / pv) * 100)) : null;
    return { pv, today, total, self };
  }

  function drawFlow() {
    const pv = pick(KEYS.pv), load = pick(KEYS.load), grid = pick(KEYS.grid), batt = pick(KEYS.batt), soc = pick(KEYS.soc);
    $('#solar-flow').innerHTML =
      wire('M85 56 V108 H150', dir(pv) > 0 ? 1 : 0, 'var(--sun)')              // PV → inverter
      + wire('M190 108 H255 V56', dir(load) > 0 ? 1 : 0, 'var(--load)')        // inverter → tải
      + wire('M170 128 V180', -dir(grid), 'var(--grid)')                        // mua (+) chảy lên inverter, bán (−) chảy xuống lưới
      + wire('M150 118 H52 V180', -dir(batt), 'var(--bat)')                     // sạc (+) chảy xuống pin, xả (−) chảy lên
      + '<rect class="box" x="150" y="88" width="40" height="40" rx="8"/><text x="170" y="112" text-anchor="middle">INV</text>'
      + node(30, 0, 110, '☀ Pin mặt trời', f1(pv, 2), 'kW', 'var(--sun)')
      + node(200, 0, 110, '⌂ Tải', f1(load, 2), 'kW', 'var(--load)')
      + node(115, 180, 110, '⚡ Lưới', f1(grid == null ? null : Math.abs(grid), 2), grid == null ? 'kW' : (grid < -EPS ? 'kW · bán lên lưới' : 'kW · mua từ lưới'), 'var(--grid)')
      + node(0, 180, 105, '🔋 Pin', soc != null ? f1(soc, 0) + '%' : f1(batt == null ? null : Math.abs(batt), 2),
        soc != null ? (batt == null ? '' : (batt > EPS ? 'đang sạc' : batt < -EPS ? 'đang xả' : 'chờ')) : 'kW', 'var(--bat)');
    const k = kpiValues();
    $('#solar-kpis').innerHTML =
      `<div><span>Công suất hiện tại</span><b>${f1(k.pv, 2)}</b> <small>kW</small></div>`
      + `<div><span>Sản lượng hôm nay</span><b>${f1(k.today)}</b> <small>kWh</small></div>`
      + `<div><span>Tổng sản lượng</span><b>${f1(k.total, 0)}</b> <small>kWh</small></div>`
      + `<div><span>Tự dùng</span><b>${k.self == null ? '—' : k.self}</b> <small>%</small></div>`;
    const st = $('#solar-st'), fresh = lastTs && Date.now() - lastTs < 30000;
    st.textContent = !lastTs ? 'Chờ dữ liệu…' : fresh ? '● Trực tuyến' : '▲ Mất liên lạc';
    st.className = 'st ' + (!lastTs ? '' : fresh ? 'live' : 'stale');
    $('#solar-demo').hidden = !demo;
  }

  /* ------------------------------------------------------------------ tab Năng lượng */
  const energy = document.createElement('section');
  energy.id = 'tab-energy'; energy.className = 'tab cols'; energy.hidden = true;
  energy.innerHTML = '<div class="panel span"><h2>Sản lượng điện</h2>'
    + '<div class="seg" id="en-range"><button data-r="day" class="sel">Hôm nay</button><button data-r="7">7 ngày</button><button data-r="30">30 ngày</button></div>'
    + '<canvas id="en-chart" height="220" style="width:100%;display:block"></canvas>'
    + '<p class="muted" id="en-note"></p></div>'
    + '<div class="panel"><h2>Tổng kết</h2><div class="solar-kpis" id="en-sum"></div></div>'
    + '<div class="panel"><h2>Tác động môi trường</h2><div class="solar-kpis" id="en-env"></div>'
    + '<p class="muted">Quy đổi theo hệ số lưới điện 0,68 kg CO₂/kWh; 1 cây hấp thụ ≈ 21 kg CO₂/năm.</p></div>';
  main.appendChild(energy);
  let range = 'day';

  function series() {
    const now = new Date();
    if (range === 'day') {
      const k = dayKey(now);
      return { labels: Array.from({ length: 24 }, (_, h) => String(h)), data: Array.from({ length: 24 }, (_, h) => hist[`${k}T${pad(h)}`] || 0), unit: 'giờ' };
    }
    const n = Number(range), labels = [], data = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      labels.push(`${d.getDate()}/${d.getMonth() + 1}`); data.push(sumDay(dayKey(d)));
    }
    return { labels, data, unit: 'ngày' };
  }
  function drawChart() {
    const cv = $('#en-chart'); if (!cv || energy.hidden) return;
    const { labels, data } = series();
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = 220;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    const cs = getComputedStyle(document.documentElement), col = (v) => cs.getPropertyValue(v).trim();
    const L = 34, B = 22, T = 8, W = w - L - 6, H = h - B - T;
    const max = Math.max(1, ...data) * 1.1;
    g.font = '11px system-ui'; g.fillStyle = col('--mut'); g.strokeStyle = col('--line'); g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = T + H - (H * i) / 4;
      g.beginPath(); g.moveTo(L, y); g.lineTo(L + W, y); g.stroke();
      g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText((max * i / 4).toFixed(max < 10 ? 1 : 0), L - 4, y);
    }
    const bw = W / data.length;
    g.fillStyle = col('--sun');
    data.forEach((v, i) => { const bh = (v / max) * H; g.fillRect(L + i * bw + bw * 0.15, T + H - bh, bw * 0.7, bh); });
    g.fillStyle = col('--mut'); g.textAlign = 'center'; g.textBaseline = 'top';
    const every = Math.ceil(data.length / 8);
    labels.forEach((t, i) => { if (i % every === 0) g.fillText(t, L + i * bw + bw / 2, T + H + 5); });
    const sum = data.reduce((a, b) => a + b, 0);
    $('#en-note').textContent = (range === 'day' ? 'kWh theo giờ trong hôm nay' : `kWh theo ngày, ${range} ngày gần nhất`)
      + ` · Tổng: ${sum.toFixed(1)} kWh. Lịch sử được ghi trên thiết bị này khi ứng dụng đang mở.`;
  }
  function drawEnergy() {
    const k = kpiValues(), now = new Date();
    let w7 = 0, w30 = 0;
    for (let i = 0; i < 30; i++) { const s = sumDay(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))); w30 += s; if (i < 7) w7 += s; }
    $('#en-sum').innerHTML =
      `<div><span>Hôm nay</span><b>${f1(k.today)}</b> <small>kWh</small></div>`
      + `<div><span>7 ngày</span><b>${w7.toFixed(1)}</b> <small>kWh</small></div>`
      + `<div><span>30 ngày</span><b>${w30.toFixed(1)}</b> <small>kWh</small></div>`
      + `<div><span>Tổng cộng</span><b>${f1(k.total, 0)}</b> <small>kWh</small></div>`;
    const base = k.total ?? w30;
    $('#en-env').innerHTML =
      `<div><span>CO₂ tránh được</span><b>${(base * 0.68).toFixed(0)}</b> <small>kg</small></div>`
      + `<div><span>Tương đương</span><b>${Math.round((base * 0.68) / 21)}</b> <small>cây/năm</small></div>`;
    drawChart();
  }
  $('#en-range', energy).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-r]'); if (!b) return;
    range = b.dataset.r;
    energy.querySelectorAll('#en-range button').forEach((x) => x.classList.toggle('sel', x === b));
    drawChart();
  });
  addEventListener('resize', () => drawChart());

  /* ------------------------------------------------------------------ tab Thiết bị */
  const devsTab = document.createElement('section');
  devsTab.id = 'tab-devs'; devsTab.className = 'tab'; devsTab.hidden = true;
  devsTab.innerHTML = '<div class="panel"><div class="row" style="justify-content:space-between;align-items:center">'
    + '<h2 style="margin:0">Thiết bị hệ thống</h2><button id="dv-add" class="primary fit">＋ Thêm thiết bị</button></div>'
    + '<div id="dv-sum" class="solar-kpis"></div><div id="dv-list" class="dv-list"></div></div>';
  main.appendChild(devsTab);
  $('#dv-add').onclick = () => { if (window.DevicesUi?.openModal) window.DevicesUi.openModal(); };

  const TYPE = { inverter: ['☀', 'Inverter'], battery: ['🔋', 'Pin lưu trữ'], meter: ['⚡', 'Công tơ'], energy: ['⚡', 'Công tơ'], env: ['🌡', 'Môi trường'] };
  const guessType = (id, v, listed) => {
    const t = String(listed?.type || '').toLowerCase();
    if (TYPE[t]) return t;
    if ('soc' in v || 'batt_soc' in v || 'bat_soc' in v) return 'battery';
    if ('pv_kw' in v || 'pv_power' in v || 'pac' in v || 'pac_kw' in v || 'e_today' in v) return 'inverter';
    if ('grid_kw' in v || 'kwh' in v || 'kw' in v) return 'meter';
    return t || 'device';
  };
  const UNIT = { kw: 'kW', kwh: 'kWh', pv_kw: 'kW', grid_kw: 'kW', load_kw: 'kW', batt_kw: 'kW', e_today: 'kWh', e_total: 'kWh', soc: '%', batt_soc: '%', temp: '°C', t: '°C', v: 'V', voltage: 'V', a: 'A', current: 'A', hz: 'Hz', eff: '%' };
  const LABEL = { kw: 'Công suất', kwh: 'Điện năng', pv_kw: 'Công suất PV', grid_kw: 'Lưới', load_kw: 'Tải', batt_kw: 'Công suất pin', e_today: 'Hôm nay', e_total: 'Tổng', soc: 'Dung lượng', batt_soc: 'Dung lượng', temp: 'Nhiệt độ', t: 'Nhiệt độ', v: 'Điện áp', voltage: 'Điện áp', a: 'Dòng', current: 'Dòng', hz: 'Tần số', eff: 'Hiệu suất' };
  function drawDevices() {
    const listed = new Map();
    if (!demo) for (const d of (window.DevicesUi?.getDashboard?.()?.devices || [])) listed.set(d.childId, d);   // chạy thử: chỉ liệt kê thiết bị mẫu năng lượng mặt trời
    const ids = new Set([...listed.keys(), ...devs.keys()]);
    const now = Date.now();
    let online = 0, faults = 0;
    const rows = [...ids].map((id) => {
      const rec = devs.get(id), meta = listed.get(id), v = rec?.v || {};
      const on = !!rec && now - rec.ts < 30000;
      const fault = Object.entries(v).some(([k, x]) => FAULT.test(k) && Number(x) > 0);
      if (on) online++; if (fault) faults++;
      const ty = guessType(id, v, meta), [ic, tn] = TYPE[ty] || ['▣', meta?.type || 'Thiết bị'];
      const items = Object.entries(v).filter(([k, x]) => num(x) != null && !FAULT.test(k)).slice(0, 6)
        .map(([k, x]) => `<div><span>${esc(LABEL[k] || k)}</span><b>${esc(f1(num(x), Math.abs(num(x)) >= 100 ? 0 : 2).replace(/\.00$/, ''))}</b> <small>${esc(UNIT[k] || '')}</small></div>`).join('');
      return `<div class="dv${fault ? ' bad' : ''}"><div class="dv-h"><span class="dv-i">${ic}</span><div><b>${esc(meta?.title || id)}</b>`
        + `<small>${esc(tn)} · <code>${esc(id)}</code></small></div>`
        + `<span class="dv-s ${fault ? 'bad' : on ? 'on' : 'off'}">${fault ? '▲ Lỗi' : on ? '● Trực tuyến' : '■ Chưa có dữ liệu'}</span></div>`
        + (items ? `<div class="solar-kpis">${items}</div>` : '') + '</div>';
    });
    $('#dv-sum').innerHTML = `<div><span>Thiết bị</span><b>${ids.size}</b></div><div><span>Trực tuyến</span><b>${online}</b></div><div><span>Cảnh báo / lỗi</span><b>${faults}</b></div>`;
    $('#dv-list').innerHTML = rows.join('') || '<p class="muted">Chưa có thiết bị. Bấm “＋ Thêm thiết bị” rồi quét mã QR trên tem của inverter / gateway.</p>';
  }

  /* ------------------------------------------------------------------ thanh điều hướng + chuyển tab */
  const mk = (tab, label, svg) => {
    const b = document.createElement('button');
    b.dataset.tab = tab; b.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg><span>${label}</span>`;
    return b;
  };
  const bEn = mk('energy', 'Năng lượng', '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>');
  const bDv = mk('devs', 'Thiết bị', '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>');
  const setBtn = nav.querySelector('button[data-tab="set"]');
  nav.insertBefore(bEn, setBtn); nav.insertBefore(bDv, setBtn);

  const MINE = { energy, devs: devsTab };
  const hideMine = () => Object.values(MINE).forEach((s) => { s.hidden = true; });
  function showMine(t) {
    document.querySelectorAll('main > .tab').forEach((s) => { s.hidden = true; });
    MINE[t].hidden = false;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    const title = $('#title'); if (title) title.textContent = $('span', t === 'energy' ? bEn : bDv).textContent;
    if (t === 'energy') drawEnergy(); else drawDevices();
  }
  bEn.onclick = () => showMine('energy');
  bDv.onclick = () => showMine('devs');
  // bản cơ bản gọi showTab() ở nhiều nơi (đổi tab, sau khi lưu…): luôn ẩn tab của giải pháp trước khi nó chạy
  if (typeof window.showTab === 'function' && !window.showTab.__solar) {
    const orig = window.showTab;
    window.showTab = function solarShowTab(t) { hideMine(); return orig.apply(this, arguments); };
    window.showTab.__solar = true;
  }

  /* ------------------------------------------------------------------ nối vào luồng số liệu + chế độ chạy thử */
  function demoTick() {
    const t = Date.now() / 1000, d = new Date();
    const sun = Math.max(0, Math.sin(((d.getHours() + d.getMinutes() / 60 - 6) / 12) * Math.PI));   // đường cong mặt trời 6h–18h
    const pv = Math.max(0, (sun || 0.55) * 4.2 + Math.sin(t / 7) * 0.15);
    const load = 1.1 + 0.5 * Math.sin(t / 23) + 0.2 * Math.sin(t / 5);
    const net = pv - load, soc = 62 + 18 * Math.sin(t / 90);
    const batt = Math.max(-1.5, Math.min(1.5, net * 0.6));
    const grid = -(net - batt);
    const today = 12.4 + (d.getHours() * 0.35);
    ingest({ d: {
      inv1: { pv_kw: pv, e_today: today, e_total: 18420 + today, temp: 41 + sun * 8, eff: 97.2, fault: 0, v: 231 },
      bat1: { batt_kw: batt, batt_soc: soc, temp: 29 },
      meter1: { grid_kw: grid, load_kw: load, kwh: 20310 },
    } });
    drawFlow();
    if (!energy.hidden) drawEnergy();
    if (!devsTab.hidden) drawDevices();
  }

  function hook() {
    const ui = window.DevicesUi;
    if (!ui) return false;
    if (ui.__solar) return true;
    const orig = ui.onTelemetry;
    ui.onTelemetry = (p, b) => {
      try {
        // chạy thử: bỏ qua dữ liệu mẫu của bản cơ bản (băng tải/bơm…), dùng dữ liệu mẫu năng lượng mặt trời
        if (!demo) { ingest(p); drawFlow(); if (!energy.hidden) drawEnergy(); if (!devsTab.hidden) drawDevices(); }
      } catch (e) { console.warn('solar', e); }
      return orig(p, b);
    };
    ui.__solar = true;
    return true;
  }
  if (!hook()) document.addEventListener('DOMContentLoaded', hook);

  setInterval(() => {
    try { demo = typeof cfg !== 'undefined' && cfg.demo === true; } catch { demo = false; }
    if (demo && !demoSeen) { demoSeen = true; devs.clear(); for (const k of Object.keys(vals)) delete vals[k]; }   // bỏ số liệu mẫu của bản cơ bản đã lọt vào trước khi biết đang chạy thử
    hist = demo ? demoHist : realHist;
    if (demo) demoTick(); else { drawFlow(); if (!devsTab.hidden) drawDevices(); }
  }, 2000);
  drawFlow();
})();
