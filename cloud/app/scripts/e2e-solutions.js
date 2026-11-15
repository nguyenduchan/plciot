#!/usr/bin/env node
/**
 * E2E mọi giải pháp ngành trên server THẬT, đúng quy trình:
 *   admin tạo mã ghép cặp → gateway giả ghép cặp bằng gateway/setup.json của giải pháp → ra QR →
 *   tài khoản test t_<id> (đã map giải pháp) quét QR → gateway nhận {sys:claimed} → gửi số liệu mẫu của giải pháp →
 *   kiểm tra dashboard (thiết bị + widget đúng bản khai), field bắt buộc, bundle webapp của user đúng giải pháp, lệnh điều khiển tới gateway.
 * Chạy TRONG container app:
 *   docker cp cloud/app/scripts/e2e-solutions.js plciot-app:/app/scripts/ && docker cp solutions plciot-app:/tmp/sol
 *   docker exec -w /app -e E2E_SOLUTIONS=/tmp/sol plciot-app node scripts/e2e-solutions.js [id ...] [--keep=phút] [--cleanup]
 * --keep=N: giữ gateway giả gửi số liệu N phút (để mở webapp xem); token test ghi vào /tmp/e2e-tokens.json.
 * --cleanup: thu hồi gateway/tem thử (giữ nguyên tài khoản t_<id>).
 */
import fs from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';
import { makeGateway } from './gw-identity.js';
import { openDb, findUserByUsername } from '../src/db.js';
import { createAppSession, signToken } from '@plciot/security';
import { grantPlan } from '../src/entitlements.js';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3080';
const SOL = process.env.E2E_SOLUTIONS || '/app/solutions';
const args = process.argv.slice(2);
const keep = Number((args.find((a) => a.startsWith('--keep=')) || '').slice(7)) || 0;
const cleanup = args.includes('--cleanup');
const ids = args.filter((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function j(p, opt = {}, tok) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(opt.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    if (r.status === 429) { await sleep(Number(r.headers.get('retry-after') || 8) * 1000); continue; }
    return { status: r.status, ok: r.ok, body };
  }
  throw new Error('rate_limited ' + p);
}

// máy phát số liệu mẫu (giống industry.js)
function genValue(g, t) {
  if (typeof g === 'number') return g;
  if (Array.isArray(g)) { const [base, amp, per = 60, ph = 0] = g; return base + amp * Math.sin((2 * Math.PI * (t + ph)) / per) + amp * 0.05 * Math.sin(t * 0.9 + ph); }
  if (g && g.sin) { const [base, amp, per = 60, ph = 0] = g.sin; return base + amp * Math.sin((2 * Math.PI * (t + ph)) / per); }
  if (g && g.sq) { const p = g.p || 40, duty = g.duty ?? 0.7; return ((t + (g.ph || 0)) % p) / p < duty ? g.sq[1] : g.sq[0]; }
  if (g && g.cnt != null) return (g.start || 0) + g.cnt * t;
  return 0;
}
const frame = (spec, t) => {
  const d = {};
  for (const [id, dv] of Object.entries(spec.demo.devices)) {
    d[id] = {};
    for (const [k, g] of Object.entries(dv.f)) { let v = genValue(g, t); if (Array.isArray(g) || typeof g === 'number' || (g && g.sin)) v = +v.toFixed(dv.dec?.[k] ?? 2); d[id][k] = v; }
  }
  return d;
};
const loadSpec = (id) => { const t = fs.readFileSync(path.join(SOL, id, 'webapp', 'spec.js'), 'utf8'); return JSON.parse(t.slice(t.indexOf('window.INDUSTRY =') + 17).replace(/;\s*$/, '')); };

const db = openDb(process.env.DATA_DIR || '/app/data');
const adminTok = (await j('/api/admin/local-session')).body.token;
if (!adminTok) throw new Error('không lấy được phiên admin (ADMIN_SSH_LOGIN)');

if (args.includes('--purge')) {   // dọn mọi gateway/tem thử e2e_* (giữ tài khoản t_<id>); thu hồi từng cái, giãn 4 giây
  const sites = db.prepare('SELECT DISTINCT site FROM hardware_devices').all().map((r) => r.site).filter((x) => x.startsWith('e2e_'));
  for (const st of sites) { const d = await j(`/api/admin/hardware/${st}/gw01?force=1`, { method: 'DELETE' }, adminTok); log(d.ok ? '✓' : '✗', 'thu hồi', st); await sleep(4000); }
  for (const st of sites) db.prepare('DELETE FROM user_devices WHERE site = ?').run(st);
  log(`đã dọn ${sites.length} gateway thử`); process.exit(0);
}

const all = fs.readdirSync(SOL).filter((d) => /^[a-z][a-z0-9_]*$/.test(d) && fs.existsSync(path.join(SOL, d, 'gateway', 'setup.json')) && fs.existsSync(path.join(SOL, d, 'webapp', 'spec.js')));
const list = ids.length ? ids : all;
const tokens = {}, sims = [], results = [];
let nfail = 0;
const check = (r, ok, msg) => { r.checks.push({ ok, msg }); if (!ok) { r.fail++; nfail++; } };

for (const id of list) {
  const r = { id, checks: [], fail: 0 };
  results.push(r);
  try {
    const spec = loadSpec(id), setup = JSON.parse(fs.readFileSync(path.join(SOL, id, 'gateway', 'setup.json'), 'utf8'));
    // 1) tài khoản test t_<id> map đúng giải pháp
    const uname = `t_${id}`;
    let u = findUserByUsername(db, uname);
    if (!u) { const c = await j('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: uname, role: 'operator', solution: id }) }, adminTok); check(r, c.ok, `tạo tài khoản ${uname}: ${c.ok ? 'ok' : JSON.stringify(c.body)}`); u = findUserByUsername(db, uname); }
    else { const p = await j(`/api/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ solution: id }) }, adminTok); check(r, p.ok, `map ${uname} → ${id}`); }
    u = findUserByUsername(db, uname);
    db.prepare('UPDATE users SET setup_complete = 1 WHERE id = ?').run(u.id);
    grantPlan(db, u.id, 'factory', { expiresAt: null });
    const sid = createAppSession(db, u.id, 'e2e');
    const tok = signToken({ uid: u.id, tv: u.token_version | 0, sid }, process.env.APP_JWT_SECRET, 12 * 3600);
    tokens[id] = { token: tok, userId: u.id, username: uname };
    check(r, u.solution === id, `users.solution = ${u.solution}`);

    // 2) ghép cặp gateway bằng bản khai của giải pháp (chạy lại: dọn thiết bị thử cũ của tài khoản trước)
    const site = `e2e_${id}`.slice(0, 24);
    db.prepare('DELETE FROM user_devices WHERE user_id = ?').run(u.id);
    const old = await j(`/api/admin/hardware/${site}/gw01?force=1`, { method: 'DELETE' }, adminTok);
    await sleep(old.ok ? 4000 : 500);   // mỗi lần thu hồi ghi lại passwd + nạp lại broker: không dồn dập (dồn dập từng làm broker thoát)
    const pc = await j('/api/admin/pairings', { method: 'POST', body: JSON.stringify({ site, label: `E2E ${id}`, auto: true, solution: id }) }, adminTok);
    check(r, pc.body.solution === id, `mã ghép cặp mang giải pháp ${id}`);
    check(r, pc.ok && pc.body.code, `admin tạo mã ghép cặp (${pc.body.code || JSON.stringify(pc.body)})`);
    const gw = makeGateway();
    const pr = await j('/api/v1/gateway/pair', { method: 'POST', body: JSON.stringify(gw.pairBody(pc.body.code, { config: setup })) });
    check(r, pr.ok && pr.body.approved, `gateway ghép cặp + nhận QR (${pr.body.error || 'approved'})`);
    const kit = pr.body.kit, qr = pr.body.qr;
    // mapping 1-1: kit trả giải pháp + giao diện gateway dạng dữ liệu (ui.json) khớp spec webapp
    check(r, kit?.solution === id, `kit.solution = ${kit?.solution}`);
    check(r, kit?.ui?.id === id && JSON.stringify(kit.ui.spec.metrics) === JSON.stringify(spec.metrics), 'kit.ui (giao diện gateway) khớp spec webapp');
    check(r, !!kit?.ui?.palette?.bg && !!kit?.ui?.short, 'kit.ui có bảng màu + tên ngắn');
    check(r, (kit?.pack || []).length === setup.devices.length, `pack của kit = ${(kit?.pack || []).length}/${setup.devices.length} thiết bị`);
    for (const dv of setup.devices) {
      const got = (kit.pack.find((p) => p.id === dv.id) || {}).fields || [];
      const miss = dv.fields.map((f) => f.key).filter((k) => !got.includes(k));
      check(r, miss.length === 0, `pack ${dv.id}: đủ ${dv.fields.length} field${miss.length ? ' — thiếu ' + miss : ''}`);
    }

    // 3) gateway nối MQTTS công khai
    const cmds = [];
    let claimed = false;
    const cli = mqtt.connect(`mqtts://${process.env.E2E_MQTT_HOST || kit.mqtt.host}:${kit.mqtt.port}`, { rejectUnauthorized: false, username: kit.mqtt.username, password: kit.mqtt.password, clientId: `gwsim-${id}-${Date.now() % 1e5}`, reconnectPeriod: 2000 });
    await new Promise((res, rej) => { cli.once('connect', res); cli.once('error', rej); setTimeout(() => rej(new Error('mqtt timeout')), 15000); });
    cli.subscribe(kit.topics.cmd, { qos: 1 });
    cli.publish(kit.topics.status, 'online', { retain: true });
    cli.publish(kit.topics.config, JSON.stringify(setup), { retain: true });
    cli.on('message', (_t, buf) => { let p = {}; try { p = JSON.parse(buf.toString()); } catch { /* */ } if (p.sys === 'claimed') claimed = true; else cmds.push(p); if (p.id && p.sys !== 'claimed') cli.publish(kit.topics.ack, JSON.stringify({ id: p.id, ok: true, ts: Date.now() }), { qos: 1 }); });
    const t0 = Date.now(), pub = () => { if (claimed) cli.publish(kit.topics.telemetry, JSON.stringify({ schema: 2, ts: Date.now(), d: frame(spec, 1000 + (Date.now() - t0) / 1000) }), { qos: 0 }); };
    sims.push({ cli, pub, id });

    // 4) user quét QR (user CHƯA có giải pháp riêng → webapp của user tự map theo giải pháp của gateway)
    await j(`/api/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ solution: '' }) }, adminTok);
    const add = await j('/api/devices', { method: 'POST', body: JSON.stringify({ qr }) }, tok);
    check(r, add.body.solutionApplied === id, `quét QR → webapp tự map giải pháp ${add.body.solutionApplied || '(không)'} `);
    check(r, findUserByUsername(db, uname).solution === id, 'users.solution = giải pháp của gateway sau khi quét');
    check(r, add.ok, `${uname} quét QR → thêm thiết bị (${add.ok ? (add.body.added ?? 'ok') : JSON.stringify(add.body)})`);
    for (let i = 0; i < 20 && !claimed; i++) await sleep(300);
    check(r, claimed, 'gateway nhận {sys:claimed} sau khi user quét');
    for (let i = 0; i < 4; i++) { pub(); await sleep(2200); }

    // 5) dashboard đúng bản khai
    const dash = (await j('/api/v1/ui/dashboard?mode=control', {}, tok)).body;
    const nodes = (dash.devices || []).filter((d) => d.site === site || d.gateway?.site === site || true);
    for (const dv of setup.devices) {
      const node = nodes.find((n) => n.childId === dv.id);
      check(r, !!node, `dashboard có thiết bị ${dv.id}`);
      if (!node) continue;
      const wk = node.widgets || [];
      check(r, wk.length === dv.fields.length, `${dv.id}: ${wk.length}/${dv.fields.length} widget`);
      const kinds = { switch: 'toggle', led: 'status', gauge: 'gauge', kpi: 'kpi' };
      const bad = dv.fields.filter((f) => { const w = wk.find((x) => x.bind === f.key); return !w || w.kind !== kinds[f.widget]; }).map((f) => f.key);
      check(r, bad.length === 0, `${dv.id}: loại widget đúng${bad.length ? ' — sai: ' + bad.join(',') : ''}`);
    }

    // 6) field bắt buộc khớp bản khai gateway
    const keys = new Set(setup.devices.flatMap((d) => d.fields.map((f) => f.key.toLowerCase())));
    const metricKeys = (mid) => { const mt = spec.metrics.find((x) => x.id === mid); return mt ? (mt.keys || [mid]).map((k) => (Array.isArray(k) ? k[0] : k).toLowerCase()) : []; };
    for (const rq of spec.required) {
      const ok = rq.startsWith('key:') ? keys.has(rq.slice(4)) : metricKeys(rq).some((k) => keys.has(k));
      check(r, ok, `field bắt buộc "${rq}" có trong bản khai gateway`);
    }

    // 7) bundle webapp của user đúng giải pháp
    const me = (await j('/api/me', {}, tok)).body;
    const fl = (me.files || []).map((f) => f.path);
    check(r, ['spec.js', 'industry.js', 'industry.css', 'theme.css'].every((f) => fl.includes(f)), 'bundle của user có spec.js/industry.js/industry.css/theme.css');
    const sp = await fetch(`${BASE}/api/bundle/spec.js`, { headers: { Authorization: `Bearer ${tok}` } }).then((x) => x.text());
    check(r, sp.includes(`"id": "${id}"`), 'spec.js trong bundle đúng giải pháp');
    const idx = await fetch(`${BASE}/api/bundle/index.html`, { headers: { Authorization: `Bearer ${tok}` } }).then((x) => x.text());
    check(r, idx.includes('industry.js') && idx.indexOf('industry.js') > idx.indexOf('app.js'), 'index.html chèn industry.js sau app.js');

    // 8) điều khiển: lệnh tới gateway (chỉ giải pháp có công tắc)
    const sw = setup.devices.flatMap((d) => d.fields.filter((f) => f.widget === 'switch').map((f) => ({ child: d.id, key: f.key })))[0];
    if (sw) {
      const gwSel = `${kit.site}/${kit.device}`;
      const c = await j('/api/control/cmd', { method: 'POST', body: JSON.stringify({ child: sw.child, key: sw.key, v: 1, gw: gwSel }) }, tok);
      check(r, c.ok, `lệnh điều khiển ${sw.child}.${sw.key} (${c.ok ? 'ok' : JSON.stringify(c.body)})`);
      for (let i = 0; i < 15 && !cmds.some((x) => x.child === sw.child && x.key === sw.key); i++) await sleep(300);
      check(r, cmds.some((x) => x.child === sw.child && x.key === sw.key), 'gateway nhận đúng lệnh {child,key,v}');
    } else check(r, true, '(giải pháp chỉ giám sát, không có công tắc điều khiển)');
    r.site = site; r.gwSel = `${kit.site}/${kit.device}`;
  } catch (e) { check(r, false, 'LỖI: ' + e.message); }
  log(`${r.fail ? '✗' : '✓'} ${id.padEnd(11)} ${r.checks.length - r.fail}/${r.checks.length}` + r.checks.filter((c) => !c.ok).map((c) => `\n     ✗ ${c.msg}`).join(''));
}

fs.writeFileSync('/tmp/e2e-tokens.json', JSON.stringify(tokens, null, 1));
log(`\n${results.length} giải pháp, ${nfail} kiểm tra thất bại`);
if (keep && !cleanup) {
  log(`giữ ${sims.length} gateway giả ${keep} phút (token: /tmp/e2e-tokens.json)`);
  const t0 = Date.now();
  const iv = setInterval(() => sims.forEach((s) => s.pub()), 2200);
  await sleep(keep * 60_000); clearInterval(iv);
}
sims.forEach((s) => s.cli.end(true));
if (cleanup) {
  for (const r of results) if (r.site) { await j(`/api/admin/hardware/${r.site}/gw01?force=1`, { method: 'DELETE' }, adminTok); await sleep(4000); }
  db.prepare("DELETE FROM user_devices WHERE site LIKE 'e2e_%'").run();
  log('đã thu hồi gateway/tem thử (giữ tài khoản t_<id>)');
}
process.exit(nfail ? 1 : 0);
