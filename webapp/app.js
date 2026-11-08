'use strict';
/* Register map (Modbus address == Xinje D number), see docs/PROTOCOL.md */
const R = { DI: 0, DO: 1, ALARM: 2, MODE: 3, MAN: 4, RUN_REQ: 6, TARGET: 7, CSTATE: 8, RESET: 9, UPTIME: 10, STARTS: 12, COUNT: 14, TOTAL: 16, RUN: 20, NREG: 40 };
// [bit, nội dung, mức]: crit = khẩn cấp (đỏ), warn = cảnh báo (hổ phách)
const ALARMS = [[1, 'Dừng khẩn cấp (E-stop)', 'crit', 'Nhả nút dừng khẩn cấp trên máy, rồi bấm Chạy lại.'], [2, 'Lỗi cảm biến mức', 'warn', 'Kiểm tra cảm biến mức và dây nối của nó.']];

const $ = (s) => document.querySelector(s);
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const cfg = Object.assign({ url: 'wss://plc-mqtt.dieukhientudong.net', user: 'app', pass: '', site: 'factory1', dev: 'plc01',
  demo: true, inNames: '', outNames: '', maxRate: '60', pitchCm: '0',
  keepMinDays: '30', keepHourDays: '730', maxMB: '0', uiMode: 'simple' }, LS.get('cfg', {}));
const applyDbLimits = () => DB.setLimits({ minDays: cfg.keepMinDays, hourDays: cfg.keepHourDays, maxMB: cfg.maxMB });
const simpleUi = () => cfg.uiMode !== 'pro';
const names = (str, p) => Array.from({ length: 8 }, (_, i) => (str.split(',')[i] || '').trim() || (simpleUi() ? `${p === 'Y' ? 'Thiết bị' : 'Cảm biến'} ${i + 1}` : p + i));

const S = { regs: new Array(R.NREG).fill(0), status: 'offline', ts: 0 };

/* ------------------------------------------------------------- sự kiện gần nhất + độ mới của dữ liệu */
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let evlog = LS.get('evlog', []);       // [ts, nội dung, loại] lệnh của người dùng + kết nối + kết quả
function logEvent(text, kind = 'info') { evlog.push([Date.now(), text, kind]); evlog = evlog.slice(-60); LS.set('evlog', evlog); }
const STALE_MS = 15000;                // quá ngần này không có dữ liệu mới thì coi là cũ
const ageText = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} giây` : ms < 3600000 ? `${Math.round(ms / 60000)} phút` : `${Math.round(ms / 3600000)} giờ`);
const dataAge = () => (S.ts ? Date.now() - S.ts : null);
const isStale = () => S.status !== 'online' || dataAge() == null || dataAge() > STALE_MS;
const clock = (ts) => new Date(ts).toLocaleTimeString('vi-VN');
let hist = [];                        // [ts, DO, DI, alarm, total] last hour, in memory (the full history lives in DB)
let alog = LS.get('alog', []);        // [ts, alarmMask]
let rangeH = 1, link = null, lastAlarm = 0, ackMask = 0;
S.hist = null; S.histTs = 0;   // hourly history block published by the PLC via the gateway
const u32 = (i) => S.regs[i] + S.regs[i + 1] * 65536;
const hms = (s) => `${Math.floor(s / 3600)} giờ ${String(Math.floor(s / 60) % 60).padStart(2, '0')} phút ${String(s % 60).padStart(2, '0')} giây`;

/* ------------------------------------------------------------- links */
class MqttLink {
  constructor(h) {
    this.h = h;
    // topicBase từ server (mqtt.topicBase); fallback plc/<site>/<dev> cho bản cũ / demo
    this.bases = (Array.isArray(cfg.topicBases) && cfg.topicBases.length)
      ? cfg.topicBases
      : [cfg.topicBase || `plc/${cfg.site}/${cfg.dev}`];
    this.base = this.bases[0];
    this.c = new MqttLite({ url: cfg.url, user: cfg.user, pass: cfg.pass })
      .on('connect', () => { h.status('connecting'); })
      .on('close', () => h.status('offline'))
      .on('error', () => h.status('offline'))
      .on('message', (t, p) => this.msg(t, p));
    this.bases.forEach((b) => {
      ['telemetry', 'status', 'ack', 'history'].forEach((k) => this.c.subscribe(`${b}/${k}`));
    });
  }
  start() { this.h.status('offline'); this.c.connect(); }
  stop() { this.c.close(); }
  msg(t, p) {
    const base = this.bases.find((b) => t === b || t.startsWith(b + '/')) || this.base;
    const k = t.slice(base.length + 1);
    try {
      if (k === 'status') this.h.status(p);
      else if (k === 'telemetry') {
        const j = JSON.parse(p);
        this.h.regs(j.r);
        window.DevicesUi?.onTelemetry?.(j);
      }
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
    this.clk++;
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
    // Demo multi-device payload (schema 2) cho catalog UI
    window.DevicesUi?.onTelemetry?.({
      schema: 2,
      r: r.slice(),
      d: {
        env01: { t: 24 + Math.sin(this.clk / 20) * 3, h: 55 + Math.cos(this.clk / 25) * 8 },
        pump1: { run: pumpOn ? 1 : 0, hours: 12.4, flow: pumpOn ? 25 + Math.random() * 10 : 0 },
        sw1: { on: (r[R.DO] >> 2) & 1 },
        energy1: { kw: pumpOn ? 1.1 + Math.random() * 0.4 : 0.05, kwh: 340 },
        tank1: { level: this.level },
        motor1: { run: r[R.CSTATE] === 1 ? 1 : 0, rpm: r[R.CSTATE] === 1 ? 1400 : 0 },
      },
    });
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
const pendDesc = {};
/** Thông báo nổi: lỗi (bad=true) đỏ, ở lại lâu hơn và có thể chạm để tắt; tin thường tự tắt sau vài giây. */
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = (bad ? '✕  ' : '') + msg;
  t.classList.toggle('err', Boolean(bad));
  t.setAttribute('role', bad ? 'alert' : 'status');
  t.classList.add('show');
  t.onclick = () => t.classList.remove('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), (bad ? 6500 : 3000) + String(msg).length * 30);
}
function applyRole(role) {
  S.role = role || 'operator';
  document.body.classList.toggle('viewer', S.role === 'viewer');
  // Link Console chỉ hiện khi server báo là dashboard admin (SĐT allow-list)
  const l = $('#admin-link');
  if (l) l.hidden = !(S.dashboardAdmin || S.role === 'admin');
}
function applySubscription(sub) {
  const panel = $('#sub-panel');
  const info = $('#sub-info');
  if (!panel || !info) return;
  if (!sub) { panel.hidden = true; return; }
  panel.hidden = false;
  const exp = sub.expiresAt ? new Date(sub.expiresAt).toLocaleDateString() : 'không hết hạn';
  if (sub.pendingActivation) {
    info.textContent = 'Chờ admin kích hoạt gói trên cloud. Hiện chỉ xem (nếu có dữ liệu).';
  } else {
    info.textContent = `Gói ${sub.planLabel || sub.plan} · ${sub.remoteControl ? 'có điều khiển' : 'chỉ giám sát'} · hết hạn: ${exp}`
      + (sub.unlimited ? ' · lưu ∞' : (sub.retentionDays != null ? ` · lưu ${sub.retentionDays} ngày` : ''));
  }
}
/* Đã đăng nhập (không demo): lệnh đi qua app server để kiểm tra Passkey/TOTP (control.js). */
const viaServer = () => !cfg.demo && cfg.controlVia !== 'mqtt' && Boolean(LS.get('session', null)?.token) && window.Ctl;
const CTL_ERR = (e) => (e === 'cancelled' ? '' : window.Ctl.errText(e));
function sendReg(a, v, desc) {
  if (S.role === 'viewer') return toast('Tài khoản này chỉ được xem, không điều khiển được. Nhờ quản trị viên cấp quyền vận hành.', true);
  if (viaServer()) {
    if (S.status !== 'online') return toast('Chưa gửi được lệnh vì đang mất kết nối tới thiết bị. Kiểm tra mạng và nguồn thiết bị rồi thử lại.', true);
    const id = Date.now().toString(36);
    Ctl.send({ id, a, v }).then((r) => {
      if (r.error) return CTL_ERR(r.error) && toast(`Lệnh chưa được gửi. ${CTL_ERR(r.error)}`, true);
      armPending(id, desc);
    });
    return;
  }
  if (!cfg.demo && !/^wss:/i.test(cfg.url || '')) return toast('Kết nối này không được mã hoá (ws://) nên chỉ xem được. Hãy dùng địa chỉ wss:// để điều khiển.', true);
  const id = Date.now().toString(36);
  if (S.status !== 'online' || !link.send({ id, a, v })) return toast('Chưa gửi được lệnh vì đang mất kết nối tới thiết bị. Kiểm tra mạng và nguồn thiết bị rồi thử lại.', true);
  armPending(id, desc);
}
/** Sau khi gửi: "Đã gửi, chờ PLC xác nhận…" → "PLC đã xác nhận" / "PLC từ chối" / "PLC không phản hồi"; mọi kết quả đều vào sự kiện gần nhất. */
function armPending(id, desc) {
  pendDesc[id] = desc || '';
  if (desc) toast('Đã gửi lệnh, đang chờ thiết bị xác nhận…');
  pending[id] = setTimeout(() => {
    delete pending[id];
    toast('Thiết bị không phản hồi sau 4 giây. Lệnh có thể chưa được thực hiện, hãy kiểm tra lại trạng thái.', true);
    if (pendDesc[id]) logEvent(`PLC không phản hồi: ${pendDesc[id]}`, 'warn');
    delete pendDesc[id];
  }, 4000);
}
/** Hộp xác nhận trước hành động tác động vật lý (chạy/dừng máy, đổi chế độ, bật/tắt đầu ra). Nút xác nhận là nút đậm. */
function confirmAction(title, text, okLabel) {
  return new Promise((resolve) => {
    const back = document.createElement('div'); back.className = 'cf-back';
    const box = document.createElement('div'); box.className = 'cf-box'; box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h3'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = text;
    const row = document.createElement('div'); row.className = 'row';
    const no = document.createElement('button'); no.type = 'button'; no.className = 'ctl-btn idle'; no.textContent = 'Huỷ';
    const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'ctl-btn act'; yes.textContent = okLabel;
    const done = (v) => { back.remove(); resolve(v); };
    no.onclick = () => done(false); yes.onclick = () => done(true);
    back.onclick = (e) => { if (e.target === back) done(false); };
    row.append(no, yes); box.append(h, p, row); back.append(box); document.body.append(back); no.focus();
  });
}
/** Gửi lệnh điều khiển có xác nhận. cf = [tiêu đề, nội dung, chữ nút]; desc = mô tả ghi vào sự kiện. */
async function command(desc, a, v, cf) {
  if (S.role === 'viewer') return sendReg(a, v, desc);
  if (cf && !(await confirmAction(cf[0], cf[1], cf[2]))) return;
  sendReg(a, v, desc);
}
const RUN_CF = ['Chạy băng tải?', 'Máy sẽ chạy ngay. Hãy chắc chắn khu vực quanh máy an toàn.', 'Chạy'];
const STOP_CF = ['Dừng băng tải?', 'Máy sẽ dừng ngay. Sản phẩm đang trên băng tải có thể bị ảnh hưởng.', 'Dừng máy'];
const queries = {};
function queryRead() {
  const a = parseInt($('#q-a').value, 10), n = parseInt($('#q-n').value || '1', 10), out = $('#q-out');
  if (!(a >= 0 && a <= 299 && n >= 1 && n <= 20)) { out.textContent = 'Địa chỉ 0–299, số lượng 1–20'; return; }
  const id = 'q' + Date.now().toString(36);
  if (S.status !== 'online') { out.textContent = 'Không có kết nối tới PLC'; return; }
  out.textContent = 'Đang đọc…';
  if (viaServer()) {
    Ctl.send({ id, op: 'read', a, n }).then((r) => {
      if (r.error) { out.textContent = CTL_ERR(r.error) || 'Đã huỷ'; return; }
      queries[id] = setTimeout(() => { delete queries[id]; out.textContent = 'PLC không phản hồi'; }, 6000);
    });
    return;
  }
  if (!link.send({ id, op: 'read', a, n })) { out.textContent = 'Không có kết nối tới PLC'; return; }
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
  const d = pendDesc[a.id]; delete pendDesc[a.id];
  toast(a.ok ? 'Thiết bị đã thực hiện' + (d ? ': ' + d : '') : 'Thiết bị từ chối lệnh (đang ở chế độ khác, ngoài phạm vi hoặc bị khoá). Lệnh chưa được thực hiện.', !a.ok);
  if (d) logEvent(a.ok ? d : `PLC từ chối: ${d}`, a.ok ? 'info' : 'warn');
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
/** Nút khả dụng = đậm, đảo màu, to; nút không khả dụng = viền mờ. Khi máy đang chạy thì "Dừng máy" là nút nổi bật nhất. */
function ctlLook(start, stop, on, run) {
  start.className = 'ctl-btn ' + (on && !run ? 'act' : 'idle');
  stop.className = 'ctl-btn stop ' + (on && run ? 'act' : 'idle');
}
function fillCtl() {
  const on = S.status === 'online', run = S.regs[R.RUN_REQ] === 1, st = S.regs[R.CSTATE];
  const hint = !on ? 'Chưa kết nối PLC' : st === 2 ? 'Đủ số lượng: xoá đếm để chạy tiếp' : st === 3 ? 'Dừng khẩn cấp: nhả E-stop rồi chạy lại' : run ? 'Đang chạy' : 'Đã dừng';
  ['w', 'dc'].forEach((p) => {
    const a = $('#' + p + '-start'); if (!a) return;
    a.disabled = !on || run; $('#' + p + '-stop').disabled = !on || !run; $('#' + p + '-d').textContent = hint;
    ctlLook(a, $('#' + p + '-stop'), on, run);
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
function onStatus(s) {
  if (s !== S.status && S.statusSeen) {
    if (s === 'online') logEvent('Đã kết nối lại', 'ok');
    else if (S.status === 'online') logEvent(s === 'plc_fault' ? 'PLC mất liên lạc' : 'Mất kết nối', 'warn');
  }
  S.statusSeen = true; S.status = s; render();
}
function onHist(o) { S.hist = o; S.histTs = Date.now(); render(); }

/* ------------------------------------------------------------- UI */
const tabs = ['dash', 'conv', 'ctrl', 'rep', 'set'];
/** simple = điện thoại: widget + báo cáo; pro = SCADA (I/O, băng tải). */
function applyUi() {
  document.body.classList.toggle('ui-simple', simpleUi());
  const h = $('#switches')?.previousElementSibling;
  if (h) h.textContent = simpleUi() ? 'Thiết bị' : 'Điều khiển đầu ra';
  const dashLbl = document.querySelector('nav button[data-tab="dash"] span');
  if (dashLbl) dashLbl.textContent = simpleUi() ? 'Thiết bị' : 'Tổng quan';
  // Phone: ẩn ctrl/conv; giữ tab Báo cáo (biểu đồ)
  if (simpleUi() && (!$('#tab-ctrl').hidden || !$('#tab-conv').hidden)) showTab('dash');
}
function showTab(t) {
  tabs.forEach((x) => { $('#tab-' + x).hidden = x !== t; });
  document.querySelectorAll('nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === t);
    if (b.dataset.tab === t) $('#title').textContent = b.querySelector('span').textContent;
  });
  render();
}
/* Thanh cảnh báo cố định (mọi tab): cảnh báo đang hoạt động > mất liên lạc > bình thường. Chưa "Đã nhận" thì nhấp nháy. */
function renderAlarmBar() {
  const bar = $('#alarm-bar');
  if (!bar) return;
  document.documentElement.style.setProperty('--hdr-h', `${($('header') || {}).offsetHeight || 58}px`); // thanh cảnh báo dính ngay dưới tiêu đề
  const st = S.status, mask = (S.regs && S.regs[R.ALARM]) || 0;
  const act = ALARMS.filter(([m]) => mask & m);
  const active = act.map(([, t]) => t);
  if (!(mask & ackMask)) ackMask = 0;           // cảnh báo đã hết thì lần sau xuất hiện lại phải báo lại
  const unacked = (mask & ~ackMask) !== 0;
  const last = S.ts ? ` Lần cuối nhận dữ liệu: ${clock(S.ts)}.` : '';
  let cls = 'ok', icon = '✔', text = 'Bình thường';
  if (st !== 'online') {
    cls = 'comm'; icon = '■';
    text = { plc_fault: 'PLC mất liên lạc: số liệu không còn đáng tin.' + last, connecting: 'Đang kết nối…', offline: 'Mất kết nối máy chủ: số liệu không còn đáng tin.' + last }[st] || st;
  } else if (isStale()) {
    cls = 'comm'; icon = '■'; text = `Dữ liệu không cập nhật ${ageText(dataAge() ?? 0)}: số liệu không còn đáng tin.` + last;
  }
  const crit = act.some((a) => a[2] === 'crit');
  if (act.length) { cls = crit ? 'alarm' : 'alarm warnonly'; icon = '▲'; text = `${act.length} cảnh báo${crit ? ' KHẨN CẤP' : ''}: ${active.join(' · ')}`; }
  bar.className = `alarm-bar ${cls}${act.length && unacked ? ' blink' : ''}`;
  bar.replaceChildren();
  const i = document.createElement('span'); i.className = 'ab-i'; i.setAttribute('aria-hidden', 'true'); i.textContent = icon;
  const t = document.createElement('span'); t.className = 'ab-t'; t.textContent = text;
  bar.append(i, t);
  if (active.length && unacked) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Đã nhận';
    b.onclick = () => { ackMask = mask; renderAlarmBar(); };
    bar.append(b);
  }
}
/** Thẻ trạng thái lớn (kiểu Đơn giản): một câu trả lời cho "máy có ổn không?" kèm việc cần làm. */
function renderStatusCard() {
  const c = $('#status-card');
  if (!c || !simpleUi()) return;
  const mask = (S.regs && S.regs[R.ALARM]) || 0, act = ALARMS.filter(([m]) => mask & m), st = S.regs[R.CSTATE];
  let cls = 'idle', icon = '■', title = 'Máy đã dừng', hint = 'Bấm Chạy để khởi động máy.';
  if (S.status !== 'online' || isStale()) {
    cls = 'comm'; icon = '■';
    title = S.status === 'connecting' ? 'Đang kết nối…' : S.status === 'plc_fault' ? 'PLC mất liên lạc' : S.status !== 'online' ? 'Mất kết nối' : 'Dữ liệu không cập nhật';
    hint = 'Số liệu bên dưới có thể đã cũ.' + (S.ts ? ` Lần cuối nhận dữ liệu: ${clock(S.ts)}.` : '');
  } else if (act.length) {
    const crit = act.some((a) => a[2] === 'crit');
    cls = crit ? 'alarm' : 'warn'; icon = '▲';
    title = `${act.length} cảnh báo: ${act.map((a) => a[1]).join(', ')}`;
    hint = act.map((a) => a[3]).filter(Boolean).join(' ') + ' Sau đó bấm "Đã nhận" ở thanh phía trên.';
  } else if (st === 3) {
    cls = 'alarm'; icon = '▲'; title = 'Dừng khẩn cấp'; hint = 'Nhả nút dừng khẩn cấp trên máy, rồi bấm Chạy lại.';
  } else if (st === 2) {
    cls = 'warn'; icon = '✔'; title = 'Đủ số lượng, máy đã dừng'; hint = 'Xoá số đếm (tab Băng tải) để chạy tiếp.';
  } else if (st === 1) {
    cls = 'ok'; icon = '●'; title = 'Máy đang chạy, mọi thứ bình thường'; hint = `Đã đếm ${u32(R.COUNT)} sản phẩm.`;
  }
  c.className = `status-card st-${cls} span`;
  c.querySelector('.sc-i').textContent = icon;
  c.querySelector('.sc-t').textContent = title;
  c.querySelector('.sc-h').textContent = hint;
}
/** Chỉ báo kết nối + độ mới của dữ liệu. Gọi mỗi giây để "cập nhật N giây trước" luôn đúng, số liệu cũ bị làm mờ. */
function renderStatus() {
  const pill = $('#pill'), st = S.status, stale = isStale(), age = dataAge();
  document.body.classList.toggle('stale', stale);
  pill.className = 'pill ' + (st === 'online' && !stale ? 'on' : st === 'plc_fault' || st === 'online' ? 'warn' : 'off');
  const base = { online: cfg.demo ? '● Chạy thử' : '● Trực tuyến', plc_fault: '▲ PLC mất liên lạc', connecting: '■ Đang kết nối', offline: '■ Mất kết nối' }[st] || st;
  pill.textContent = st === 'online' && stale ? `▲ Dữ liệu cũ${age != null ? ' · ' + ageText(age) : ''}` : st === 'online' && age != null ? `${base} · ${ageText(age)} trước` : base;
  renderAlarmBar();
  renderStatusCard();
}
/** Danh sách sự kiện gần nhất: cảnh báo xuất hiện/hết, lệnh của bạn và kết quả, mất/khôi phục kết nối. */
function recentEvents(n = 8) {
  const out = [];
  let prev = 0;
  for (const [ts, mask] of alog) {
    for (const [m, t, sev] of ALARMS) {
      if ((mask & m) && !(prev & m)) out.push([ts, `${t} xuất hiện`, sev === 'crit' ? 'crit' : 'warn']);
      else if (!(mask & m) && (prev & m)) out.push([ts, `${t} đã hết`, 'ok']);
    }
    prev = mask;
  }
  for (const [ts, text, kind] of evlog) out.push([ts, text, kind]);
  return out.sort((a, b) => b[0] - a[0]).slice(0, n);
}
function renderEvents() {
  const box = $('#events');
  if (!box) return;
  const today = new Date().toDateString();
  const icon = { crit: '▲', warn: '▲', ok: '✔', info: '●' };
  box.replaceChildren(...(recentEvents().map(([ts, text, kind]) => {
    const row = document.createElement('div'); row.className = `ev ${kind}`;
    const t = document.createElement('span'); t.className = 'ev-t';
    t.textContent = new Date(ts).toDateString() === today ? clock(ts) : new Date(ts).toLocaleString('vi-VN');
    const i = document.createElement('span'); i.className = 'ev-i'; i.setAttribute('aria-hidden', 'true'); i.textContent = icon[kind] || '●';
    const x = document.createElement('span'); x.textContent = text;
    row.append(t, i, x);
    return row;
  })));
  if (!box.childElementCount) { const m = document.createElement('div'); m.className = 'muted'; m.textContent = 'Chưa có sự kiện.'; box.append(m); }
}
function render() {
  renderStatus();
  const visible = (t) => !$('#tab-' + t).hidden;
  const { regs } = S, di = regs[R.DI], dout = regs[R.DO], manual = regs[R.MODE] === 1;
  const inN = names(cfg.inNames, 'X'), outN = names(cfg.outNames, 'Y');

  if (visible('dash')) {
    renderWidgets();
    const chip = (n, on) => `<div class="chip ${on ? 'on' : ''}"><i></i>${n}</div>`;
    $('#ins').innerHTML = inN.map((n, i) => chip(n, di >> i & 1)).join('');
    $('#outs').innerHTML = outN.map((n, i) => chip(n, dout >> i & 1)).join('');
    const al = ALARMS.filter(([m]) => regs[R.ALARM] & m).map(([, t, sev]) => `<div class="al ${sev === 'warn' ? 'warn' : ''}"><span aria-hidden="true">▲</span> ${t}</div>`);
    $('#alarms').innerHTML = al.join('') || '<span class="muted">Không có cảnh báo</span>';
    $('#stamp').textContent = S.ts ? 'Cập nhật: ' + new Date(S.ts).toLocaleTimeString('vi-VN') : 'Chưa có dữ liệu';
    renderEvents();
  }
  if (visible('conv')) renderConv();
  if (visible('ctrl')) {
    $('#m-auto').classList.toggle('sel', !manual);
    $('#m-man').classList.toggle('sel', manual);
    $('#ctrl-hint').textContent = manual ? 'Thủ công: chạm để bật/tắt. Khoá liên động của PLC vẫn luôn có hiệu lực.'
      : 'Đang chạy tự động theo chương trình PLC. Chuyển sang thủ công để điều khiển.';
    $('#switches').innerHTML = outN.slice(0, 7).map((n, i) => {
      const on = regs[R.MAN] >> i & 1;
      return `<button class="sw ${on ? 'on' : ''}" data-i="${i}" aria-pressed="${on ? 'true' : 'false'}" ${manual && S.status === 'online' ? '' : 'disabled'}><span class="sw-l"><span class="sw-n">${esc(n)}</span>${n === `Y${i}` ? '' : `<small class="addr">Y${i}</small>`}</span><span class="sw-s">${on ? 'BẬT' : 'TẮT'}</span><b></b></button>`;
    }).join('');
    $('#name-hint').hidden = Boolean((cfg.outNames || '').trim());
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
  ctlLook($('#c-start'), $('#c-stop'), ok, regs[R.RUN_REQ] === 1);
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
  if (!simpleUi()) cumDraw('cumc', rangeH === 1 ? 1 : rangeH);
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
  if (!simpleUi()) cumDraw('wcum', cumH);
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

/** Pull server MQTT history into IndexedDB for offline charts (when logged in). */
async function syncCloudHistory() {
  if (cfg.demo) return;
  const session = LS.get('session', null);
  if (!session?.token || session.demo) return;
  const base = session.apiBase || location.origin;
  // Server plan window (3 days default; longer on paid plans, null = unlimited → cap at 2 years)
  const retentionMs = LS.get('retentionDays', 3) * 86400e3;
  let since = Number(await DB.kvGet('cloud_since')) || 0;
  const floor = Date.now() - retentionMs;
  if (since < floor) since = floor;

  let total = 0;
  for (let n = 0; n < 40; n++) {
    const url = `${base}/api/history/telemetry?site=${encodeURIComponent(cfg.site)}`
      + `&dev=${encodeURIComponent(cfg.dev)}&since=${since}&limit=5000`;
    let data;
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` } });
      if (r.status === 401) return;
      if (!r.ok) break;
      data = await r.json();
      if (data.unlimited || data.retentionDays) LS.set('retentionDays', data.unlimited ? 730 : data.retentionDays);
    } catch { break; }
    const samples = data.samples || [];
    if (samples.length) {
      await DB.putMany('raw', samples.map((x) => ({
        t: x.t, o: x.o, i: x.i, a: x.a, c: x.c, s: x.s,
      })));
      total += samples.length;
      since = data.nextSince || samples[samples.length - 1].t;
      await DB.kvSet('cloud_since', since);
    }
    if (data.done || !samples.length) break;
  }
  if (total) {
    await DB.compact();
    console.log('cloud history synced', total, 'samples');
  }
}

async function openDb() {
  await DB.open(dbName());
  try { await syncCloudHistory(); } catch (e) { console.warn('syncCloudHistory', e); }
  const rows = await DB.range('raw', Date.now() - 3600e3, Date.now());
  hist = rows.map((r) => [r.t, r.o, r.i, r.a, r.c]);
}

/* Keep cfg.site/dev aligned with account binding so history sync is authorized. */
function lockTenantFields(locked) {
  ['site', 'dev', 'user', 'pass'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.readOnly = locked;
  });
}

window.applySiteFromDevices = (site, gateway) => {
  // Thêm thiết bị (có thể là gateway khác) → lấy lại user/topicBase/topicBases từ server rồi nối lại MQTT, không cần tải lại trang.
  const before = JSON.stringify([cfg.site, cfg.dev, cfg.topicBase, cfg.topicBases]);
  if (site && cfg.site !== site) cfg.site = site;
  if (gateway && cfg.dev !== gateway) cfg.dev = gateway;
  return alignSiteDevFromSession().then(() => {
    if (before !== JSON.stringify([cfg.site, cfg.dev, cfg.topicBase, cfg.topicBases])) { LS.set('cfg', cfg); connect(); }
  });
};

async function alignSiteDevFromSession() {
  const session = LS.get('session', null);
  if (!session?.token || session.demo || cfg.demo) {
    lockTenantFields(false);
    return;
  }
  try {
    const r = await fetch(`${session.apiBase || location.origin}/api/me`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!r.ok) return;
    const me = await r.json();
    S.dashboardAdmin = Boolean(me.dashboardAdmin);
    applyRole(me.role);
    applySubscription(me.subscription);
    LS.set('session', { ...session, role: me.role, dashboardAdmin: S.dashboardAdmin });
    let changed = false;
    if (me.mqtt) {
      const cv = me.mqtt.controlVia || 'mqtt'; if (cfg.controlVia !== cv) { cfg.controlVia = cv; changed = true; }
      if (cfg.user !== me.mqtt.user) { cfg.user = me.mqtt.user; changed = true; }
      if (cfg.pass !== me.mqtt.pass) { cfg.pass = me.mqtt.pass; changed = true; }
      if (cfg.site !== me.mqtt.site) { cfg.site = me.mqtt.site; changed = true; }
      if (cfg.dev !== me.mqtt.device) { cfg.dev = me.mqtt.device; changed = true; }
      if (me.mqtt.topicBase && cfg.topicBase !== me.mqtt.topicBase) { cfg.topicBase = me.mqtt.topicBase; changed = true; }
      const bases = me.mqtt.topicBases;
      if (Array.isArray(bases) && JSON.stringify(cfg.topicBases) !== JSON.stringify(bases)) {
        cfg.topicBases = bases; changed = true;
      }
    } else if (me.notifySite) {
      if (cfg.site !== me.notifySite) { cfg.site = me.notifySite; changed = true; }
      if (cfg.dev !== me.notifyDevice) { cfg.dev = me.notifyDevice; changed = true; }
    }
    if (changed) LS.set('cfg', cfg);
    loadSettings();
    lockTenantFields(true);
  } catch {}
}
function connect() {
  if (window.AppLock?.isLocked()) return;
  if (link) link.stop();
  S.status = 'offline';
  const h = { status: onStatus, regs: onRegs, ack: onAck, history: onHist };
  link = cfg.demo ? new DemoLink(h) : new MqttLink(h);
  link.start();
}
function loadSettings() {
  $('#demo').checked = cfg.demo;
  ['url', 'user', 'pass', 'site', 'dev', 'inNames', 'outNames', 'maxRate', 'pitchCm', 'keepMinDays', 'keepHourDays', 'maxMB'].forEach((k) => { $('#' + k).value = cfg[k]; });
  showStorage();
}

/* Local storage panel: usage vs. cap, and clear button */
async function showStorage() {
  const el = $('#storage-info'); if (!el) return;
  try {
    const s = await DB.stats(), mb = (b) => (b / 1048576).toFixed(1);
    el.textContent = `Đang dùng ~${mb(s.estBytes)} MB (${s.min} điểm/phút, ${s.hour} điểm/giờ, ${s.raw} điểm thô)`
      + (s.maxBytes ? ` · giới hạn ${mb(s.maxBytes)} MB` : ' · không giới hạn dung lượng')
      + (s.quota ? ` · trình duyệt cấp tối đa ${mb(s.quota)} MB` : '');
  } catch { el.textContent = ''; }
}

document.querySelectorAll('nav button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
$('#uiMode').value = cfg.uiMode;
$('#uiMode').onchange = () => { cfg.uiMode = $('#uiMode').value; LS.set('cfg', cfg); location.reload(); }; // tải lại để dựng đúng bố cục và biểu đồ của kiểu mới
applyUi();
$('#m-auto').onclick = () => command('Chuyển chế độ Tự động', R.MODE, 0, ['Chuyển sang Tự động?', 'PLC sẽ tự chạy theo chương trình; các đầu ra bật tay sẽ không còn tác dụng.', 'Tự động']);
$('#m-man').onclick = () => command('Chuyển chế độ Thủ công', R.MODE, 1, ['Chuyển sang Thủ công?', 'Bạn sẽ bật/tắt từng đầu ra bằng tay. Khoá liên động của PLC vẫn có hiệu lực.', 'Thủ công']);
$('#switches').onclick = (e) => {
  const b = e.target.closest('.sw'); if (!b || b.disabled) return;
  const i = +b.dataset.i, n = names(cfg.outNames, 'Y')[i], turnOn = !(S.regs[R.MAN] >> i & 1);
  command(`${turnOn ? 'Bật' : 'Tắt'} ${n}`, R.MAN, S.regs[R.MAN] ^ (1 << i), [`${turnOn ? 'Bật' : 'Tắt'} ${n}?`, `Đầu ra Y${i} sẽ ${turnOn ? 'bật' : 'tắt'} ngay.`, turnOn ? 'Bật' : 'Tắt']);
};
$('#name-link').onclick = () => { showTab('set'); setTimeout(() => $('#outNames')?.focus(), 50); return false; };
document.querySelectorAll('.conv-range').forEach((el) => el.onclick = (e) => { if (e.target.dataset.h) { rangeH = +e.target.dataset.h; render(); } });
$('#q-go').onclick = queryRead;
document.addEventListener('click', (e) => {   // machine control: same buttons on Tổng quan and in the dashboard panel
  const id = e.target.id;
  if (id === 'w-start' || id === 'dc-start') command('Chạy máy', R.RUN_REQ, 1, RUN_CF);
  else if (id === 'w-stop' || id === 'dc-stop') command('Dừng máy', R.RUN_REQ, 0, STOP_CF);
});
$('#cum-range').onclick = (e) => { if (e.target.dataset.h) { cumH = +e.target.dataset.h; LS.set('cumH', cumH); render(); } };
$('#c-start').onclick = () => command('Chạy máy', R.RUN_REQ, 1, RUN_CF);
$('#c-stop').onclick = () => command('Dừng máy', R.RUN_REQ, 0, STOP_CF);
$('#c-set').onclick = () => { const v = parseInt($('#target').value || '0', 10); if (v >= 0 && v <= 65535) sendReg(R.TARGET, v); else toast('Giá trị không hợp lệ. Hãy nhập số từ 0 đến 65535.', true); };
$('#c-reset').onclick = () => { if (confirm('Xoá số đếm hiện tại về 0?')) sendReg(R.RESET, 1); };
$('#save').onclick = () => {
  cfg.demo = $('#demo').checked;
  const session = LS.get('session', null);
  const locked = session?.token && !session.demo && !cfg.demo;
  const keys = locked
    ? ['url', 'inNames', 'outNames', 'maxRate', 'pitchCm']
    : ['url', 'user', 'pass', 'site', 'dev', 'inNames', 'outNames', 'maxRate', 'pitchCm'];
  keys.concat(['keepMinDays', 'keepHourDays', 'maxMB']).forEach((k) => { cfg[k] = $('#' + k).value.trim(); });
  applyDbLimits();
  // Tenant fields always come from account when logged in (cannot pivot to another user/PLC)
  if (locked) {
    /* keep cfg.user/pass/site/dev from alignSiteDevFromSession */
  }
  LS.set('cfg', cfg); openDb().then(() => { connect(); DB.compact().then(showStorage); showTab('dash'); toast('Đã lưu'); });
};
$('#storage-clear').onclick = async () => {
  if (!confirm('Xoá toàn bộ dữ liệu lịch sử lưu trên thiết bị này? (dữ liệu trên máy chủ không bị ảnh hưởng)')) return;
  await DB.clearAll(); hist = []; showStorage(); toast('Đã xoá dữ liệu trên thiết bị');
};
$('#logout').onclick = async () => {
  // Hộp xác nhận trong trang (không dùng confirm() của trình duyệt: ở một số app/PWA nó bị chặn và nút "không làm gì")
  if (!(await confirmAction('Đăng xuất?', 'Bạn sẽ phải đăng nhập lại để xem và điều khiển thiết bị.', 'Đăng xuất'))) return;
  toast('Đang đăng xuất…');
  const session = LS.get('session', null);
  // Gọi máy chủ tối đa 3 giây mỗi bước: mạng chậm/mất mạng vẫn đăng xuất được trên máy này, không bị treo.
  const post = (path, headers) => Promise.race([
    fetch(`${session.apiBase || location.origin}${path}`, { method: 'POST', headers, keepalive: true }).catch(() => {}),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  try {
    if (session?.token) {
      const ctl = LS.get('ctl', null);
      // thu hồi phiên điều khiển phía server rồi mới đăng xuất
      if (ctl?.token) await post('/api/control/lock', { Authorization: `Bearer ${session.token}`, 'X-Control-Token': ctl.token });
      await post('/api/logout', { Authorization: `Bearer ${session.token}` });
    }
  } catch {}
  LS.set('session', null);
  // token điều khiển, vé đăng ký và yêu cầu thiết bị dở dang không được ở lại sau khi đăng xuất
  try { ['session', 'ctl', 'enroll', 'devReq'].forEach((k) => localStorage.removeItem(k)); } catch {}
  location.replace('login.html?out=1'); // out=1: người dùng chủ động đăng xuất → không tự đăng nhập lại bằng vân tay
};
let hideTimer = null;   // hidden tab for 5 min -> release the broker connection; reconnect on return
document.addEventListener('app-locked', () => { link.stop(); S.status = 'offline'; });
document.addEventListener('visibilitychange', () => {
  if (window.AppLock?.isLocked()) return;
  clearTimeout(hideTimer);
  if (document.hidden) { if (!cfg.demo) hideTimer = setTimeout(() => { link.stop(); S.status = 'offline'; }, 300000); }
  else if (!cfg.demo) {
    if (S.status === 'offline') connect();
    syncCloudHistory().then(() => DB.range('raw', Date.now() - 3600e3, Date.now())).then((rows) => {
      if (rows?.length) hist = rows.map((r) => [r.t, r.o, r.i, r.a, r.c]);
    }).catch(() => {});
  }
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
applyDbLimits();
loadSettings();
applyRole(LS.get('session', null)?.role);
alignSiteDevFromSession()
  .then(() => openDb())
  .then(() => { connect(); showTab('dash'); DB.compact(); });
setInterval(() => { if (!document.hidden) renderStatus(); }, 1000);
setInterval(() => { DB.compact().then(() => { if (!$('#tab-rep').hidden) Dash.refresh(true); }); }, 60000);
setInterval(() => { if (!document.hidden && !$('#tab-rep').hidden) Dash.refresh(false); }, 10000);
