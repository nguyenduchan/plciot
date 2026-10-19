'use strict';
/* Grafana-style dashboard: draggable/resizable panels (gridstack) + fast time-series charts (uPlot),
   fed from the on-device database (db.js). Runs entirely in the browser. */
const Dash = (() => {
  const SPANS = { 900000: '15 phút', 3600000: '1 giờ', 21600000: '6 giờ', 86400000: '24 giờ', 604800000: '7 ngày', 2592000000: '30 ngày' };
  const DEFAULT = [
    { id: 'cnt', x: 0, y: 0, w: 3, h: 2 }, { id: 'speed', x: 3, y: 0, w: 3, h: 2 }, { id: 'sum', x: 6, y: 0, w: 3, h: 2 }, { id: 'alm', x: 9, y: 0, w: 3, h: 2 },
    { id: 'ctl', x: 0, y: 2, w: 6, h: 2 }, { id: 'run', x: 6, y: 2, w: 6, h: 2 },
    { id: 'bars', x: 0, y: 4, w: 6, h: 4 }, { id: 'cum', x: 6, y: 4, w: 6, h: 4 },
    { id: 'line', x: 0, y: 8, w: 6, h: 3 }, { id: 'tl', x: 6, y: 8, w: 6, h: 3 },
    { id: 'tbl', x: 0, y: 11, w: 6, h: 4 }, { id: 'log', x: 6, y: 11, w: 6, h: 4 }, { id: 'db', x: 0, y: 15, w: 12, h: 4 },
  ];
  const MOBILE = [   // phones: same 12-column grid; stat tiles in pairs, charts full width
    { id: 'cnt', x: 0, y: 0, w: 6, h: 2 }, { id: 'speed', x: 6, y: 0, w: 6, h: 2 }, { id: 'sum', x: 0, y: 2, w: 6, h: 2 }, { id: 'alm', x: 6, y: 2, w: 6, h: 2 },
    { id: 'ctl', x: 0, y: 4, w: 12, h: 2 }, { id: 'run', x: 0, y: 6, w: 12, h: 2 },
    { id: 'bars', x: 0, y: 8, w: 12, h: 4 }, { id: 'cum', x: 0, y: 12, w: 12, h: 4 },
    { id: 'line', x: 0, y: 16, w: 12, h: 3 }, { id: 'tl', x: 0, y: 19, w: 12, h: 3 },
    { id: 'tbl', x: 0, y: 22, w: 12, h: 5 }, { id: 'log', x: 0, y: 27, w: 12, h: 4 }, { id: 'db', x: 0, y: 31, w: 12, h: 6 },
  ];
  const TITLES = { speed: 'Tốc độ băng tải', ctl: 'Điều khiển máy', cum: 'Số lượng đếm theo thời gian', cnt: 'Số lượng hiện tại', sum: 'Sản lượng trong khoảng', run: 'Tỷ lệ chạy băng tải', alm: 'Cảnh báo', bars: 'Sản lượng theo thời gian',
    line: 'Tỷ lệ chạy (%)', tl: 'Trạng thái đầu ra', tbl: 'Thời gian bật từng đầu ra', log: 'Nhật ký cảnh báo', db: 'Dữ liệu trên thiết bị' };
  const STEPS = [60e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 10800e3, 21600e3, 43200e3, 86400e3];
  const pad = (n) => String(n).padStart(2, '0');

  let grid = null, range = 3600000, editing = false, busy = false, lastRun = 0, charts = {}, lastData = null;
  const phone = () => innerWidth < 900;
  let builtPhone = null;
  const el = (id) => document.getElementById('p-' + id);

  function fmtT(ms, span) {
    const d = new Date(ms);
    return span <= 36 * 3600e3 ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}h`;
  }
  const hmsShort = (s) => `${Math.floor(s / 3600)} giờ ${pad(Math.floor(s / 60) % 60)} phút`;

  function layoutFor() {
    if (phone()) return MOBILE;
    const saved = LS.get('dashLayout', null);
    return Array.isArray(saved) && saved.length === DEFAULT.length ? saved : DEFAULT;
  }
  function build() {
    builtPhone = phone();
    grid.removeAll();
    layoutFor().forEach((p) => grid.addWidget({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h,
      content: `<div class="gs-panel"><div class="gs-title">${TITLES[p.id]}</div><div class="gs-body ${['cnt', 'sum', 'run', 'alm', 'speed', 'ctl'].includes(p.id) ? 'stat' : ''}" id="p-${p.id}"></div></div>` }));
  }

  function livePanels() {
    el('speed').innerHTML = '<div class="v"><span id="d-spd">—</span><small> sp/phút</small></div><div class="bar"><i id="d-spdbar"></i></div><div class="d" id="d-spdd"></div>';
    el('ctl').innerHTML = '<div class="ctlbox"><div class="row"><button id="dc-start" class="primary">▶ Chạy</button><button id="dc-stop" class="danger">■ Dừng máy</button></div><div class="d" id="dc-d"></div></div>';
  }

  function init() {
    if (grid) return;
    range = +LS.get('dashRange', 3600000);
    grid = GridStack.init({ column: 12, cellHeight: 70, margin: 6, float: false, animate: false, staticGrid: true, disableOneColumnMode: true }, '#dgrid');
    build(); livePanels();
    grid.on('change', () => { if (editing && !phone()) LS.set('dashLayout', grid.save(false).map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))); });
    addEventListener('resize', onResize);
    document.querySelectorAll('#drange button').forEach((b) => b.onclick = () => { range = +b.dataset.ms; LS.set('dashRange', range); refresh(true); });
    $('#d-edit').onclick = toggleEdit;
    $('#d-reset').onclick = () => { LS.set('dashLayout', null); build(); livePanels(); draw(lastData); };
    $('#dgrid').addEventListener('click', onPanelClick);
  }

  let rz = null;
  function onResize() {
    clearTimeout(rz);
    rz = setTimeout(() => {
      if (!grid || $('#tab-rep').hidden) return;
      if (builtPhone !== phone()) { editing = false; grid.setStatic(true); build(); livePanels(); }
      draw(lastData);
    }, 200);
  }
  function toggleEdit() {
    if (phone()) { toast('Sắp xếp bố cục dùng trên màn hình rộng'); return; }
    editing = !editing; grid.setStatic(!editing);
    $('#d-edit').textContent = editing ? 'Xong' : 'Sắp xếp'; $('#d-edit').classList.toggle('sel', editing);
    $('#dgrid').classList.toggle('editing', editing);
    if (!editing) setTimeout(() => draw(lastData), 50);
  }

  /* ---------------------------------------------------------------- data */
  async function refresh(force) {
    if (busy || $('#tab-rep').hidden) return;
    if (!force && Date.now() - lastRun < 5000) return;
    busy = true; lastRun = Date.now();
    try {
      const to = Date.now(), from = to - range, r = await DB.series(from, to);
      lastData = { from, to, ...r, outN: names(cfg.outNames, 'Y') };
      draw(lastData);
    } finally { busy = false; }
  }

  function bucketize(d) {
    const span = d.to - d.from, step = STEPS.find((s) => span / s <= 60) || STEPS[STEPS.length - 1];
    const t0 = Math.floor(d.from / step) * step, n = Math.floor((d.to - t0) / step) + 1;
    const xs = [], sum = new Array(n).fill(0), runW = new Array(n).fill(0), w = new Array(n).fill(0);
    for (let k = 0; k < n; k++) xs.push((t0 + k * step) / 1000);
    d.rows.forEach((r) => {
      const k = Math.floor((r.t - t0) / step); if (k < 0 || k >= n) return;
      sum[k] += r.d || 0; runW[k] += r.run * r.n; w[k] += r.n;
    });
    return { xs, sum, run: runW.map((x, k) => (w[k] ? Math.round(x / w[k] * 100) : null)), step };
  }

  /* ---------------------------------------------------------------- drawing */
  function theme() {
    const c = getComputedStyle(document.documentElement), g = (v) => c.getPropertyValue(v).trim();
    return { acc: g('--acc'), mut: g('--mut'), line: g('--line'), ok: g('--ok'), warn: g('--warn'), on: g('--on') };
  }
  function uplot(id, data, series, scaleY, th, span) { uplotAt(el(id), id, data, series, scaleY, th, span); }
  function uplotAt(host, id, data, series, scaleY, th, span) {
    if (!host) return;
    if (charts[id]) { charts[id].destroy(); charts[id] = null; }
    host.innerHTML = '';
    const w = host.clientWidth, h = host.clientHeight;
    if (w < 40 || h < 50) return;
    const ax = { stroke: th.mut, grid: { stroke: th.line, width: 1 }, ticks: { stroke: th.line, width: 1 }, font: '11px system-ui' };
    charts[id] = new uPlot({
      width: w, height: h, legend: { show: false }, cursor: { points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: true }, y: scaleY }, series: [{}, ...series],
      axes: [{ ...ax, values: (u, s) => s.map((v) => fmtT(v * 1000, span)) }, { ...ax, size: 42 }],
    }, data, host);
  }
  const empty = (id, msg) => { const h = el(id); if (h) { if (charts[id]) { charts[id].destroy(); charts[id] = null; } h.innerHTML = `<div class="muted c">${msg}</div>`; } };

  function draw(d) {
    if (!d || $('#tab-rep').hidden) return;
    const th = theme(), span = d.to - d.from, b = bucketize(d), have = d.rows.length > 0;
    const sum = d.rows.reduce((a, r) => a + (r.d || 0), 0), tn = d.rows.reduce((a, r) => a + r.n, 0);
    const runPct = tn ? Math.round(d.rows.reduce((a, r) => a + r.run * r.n, 0) / tn * 100) : null;

    el('cnt').innerHTML = `<div class="v">${u32(R.COUNT)}</div><div class="d">${(CSTATES[S.regs[R.CSTATE]] || CSTATES[0])[0]}</div>`;
    el('sum').innerHTML = have ? `<div class="v">${sum}</div><div class="d">trong ${SPANS[range] || ''}</div>` : '<div class="muted">Chưa có dữ liệu</div>';
    el('run').innerHTML = runPct == null ? '<div class="muted">Chưa có dữ liệu</div>' :
      `<div class="ringw"><div class="ring" style="--p:${runPct}"><span>${runPct}%</span></div><div class="d">${tn} mẫu</div></div>`;
    const cur = ALARMS.filter(([m]) => S.regs[R.ALARM] & m).map(([, t]) => t);
    const cnt = alog.filter(([t, m]) => t >= d.from && m).length;
    el('alm').innerHTML = `<div class="v ${cur.length ? 'bad' : ''}">${cnt}</div><div class="d">${cur.length ? '⚠ ' + cur.join(', ') : 'lần trong khoảng · hiện không có'}</div>`;

    if (!have) { empty('bars', 'Chưa có dữ liệu trong khoảng này. App ghi dữ liệu khi đang mở.'); empty('line', 'Chưa có dữ liệu'); }
    else {
      uplot('bars', [b.xs, b.sum], [{ label: 'Sản lượng', stroke: th.acc, fill: th.acc, width: 1, points: { show: false },
        paths: uPlot.paths.bars({ size: [0.8, 64], align: 0 }) }], { range: (u, mn, mx) => [0, Math.max(5, mx)] }, th, span);
      uplot('line', [b.xs, b.run], [{ label: 'Chạy %', stroke: th.warn, width: 2, spanGaps: false, points: { show: false }, fill: th.warn + '22' }],
        { range: [0, 100] }, th, span);
    }
    if (d.rows.length > 1) {
      const base = d.rows[0].c1;
      uplot('cum', [d.rows.map((r) => r.t / 1000), d.rows.map((r) => r.c1 - base)], [{ label: 'Đếm', stroke: th.acc, width: 2, fill: th.acc + '22', points: { show: false } }],
        { range: (u, mn, mx) => [0, Math.max(5, mx)] }, th, span);
    } else empty('cum', 'Chưa đủ dữ liệu');
    timeline(d, th);
    const outN = d.outN, duty = outN.map((_, i) => (tn ? d.rows.reduce((a, r) => a + r.ou[i] * r.n, 0) / tn : 0));
    el('tbl').innerHTML = '<table>' + outN.map((n, i) => `<tr><td>${n}</td><td>${duty[i].toFixed(0)}%</td><td>${hmsShort(u32(R.RUN + 2 * i))}</td></tr>`).join('') +
      `<tr><td>PLC chạy</td><td></td><td>${hmsShort(u32(R.UPTIME))}</td></tr></table><div class="muted">Cột 2: tỷ lệ bật trong khoảng. Cột 3: tổng thời gian bật do PLC đếm từ đầu.</div>`;
    const label = (m) => (m ? ALARMS.filter(([x]) => m & x).map((a) => a[1]).join(', ') : 'Hết cảnh báo');
    el('log').innerHTML = alog.slice(-20).reverse().map(([t, m]) => `<div class="${m ? 'al' : 'muted'}">${new Date(t).toLocaleString('vi-VN')} – ${label(m)}</div>`).join('') || '<span class="muted">Chưa có</span>';
    dbPanel(d);
  }

  function timeline(d, th) {
    const host = el('tl'); if (!host) return;
    const w = host.clientWidth, h = host.clientHeight; host.innerHTML = '';
    if (w < 60 || h < 60) return;
    if (!d.rows.length) { host.innerHTML = '<div class="muted c">Chưa có dữ liệu</div>'; return; }
    const cv = document.createElement('canvas'), dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px'; host.appendChild(cv);
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const L = 44, B = 16, W = Math.floor(w - L - 4), rowH = (h - B) / 8, span = d.to - d.from, a = Array.from({ length: 8 }, () => new Uint8Array(W));
    d.rows.forEach((r, k) => {
      const nx = d.rows[k + 1], end = nx && nx.t - r.t < d.ms * 3 ? nx.t : r.t + d.ms;
      const c0 = Math.max(0, Math.floor((r.t - d.from) / span * W)), c1 = Math.min(W - 1, Math.max(c0, Math.floor((end - d.from) / span * W) - 1));
      for (let i = 0; i < 8; i++) { const v = r.ou[i]; if (v) for (let c = c0; c <= c1; c++) if (v > a[i][c]) a[i][c] = v; }
    });
    g.font = '10px system-ui'; g.textBaseline = 'middle'; g.fillStyle = th.mut;
    d.outN.forEach((n, i) => g.fillText(n.slice(0, 6), 0, rowH * (i + .5)));
    g.fillStyle = th.on;
    for (let i = 0; i < 8; i++) for (let c = 0; c < W; c++) if (a[i][c]) { g.globalAlpha = .25 + .75 * a[i][c] / 100; g.fillRect(L + c, rowH * i + 2, 1.2, rowH - 4); }
    g.globalAlpha = 1; g.fillStyle = th.mut; g.textAlign = 'center'; g.textBaseline = 'top';
    for (let k = 0; k <= 4; k++) g.fillText(fmtT(d.from + span * k / 4, span), L + W * k / 4 + (k === 0 ? 14 : k === 4 ? -14 : 0), h - B + 3);
  }

  /* ---------------------------------------------------------------- data management panel */
  async function dbPanel(d) {
    const host = el('db'); if (!host) return;
    const s = await DB.stats(), mb = (x) => (x == null ? '—' : (x / 1048576).toFixed(1) + ' MB');
    if (!host.dataset.ready) {
      host.dataset.ready = 1;
      host.innerHTML = '<div id="dbinfo" class="muted"></div><div class="row wrap"><button id="db-bk" class="fit">Sao lưu (JSON)</button><button id="db-rs" class="fit">Khôi phục</button>' +
        '<button id="db-csv" class="fit">Xuất CSV</button><button id="db-keep" class="fit">Giữ dữ liệu bền vững</button><button id="db-clr" class="fit danger">Xoá lịch sử</button></div>';
    }
    $('#dbinfo').innerHTML = s.ok
      ? `Cơ sở dữ liệu <b>${s.name}</b>: ${s.raw} mẫu 10 giây (giữ 24 giờ) · ${s.min} mẫu 1 phút (giữ 30 ngày) · ${s.hour} mẫu 1 giờ (giữ 2 năm). Dung lượng đã dùng: ${mb(s.usage)}. Dữ liệu chỉ nằm trên thiết bị này.`
      : 'Trình duyệt không cho lưu cơ sở dữ liệu (chế độ riêng tư?). Biểu đồ chỉ hoạt động khi app đang mở.';
  }

  function onPanelClick(e) {
    const id = e.target.id; if (!id || !id.startsWith('db-')) return;
    if (id === 'db-bk') DB.exportAll().then((o) => save(JSON.stringify(o), `plc-sao-luu-${cfg.site}-${cfg.dev}-${new Date().toISOString().slice(0, 10)}.json`, 'application/json'));
    else if (id === 'db-csv' && lastData) {
      const head = 'thoi_gian,san_luong,ty_le_chay_pct,' + lastData.outN.map((n, i) => 'Y' + i + '_pct').join(',');
      const rows = lastData.rows.map((r) => [new Date(r.t).toISOString(), r.d || 0, Math.round(r.run * 100), ...r.ou].join(','));
      save('﻿' + [head, ...rows].join('\n'), `plc-${cfg.site}-${cfg.dev}.csv`, 'text/csv');
    } else if (id === 'db-rs') {
      const f = document.createElement('input'); f.type = 'file'; f.accept = '.json,application/json';
      f.onchange = async () => { try { const n = await DB.importAll(JSON.parse(await f.files[0].text())); toast(`Đã khôi phục ${n} bản ghi`); refresh(true); } catch (err) { toast(err.message || 'Không đọc được tệp'); } };
      f.click();
    } else if (id === 'db-keep') DB.persist().then((r) => toast(r === true ? 'Đã yêu cầu giữ dữ liệu bền vững' : r === false ? 'Trình duyệt chưa cho phép; hãy cài app vào Màn hình chính' : 'Trình duyệt không hỗ trợ'));
    else if (id === 'db-clr' && confirm('Xoá toàn bộ lịch sử lưu trên thiết bị này? (Không ảnh hưởng PLC)')) {
      DB.clearAll().then(() => { hist = []; alog = []; LS.set('alog', alog); toast('Đã xoá'); refresh(true); });
    }
  }
  function save(text, name, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* cumulative count line for the last `hours` hours, drawn into the element with this id */
  async function cumInto(id, hours) {
    const host = document.getElementById(id); if (!host || !DB.ok) { if (host) host.innerHTML = '<div class="muted c">Trình duyệt không lưu được dữ liệu</div>'; return; }
    const to = Date.now(), from = to - hours * 3600e3, r = await DB.series(from, to);
    if (r.rows.length < 2) { if (charts[id]) { charts[id].destroy(); charts[id] = null; } host.innerHTML = '<div class="muted c">Chưa đủ dữ liệu. App ghi dữ liệu khi đang mở.</div>'; return; }
    const th = theme(), base = r.rows[0].c1;
    uplotAt(host, id, [r.rows.map((x) => x.t / 1000), r.rows.map((x) => x.c1 - base)], [{ label: 'Đếm', stroke: th.acc, width: 2, fill: th.acc + '22', points: { show: false } }],
      { range: (u, mn, mx) => [0, Math.max(5, mx)] }, th, to - from);
  }
  function live() {
    if (!grid || !el('cnt')) return;
    el('cnt').innerHTML = `<div class="v">${u32(R.COUNT)}</div><div class="d">${(CSTATES[S.regs[R.CSTATE]] || CSTATES[0])[0]}</div>`;
    fillSpeed(); fillCtl();
  }

  /* called on every render() while the tab is visible */
  function tick() {
    init();
    document.querySelectorAll('#drange button').forEach((b) => b.classList.toggle('sel', +b.dataset.ms === range));
    live();
    refresh(false);
  }
  return { tick, refresh, SPANS, cumInto };
})();
