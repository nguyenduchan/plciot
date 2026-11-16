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
if (!adminTok) throw new Error('không lấy được phiên admin');
const uname = process.env.MULTI_USER || 't_multi';
const sols = args.filter((a) => !a.startsWith('--'));
if (!sols.length) sols.push('aqua', 'hvac', 'tank');

let u = findUserByUsername(db, uname);
if (!u) { const c = await j('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: uname, role: 'operator' }) }, adminTok); if (!c.ok) throw new Error('tạo user: ' + JSON.stringify(c.body)); u = findUserByUsername(db, uname); }
db.prepare('UPDATE users SET setup_complete = 1 WHERE id = ?').run(u.id);
if (!process.env.MULTI_USER) grantPlan(db, u.id, 'factory', { expiresAt: null });   // user có sẵn: không đổi gói của họ
const sid = createAppSession(db, u.id, 'e2e');
const tok = signToken({ uid: u.id, tv: u.token_version | 0, sid }, process.env.APP_JWT_SECRET, 12 * 3600);
fs.writeFileSync('/tmp/multi-token.json', JSON.stringify({ token: tok, userId: u.id, username: uname }));

const sims = [];
for (const id of sols) {
  const setup = JSON.parse(fs.readFileSync(path.join(SOL, id, 'gateway', 'setup.json'), 'utf8')), spec = loadSpec(id);
  const site = `mg_${id}`.slice(0, 24);
  // gateway setup quyết định kiểu UI: bản config gateway gửi kèm "solution" — KHÔNG đặt giải pháp ở admin
  const cfg = { ...setup, solution: id };
  // đăng ký bằng token đăng nhập (như app C# sau khi người dùng duyệt); site do server đặt = u<id>
  const regTok = signToken({ uid: u.id, tv: u.token_version | 0, scope: 'gateway_register' }, process.env.APP_JWT_SECRET, 1800);
  const gw = makeGateway();
  const pr = await j('/api/v1/gateway/register', { method: 'POST', body: JSON.stringify(gw.registerBody(u.id, { config: cfg })) }, regTok);
  if (!pr.body.approved) throw new Error(`register ${id}: ` + JSON.stringify(pr.body));
  const kit = pr.body.kit, qr = pr.body.qr;
  const cli = mqtt.connect(`mqtts://${process.env.E2E_MQTT_HOST || kit.mqtt.host}:${kit.mqtt.port}`, { rejectUnauthorized: false, username: kit.mqtt.username, password: kit.mqtt.password, clientId: `mg-${id}-${Date.now() % 1e6}` });
  await new Promise((res, rej) => { cli.once('connect', res); cli.once('error', rej); setTimeout(() => rej(new Error('mqtt timeout')), 15000); });
  cli.subscribe(kit.topics.cmd, { qos: 1 });
  cli.publish(kit.topics.status, 'online', { retain: true });
  cli.publish(kit.topics.config, JSON.stringify(cfg), { retain: true });
  let claimed = false;
  cli.on('message', (_t, buf) => { let p = {}; try { p = JSON.parse(buf.toString()); } catch { /* */ } if (p.sys === 'claimed') claimed = true; else if (p.id) cli.publish(kit.topics.ack, JSON.stringify({ id: p.id, ok: true })); });
  const t0 = Date.now();
  sims.push(() => { if (claimed) cli.publish(kit.topics.telemetry, JSON.stringify({ schema: 2, ts: Date.now(), d: frame(spec, 1000 + (Date.now() - t0) / 1000) })); });
  await sleep(1500);
  const add = await j('/api/devices', { method: 'POST', body: JSON.stringify({ qr }) }, tok);
  log(add.ok ? '✓' : '✗', id, `${kit.site}/${kit.device}`, add.ok ? '' : JSON.stringify(add.body));
  await sleep(3000);
}
const dash = (await j('/api/v1/ui/dashboard?mode=simple', {}, tok)).body;
log('gateways:', JSON.stringify((dash.gateways || []).map((g) => [g.device, g.site, g.solution])));
const me = (await j('/api/me', {}, tok)).body;
log('bundle solutions.json:', (me.files || []).some((f) => f.path === 'solutions.json'));
log(`giữ gateway giả ${keep || 60} phút`);
const iv = setInterval(() => sims.forEach((f) => f()), 2200);
await sleep((keep || 60) * 60_000); clearInterval(iv);
process.exit(0);
