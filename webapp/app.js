'use strict';
/* Register map (Modbus address == Xinje D number), see docs/PROTOCOL.md */
const R = { DI: 0, DO: 1, ALARM: 2, MODE: 3, MAN: 4, RUN_REQ: 6, TARGET: 7, CSTATE: 8, RESET: 9, UPTIME: 10, STARTS: 12, COUNT: 14, TOTAL: 16, RUN: 20, NREG: 40 };
const ALARMS = [[1, 'Dừng khẩn cấp (E-stop)'], [2, 'Lỗi cảm biến mức']];

const $ = (s) => document.querySelector(s);
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const cfg = Object.assign({ url: 'wss://plc-mqtt.dieukhientudong.net', user: 'app', pass: '', site: 'factory1', dev: 'plc01',
  demo: true, inNames: '', outNames: '', maxRate: '60', pitchCm: '0' }, LS.get('cfg', {}));
const names = (str, p) => Array.from({ length: 8 }, (_, i) => (str.split(',')[i] || '').trim() || p + i);

const S = { regs: new Array(R.NREG).fill(0), status: 'offline', ts: 0 };
let hist = [];                        // [ts, DO, DI, alarm, total] last hour, in memory (the full history lives in DB)
let alog = LS.get('alog', []);        // [ts, alarmMask]
let rangeH = 1, link = null, lastAlarm = 0;
S.hist = null; S.histTs = 0;   // hourly history block published by the PLC via the gateway
const u32 = (i) => S.regs[i] + S.regs[i + 1] * 65536;
const hms = (s) => `${Math.floor(s / 3600)} giờ ${String(Math.floor(s / 60) % 60).padStart(2, '0')} phút ${String(s % 60).padStart(2, '0')} giây`;

/* ------------------------------------------------------------- links */
class MqttLink {
  constructor(h) {
    this.h = h;
    this.base = `plc/${cfg.site}/${cfg.dev}`;
    this.c = new MqttLite({ url: cfg.url, user: cfg.user, pass: cfg.pass })
      .on('connect', () => { h.status('connecting'); })
      .on('close', () => h.status('offline'))
      .on('error', () => h.status('offline'))
      .on('message', (t, p) => this.msg(t, p));
    ['telemetry', 'status', 'ack', 'history'].forEach((k) => this.c.subscribe(`${this.base}/${k}`));
  }
  start() { this.h.status('offline'); this.c.connect(); }
  stop() { this.c.close(); }
  msg(t, p) {
    const k = t.slice(this.base.length + 1);
    try {
      if (k === 'status') this.h.status(p);
      else if (k === 'telemetry') this.h.regs(JSON.parse(p).r);
      else if (k === 'ack') this.h.ack(JSON.parse(p));
      else if (k === 'history') this.h.history(JSON.parse(p));
    } catch {}
  }
  send(cmd) { return this.c.publish(`${this.base}/cmd`, JSON.stringify(cmd)); }
}

/* Offline simulator with the same logic as plc/xd3_logic.st */
class DemoLink {
  constructor(h) {
    this.h = h; this.n = 0;
    this.H = { c: Array.from({ length: 49 }, (_, i) => i ? 15 + Math.floor(Math.random() * 70) : 12), s: 1200, n: 48, r: 700,
      m: Array.from({ length: 49 }, (_, i) => i ? 20 + Math.floor(Math.random() * 40) : 0) };
    this.r = new Array(R.NREG).fill(0); this.level = 55; this.estop = false; this.pump = false; this.clk = 0; }
  start() { this.h.status('online'); this.t = setInterval(() => this.tick(), 1000); this.tick(); }
  stop() { clearInterval(this.t); }
  tick() {
    const r = this.r, pumpOn = r[R.DO] & 1;
    this.level = Math.min(100, Math.max(0, this.level + (pumpOn ? 3 : 0) - 1.2 - Math.random() * 0.5));
    if (Math.random() < 0.004) this.estop = !this.estop;
    const x0 = !this.estop, x1 = this.level > 20, x2 = this.level >= 80;
    r[R.DI] = (x0 ? 1 : 0) | (x1 ? 2 : 0) | (x2 ? 4 : 0);
    r[R.ALARM] = (x0 ? 0 : 1) | (x2 && !x1 ? 2 : 0);
    if (!x1) this.pump = true; else if (x2) this.pump = false;
    let o = (r[R.MODE] === 0 ? (this.pump ? 1 : 0) : r[R.MAN] & 0x7D);
    if (r[R.CSTATE] === 1 && Math.random() < 0.6) { this.add(R.COUNT); this.add(R.TOTAL); this.H.c[0]++; }  // item passes photo-eye
    const tgt = r[R.TARGET], reached = tgt > 0 && this.u(R.COUNT) >= tgt;
    r[R.CSTATE] = r[R.RUN_REQ] ? (!x0 ? 3 : reached ? 2 : 1) : 0;
    if (r[R.CSTATE] === 1) o |= 2;
    if (r[R.ALARM] & 2) { o = (o & 0xFE) | 0x80; this.pump = false; }
    if (!x0) { o = 0x80; this.pump = false; }
    if (!x1) o &= 0xFE;
    r[R.DO] = o;
    this.add(R.UPTIME);
    for (let i = 0; i < 8; i++) if (o >> i & 1) this.add(R.RUN + 2 * i);
    if ((o & 1) && !this.was) this.add(R.STARTS);
    this.was = o & 1;
    const H = this.H; H.s++; if (r[R.CSTATE] === 1) H.r++;
    if (H.s >= 3600) { H.m[0] = Math.floor(H.r / 60); H.c.pop(); H.m.pop(); H.c.splice(1, 0, H.c[0]); H.m.splice(1, 0, H.m[0]); H.c[0] = 0; H.m[0] = 0; H.s = 0; H.r = 0; H.n++; }
    if (this.n++ % 5 === 0) this.h.history(JSON.parse(JSON.stringify(H)));
    this.h.regs(r.slice());
  }
  u(i) { return this.r[i] + this.r[i + 1] * 65536; }
  add(i) { const v = this.r[i] + this.r[i + 1] * 65536 + 1; this.r[i] = v & 0xFFFF; this.r[i + 1] = v >>> 16; }
  virt() {   // the same register map the PLC exposes, including the hourly history block
    const v = new Array(300).fill(0); this.r.forEach((x, i) => { v[i] = x; });
    this.H.c.forEach((x, i) => { v[100 + i] = x; }); v[149] = this.H.s; v[150] = this.H.n; v[199] = this.H.r; this.H.m.forEach((x, i) => { v[200 + i] = x; });
    return v;
  }
  send(c) {
    if (c.op === 'read') {
      setTimeout(() => { const ok = c.a >= 0 && c.n >= 1 && c.a + c.n <= 300; this.h.ack({ id: c.id, ok, a: c.a, v: ok ? this.virt().slice(c.a, c.a + c.n) : undefined }); }, 150);
      return true;
    }
    setTimeout(() => {
      if (c.a === R.MODE) {
        if (c.v === 1 && this.r[R.MODE] === 0) this.r[R.MAN] = this.r[R.DO];
        this.r[R.MODE] = c.v;
      } else if (c.a === R.RESET) { this.r[R.COUNT] = this.r[R.COUNT + 1] = 0; }
      else if ([R.MAN, R.RUN_REQ, R.TARGET].includes(c.a)) this.r[c.a] = c.v;
      this.h.ack({ id: c.id, ok: [R.MODE, R.MAN, R.RUN_REQ, R.TARGET, R.RESET].includes(c.a) });
      this.tick();
    }, 150);
    return true;
  }
}

/* ------------------------------------------------------------- commands */
const pending = {};
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2000);
}
function sendReg(a, v) {
  const id = Date.now().toString(36);
  if (S.status !== 'online' || !link.send({ id, a, v })) return toast('Không có kết nối tới PLC');
  pending[id] = setTimeout(() => { delete pending[id]; toast('PLC không phản hồi'); }, 4000);
}
const queries = {};
function queryRead() {
  const a = parseInt($('#q-a').value, 10), n = parseInt($('#q-n').value || '1', 10), out = $('#q-out');
  if (!(a >= 0 && a <= 299 && n >= 1 && n <= 20)) { out.textContent = 'Địa chỉ 0–299, số lượng 1–20'; return; }
  const id = 'q' + Date.now().toString(36);
  if (S.status !== 'online' || !link.send({ id, op: 'read', a, n })) { out.textContent = 'Không có kết nối tới PLC'; return; }
  out.textContent = 'Đang đọc…';
  queries[id] = setTimeout(() => { delete queries[id]; out.textContent = 'PLC không phản hồi'; }, 6000);
}
function onQueryAck(a) {
  clearTimeout(queries[a.id]); delete queries[a.id];
  const out = $('#q-out');
  out.innerHTML = a.ok && Array.isArray(a.v)
    ? '<table>' + a.v.map((v, i) => `<tr><td>D${a.a + i}</td><td>${v} (0x${v.toString(16).toUpperCase().padStart(4, '0')})</td></tr>`).join('') + '</table>'
    : 'Không đọc được (ngoài phạm vi hoặc PLC lỗi)';
}
function onAck(a) {
  if (queries[a.id]) return onQueryAck(a);
  if (!pending[a.id]) return;
  clearTimeout(pending[a.id]); delete pending[a.id];
  toast(a.ok ? 'Đã gửi lệnh' : 'PLC từ chối lệnh');
}

/* ------------------------------------------------------------- data */
/* throughput of the conveyor, measured on this device from the PLC's product counter */
const rateBuf = [];          // [ts, lifetime count]
S.runSince = 0;
function rateOver(winMs) {   // products per minute over the last winMs (never before the conveyor started)
  if (S.regs[R.CSTATE] !== 1) return 0;
  const now = Date.now(), t0 = Math.max(now - winMs, S.runSince || 0);
  let base = null;
  for (const p of rateBuf) { if (p[0] <= t0) base = p; else { if (!base) base = p; break; } }
  if (!base) return null;
  const dt = (now - base[0]) / 60000;
  if (dt < 0.15) return null;                 // need ~10 s of data first
  return Math.max(0, (rateBuf[rateBuf.length - 1][1] - base[1]) / dt);
}
function fillSpeed() {
  const r = rateOver(60e3), r5 = rateOver(300e3), run = S.regs[R.CSTATE] === 1, pitch = parseFloat(cfg.pitchCm) || 0, mx = parseFloat(cfg.maxRate) || 60;
  const txt = r == null ? '—' : r.toFixed(1);
  const det = !run ? 'Băng tải đang dừng' : r5 == null ? 'Đang đo…' : `TB 5 phút: ${r5.toFixed(1)}` + (pitch && r != null ? ` · ${(r * pitch / 100).toFixed(1)} m/phút` : '');
  ['w', 'c', 'd'].forEach((p) => {
    const a = $('#' + p + '-spd'); if (!a) return;
    a.textContent = txt; $('#' + p + '-spdbar').style.width = Math.min(100, (r || 0) / mx * 100) + '%'; $('#' + p + '-spdd').textContent = det;
  });
}
function fillCtl() {
  const on = S.status === 'online', run = S.regs[R.RUN_REQ] === 1, st = S.regs[R.CSTATE];
  const hint = !on ? 'Chưa kết nối PLC' : st === 2 ? 'Đủ số lượng: xoá đếm để chạy tiếp' : st === 3 ? 'Dừng khẩn cấp: nhả E-stop rồi chạy lại' : run ? 'Đang chạy' : 'Đã dừng';
  ['w', 'dc'].forEach((p) => {
    const a = $('#' + p + '-start'); if (!a) return;
    a.disabled = !on || run; $('#' + p + '-stop').disabled = !on || !run; $('#' + p + '-d').textContent = hint;
  });
}
let prevCState = 0;
function onRegs(r) {
  S.regs = r; S.ts = Date.now();
  if (r[R.CSTATE] === 1 && prevCState !== 1) S.runSince = S.ts;
  prevCState = r[R.CSTATE];
  rateBuf.push([S.ts, u32(R.TOTAL)]);
  while (rateBuf.length > 1 && rateBuf[0][0] < S.ts - 330e3) rateBuf.shift();
  const al = r[R.ALARM];
  if (al !== lastAlarm) { alog.push([S.ts, al]); alog = alog.slice(-200); LS.set('alog', alog); lastAlarm = al; }
  const last = hist[hist.length - 1];
  if (!last || S.ts - last[0] >= 10000) {
    hist.push([S.ts, r[R.DO], r[R.DI], al, u32(R.TOTAL)]);
    if (hist.length > 360) hist.shift();
    DB.addRaw({ t: S.ts, o: r[R.DO], i: r[R.DI], a: al, c: u32(R.TOTAL), s: r[R.CSTATE] });
  }
  render();
}
function onStatus(s) { S.status = s; render(); }
function onHist(o) { S.hist = o; S.histTs = Date.now(); render(); }

/* ------------------------------------------------------------- UI */
const tabs = ['dash', 'conv', 'ctrl', 'rep', 'set'];
function showTab(t) {
  tabs.forEach((x) => { $('#tab-' + x).hidden = x !== t; });
  document.querySelectorAll('nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === t);
    if (b.dataset.tab === t) $('#title').textContent = b.querySelector('span').textContent;
  });
  render();
}
function render() {
  const pill = $('#pill'), st = S.status;
  pill.className = 'pill ' + (st === 'online' ? 'on' : st === 'plc_fault' ? 'warn' : 'off');
  pill.textContent = { online: cfg.demo ? 'Chạy thử' : 'Trực tuyến', plc_fault: 'PLC mất liên lạc', connecting: 'Đang kết nối', offline: 'Mất kết nối' }[st] || st;
  const visible = (t) => !$('#tab-' + t).hidden;
  const { regs } = S, di = regs[R.DI], dout = regs[R.DO], manual = regs[R.MODE] === 1;
  const inN = names(cfg.inNames, 'X'), outN = names(cfg.outNames, 'Y');

  if (visible('dash')) {
    renderWidgets();
    const chip = (n, on) => `<div class="chip ${on ? 'on' : ''}"><i></i>${n}</div>`;
    $('#ins').innerHTML = inN.map((n, i) => chip(n, di >> i & 1)).join('');
    $('#outs').innerHTML = outN.map((n, i) => chip(n, dout >> i & 1)).join('');
    const al = ALARMS.filter(([m]) => regs[R.ALARM] & m).map(([, t]) => `<div class="al">⚠ ${t}</div>`);
    $('#alarms').innerHTML = al.join('') || '<span class="muted">Không có cảnh báo</span>';
    $('#stamp').textContent = S.ts ? 'Cập nhật: ' + new Date(S.ts).toLocaleTimeString('vi-VN') : 'Chưa có dữ liệu';
  }
  if (visible('conv')) renderConv();
  if (visible('ctrl')) {
    $('#m-auto').classList.toggle('sel', !manual);
    $('#m-man').classList.toggle('sel', manual);
    $('#ctrl-hint').textContent = manual ? 'Thủ công: chạm để bật/tắt. Khoá liên động của PLC vẫn luôn có hiệu lực.'
      : 'Đang chạy tự động theo chương trình PLC. Chuyển sang thủ công để điều khiển.';
    $('#switches').innerHTML = outN.slice(0, 7).map((n, i) =>
      `<button class="sw ${regs[R.MAN] >> i & 1 ? 'on' : ''}" data-i="${i}" ${manual && S.status === 'online' ? '' : 'disabled'}>${n}<b></b></button>`).join('');
  }
  if (visible('rep')) Dash.tick();
}

const CSTATES = [['Đã dừng', 'stop'], ['Đang chạy', 'run'], ['Đủ số lượng – đã dừng', 'done'], ['Dừng khẩn cấp', 'bad']];
function renderConv() {
  const { regs } = S, st = CSTATES[regs[R.CSTATE]] || CSTATES[0], tgt = regs[R.TARGET];
  $('#cnt').textContent = u32(R.COUNT);
  $('#cstate').textContent = st[0]; $('#cstate').className = 'state ' + st[1];
  const ok = S.status === 'online';
  $('#c-start').disabled = !ok || regs[R.RUN_REQ] === 1; $('#c-stop').disabled = !ok || regs[R.RUN_REQ] === 0;
  $('#ctarget').textContent = (tgt ? `Mục tiêu: ${tgt} (còn ${Math.max(0, tgt - u32(R.COUNT))})` : 'Không giới hạn') + ` · Tổng từ đầu: ${u32(R.TOTAL)}`;
  document.querySelectorAll('.conv-range button').forEach((b) => b.classList.toggle('sel', +b.dataset.h === rangeH));

  const pb = plcBuckets();
  let bars, times, per, src;
  if (rangeH === 1 || !pb) {                       // last hour: from this device's own 5-minute samples
    const step = 300e3, n = 12, end = Math.ceil(Date.now() / step) * step, t0 = end - n * step;
    bars = new Array(n).fill(0); times = bars.map((_, k) => t0 + k * step); per = '5 phút'; src = 'khi app mở';
    for (let i = 1; i < hist.length; i++) {
      const a = hist[i - 1], b = hist[i];
      if (a[4] == null || b[4] == null || b[0] < t0) continue;
      const k = Math.floor((b[0] - t0) / step);
      if (k >= 0 && k < n) bars[k] += Math.max(0, b[4] - a[4]);
    }
  } else {                                         // 6/24/48 h: hourly buckets kept by the PLC
    const sel = pb.slice(-rangeH); bars = sel.map((x) => x.c); times = sel.map((x) => x.t); per = 'giờ'; src = 'từ PLC';
  }
  drawBars($('#bars'), bars, times, '--acc', true);
  fillSpeed(); fillCtl();
  cumDraw('cumc', rangeH === 1 ? 1 : rangeH);
  const sum = bars.reduce((x, y) => x + y, 0), cnt = Math.max(1, bars.length);
  $('#cstats').innerHTML = `<tr><td>Tổng ${rangeH} giờ qua (${src})</td><td>${sum}</td></tr>` +
    `<tr><td>Trung bình / ${per}</td><td>${(sum / cnt).toFixed(1)}</td></tr><tr><td>Cao nhất / ${per}</td><td>${Math.max(0, ...bars)}</td></tr>`;
}

/* Hourly buckets oldest -> newest from the PLC history block. Slot start is derived from the PLC's
   "seconds into this hour" and our own clock, so no RTC is needed in the PLC. */
function plcBuckets() {
  const h = S.hist; if (!h) return null;
  const HOUR = 3600e3, start = S.histTs - h.s * 1000, avail = Math.min(48, h.n), out = [];
  for (let k = avail; k >= 1; k--) out.push({ t: start - k * HOUR, c: h.c[k] || 0, m: h.m[k] || 0, full: 60 });
  out.push({ t: start, c: h.c[0] || 0, m: Math.floor((h.r || 0) / 60), full: Math.max(1, h.s / 60), partial: true });
  return out;
}

function drawBars(cv, vals, times, colorVar, partialLast) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = +cv.dataset.h || 200, n = Math.max(1, vals.length);
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement), mx = Math.max(5, ...vals), L = 34, B = 22, bw = (W - L - 6) / n;
  g.font = '11px system-ui'; g.fillStyle = css.getPropertyValue('--mut'); g.textBaseline = 'middle';
  g.fillText(Math.round(mx), 4, 12); g.fillText('0', 4, H - B);
  g.textBaseline = 'top'; g.textAlign = 'center';
  for (let k = 0; k < vals.length; k += Math.max(1, Math.round(n / 4))) g.fillText(new Date(times[k]).toTimeString().slice(0, 5), L + bw * (k + .5), H - B + 5);
  g.fillStyle = css.getPropertyValue(colorVar);
  vals.forEach((v, k) => {
    g.globalAlpha = partialLast && k === n - 1 && n > 1 ? .55 : 1;
    const h = v / mx * (H - B - 20); g.fillRect(L + bw * k + 1, H - B - h, Math.max(1, bw - 2), h);
  });
  g.globalAlpha = 1;
}

const cumLast = {};
function cumDraw(id, hours) {   // throttled: at most every 10 s, or at once when the range changes
  const k = cumLast[id] || (cumLast[id] = { t: 0, h: 0 });
  if (Date.now() - k.t < 10000 && k.h === hours) return;
  k.t = Date.now(); k.h = hours; Dash.cumInto(id, hours);
}
let cumH = LS.get('cumH', 6);
function renderWidgets() {
  const { regs } = S, st = CSTATES[regs[R.CSTATE]] || CSTATES[0];
  fillSpeed(); fillCtl();
  document.querySelectorAll('#cum-range button').forEach((b) => b.classList.toggle('sel', +b.dataset.h === cumH));
  cumDraw('wcum', cumH);
  $('#w-cnt').textContent = u32(R.COUNT); $('#w-state').textContent = st[0];
  const pb = plcBuckets(), put = (id, t, cls) => { const e = $(id); e.textContent = t; e.className = 'd ' + cls; };
  if (!pb) {
    ['#w-hour', '#w-24', '#w-runp'].forEach((i) => { $(i).textContent = '—'; });
    $('#w-note').textContent = 'Chưa nhận được lịch sử từ PLC (gateway gửi mỗi phút).';
    drawBars($('#wbars'), [], [], '--acc'); drawBars($('#wmin'), [], [], '--warn'); return;
  }
  const cur = pb[pb.length - 1], prev = pb[pb.length - 2], last24 = pb.slice(-24);
  $('#w-hour').textContent = cur.c;
  if (prev) { const d = cur.c - prev.c; put('#w-hourd', (d >= 0 ? '▲ ' : '▼ ') + Math.abs(d) + ' so với giờ trước', d >= 0 ? 'up' : 'down'); } else put('#w-hourd', '', '');
  const sum = last24.reduce((x, y) => x + y.c, 0), mins = last24.reduce((x, y) => x + y.m, 0), possible = last24.reduce((x, y) => x + y.full, 0);
  $('#w-24').textContent = sum; put('#w-24d', `${(sum / last24.length).toFixed(0)} / giờ`, '');
  const pct = Math.max(0, Math.min(100, Math.round(mins / possible * 100)));
  $('#w-runp').textContent = pct + '%'; $('#w-ring').style.setProperty('--p', pct); $('#w-rund').textContent = `${mins}/${Math.round(possible)} phút`;
  drawBars($('#wbars'), last24.map((x) => x.c), last24.map((x) => x.t), '--acc', true);
  drawBars($('#wmin'), last24.map((x) => x.m), last24.map((x) => x.t), '--warn', true);
  $('#w-note').textContent = 'Số liệu do PLC tự lưu, có đủ cả khi app đóng.';
}

/* ------------------------------------------------------------- wiring */
const dbName = () => (cfg.demo ? 'demo' : `${cfg.site}-${cfg.dev}`);
async function openDb() {
  await DB.open(dbName());
  const rows = await DB.range('raw', Date.now() - 3600e3, Date.now());
  hist = rows.map((r) => [r.t, r.o, r.i, r.a, r.c]);
}
function connect() {
  if (link) link.stop();
  S.status = 'offline';
  const h = { status: onStatus, regs: onRegs, ack: onAck, history: onHist };
  link = cfg.demo ? new DemoLink(h) : new MqttLink(h);
  link.start();
}
function loadSettings() {
  $('#demo').checked = cfg.demo;
  ['url', 'user', 'pass', 'site', 'dev', 'inNames', 'outNames', 'maxRate', 'pitchCm'].forEach((k) => { $('#' + k).value = cfg[k]; });
}

document.querySelectorAll('nav button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
$('#m-auto').onclick = () => sendReg(R.MODE, 0);
$('#m-man').onclick = () => sendReg(R.MODE, 1);
$('#switches').onclick = (e) => {
  const b = e.target.closest('.sw'); if (!b || b.disabled) return;
  sendReg(R.MAN, S.regs[R.MAN] ^ (1 << +b.dataset.i));
};
document.querySelectorAll('.conv-range').forEach((el) => el.onclick = (e) => { if (e.target.dataset.h) { rangeH = +e.target.dataset.h; render(); } });
$('#q-go').onclick = queryRead;
document.addEventListener('click', (e) => {   // machine control: same buttons on Tổng quan and in the dashboard panel
  const id = e.target.id;
  if (id === 'w-start' || id === 'dc-start') sendReg(R.RUN_REQ, 1);
  else if (id === 'w-stop' || id === 'dc-stop') sendReg(R.RUN_REQ, 0);
});
$('#cum-range').onclick = (e) => { if (e.target.dataset.h) { cumH = +e.target.dataset.h; LS.set('cumH', cumH); render(); } };
$('#c-start').onclick = () => sendReg(R.RUN_REQ, 1);
$('#c-stop').onclick = () => sendReg(R.RUN_REQ, 0);
$('#c-set').onclick = () => { const v = parseInt($('#target').value || '0', 10); if (v >= 0 && v <= 65535) sendReg(R.TARGET, v); else toast('Giá trị 0–65535'); };
$('#c-reset').onclick = () => { if (confirm('Xoá số đếm hiện tại về 0?')) sendReg(R.RESET, 1); };
$('#save').onclick = () => {
  cfg.demo = $('#demo').checked;
  ['url', 'user', 'pass', 'site', 'dev', 'inNames', 'outNames', 'maxRate', 'pitchCm'].forEach((k) => { cfg[k] = $('#' + k).value.trim(); });
  LS.set('cfg', cfg); openDb().then(() => { connect(); showTab('dash'); toast('Đã lưu'); });
};
let hideTimer = null;   // hidden tab for 5 min -> release the broker connection; reconnect on return
document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  if (document.hidden) { if (!cfg.demo) hideTimer = setTimeout(() => { link.stop(); S.status = 'offline'; }, 300000); }
  else if (!cfg.demo && S.status === 'offline') connect();
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
loadSettings();
openDb().then(() => { connect(); showTab('dash'); DB.compact(); });
setInterval(() => { DB.compact().then(() => { if (!$('#tab-rep').hidden) Dash.refresh(true); }); }, 60000);
setInterval(() => { if (!document.hidden && !$('#tab-rep').hidden) Dash.refresh(false); }, 10000);
