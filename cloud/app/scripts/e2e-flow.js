#!/usr/bin/env node
/**
 * Phía NGƯỜI DÙNG của bài test đầu-cuối "gateway mới → quét QR → giám sát/điều khiển → gateway thêm thiết bị" trên server thật.
 * Phía gateway là GatewayApp thật chạy `--freshtest` trên PC (xem tools/GatewayApp/FreshTest.cs + tools/GatewayApp/e2e/run-flow.sh).
 * Chạy TRONG container app (dùng DB + khoá của server, gọi API qua 127.0.0.1 như một trình duyệt):
 *   docker exec -w /app plciot-app node scripts/e2e-flow.js prep            → tài khoản thử + token đăng ký gateway (JSON: uid, regToken)
 *   docker exec -w /app plciot-app node scripts/e2e-flow.js scan <qr>       → user thêm thiết bị bằng QR
 *   docker exec -w /app plciot-app node scripts/e2e-flow.js dash            → dashboard của user (thiết bị, widget, số liệu mới nhất)
 *   docker exec -w /app plciot-app node scripts/e2e-flow.js cmd <child> <key> <v>   → lệnh điều khiển qua /api/control/cmd (có bước hai)
 *   docker exec -w /app plciot-app node scripts/e2e-flow.js cleanup         → thu hồi gateway thử (giữ tài khoản)
 * Bước hai (Face ID/TOTP) không tự động hoá được: script cấp sẵn một phiên điều khiển loại `totp` trong DB cho tài khoản thử —
 * đúng thứ server tạo ra sau khi người dùng nhập mã, nên đường kiểm tra step-up của /api/control/cmd vẫn chạy thật.
 */
import fs from 'node:fs';
import mqtt from 'mqtt';
import { openDb, findUserByUsername } from '../src/db.js';
import { createAppSession, signToken, createControlSession } from '@plciot/security';
import { grantPlan } from '../src/entitlements.js';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3080';
const STATE = '/tmp/e2e-flow.json';
const USER = process.env.E2E_FLOW_USER || 't_flow';
const [cmd, ...rest] = process.argv.slice(2);
const db = openDb(process.env.DATA_DIR || '/app/data');
const state = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));

async function j(p, opt = {}, tok, extra = {}) {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...extra } });
  let body = {}; try { body = await r.json(); } catch { /* không phải JSON */ }
  return { ok: r.ok, status: r.status, body };
}

if (cmd === 'prep') {
  const adminTok = (await j('/api/admin/local-session')).body.token;
  if (!adminTok) throw new Error('không lấy được phiên admin (cần ADMIN_SSH_LOGIN=true, gọi từ trong container)');
  let u = findUserByUsername(db, USER);
  if (!u) {
    const c = await j('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: USER, role: 'operator' }) }, adminTok);
    if (!c.ok) throw new Error(`không tạo được tài khoản ${USER}: ${JSON.stringify(c.body)}`);
    u = findUserByUsername(db, USER);
  }
  db.prepare('UPDATE users SET setup_complete = 1 WHERE id = ?').run(u.id);
  grantPlan(db, u.id, 'pro', { expiresAt: null });
  // gateway thử của lượt trước: thu hồi để lượt này là gateway MỚI TINH
  for (const g of db.prepare("SELECT site, device FROM gateway_pairings WHERE user_id = ? AND status = 'approved' AND site IS NOT NULL").all(u.id)) {
    await j(`/api/admin/hardware/${g.site}/${g.device}?force=1`, { method: 'DELETE' }, adminTok);
    db.prepare('DELETE FROM user_devices WHERE site = ? AND user_id = ?').run(g.site, u.id);
  }
  db.prepare("UPDATE gateway_pairings SET status = 'cancelled' WHERE user_id = ? AND status = 'approved'").run(u.id);
  const sid = createAppSession(db, u.id, 'e2e-flow');
  const token = signToken({ uid: u.id, tv: u.token_version | 0, sid }, process.env.APP_JWT_SECRET, 2 * 3600);
  const regToken = signToken({ uid: u.id, tv: u.token_version | 0, scope: 'gateway_register' }, process.env.APP_JWT_SECRET, 1800);
  const ctl = createControlSession(db, u.id, 'totp', '127.0.0.1');
  fs.writeFileSync(STATE, JSON.stringify({ uid: u.id, token, controlToken: ctl.token || ctl, adminTok }), { mode: 0o600 });
  console.log(JSON.stringify({ uid: u.id, user: USER, regToken }));
} else if (cmd === 'scan') {
  const s = state();
  const add = await j('/api/devices', { method: 'POST', body: JSON.stringify({ qr: rest[0] }) }, s.token);
  console.log(JSON.stringify({ ok: add.ok, status: add.status, error: add.body.error, site: add.body.site, added: (add.body.added || add.body.devices || []).length }));
} else if (cmd === 'dash') {
  const s = state();
  const d = (await j('/api/v1/ui/dashboard?mode=simple', {}, s.token)).body;
  const devs = (d.devices || []).map((x) => ({ child: x.childId, title: x.title, gw: x.gw ? `${x.gw.site}/${x.gw.device}` : null, widgets: x.widgets.map((w) => `${w.kind}:${w.bind}${w.cmd ? '*' : ''}${w.locked ? '(khoá)' : ''}`) }));
  // số liệu trực tiếp: nghe đúng topic mà webapp nghe, bằng tài khoản MQTT của user (như trình duyệt), trong vài giây
  let live = null; let liveShard = 0;
  const base = d.telemetry?.topicBase || (d.devices || []).map((x) => x.gw?.base).find(Boolean);
  const me = (await j('/api/me', {}, s.token)).body;
  if (base && me.mqtt?.user) {
    live = await new Promise((resolve) => {
      // nhiều nhóm broker (MQTT_SHARDS > 1): gateway chỉ có mặt trên nhóm của nó — listener nội bộ của nhóm k là cổng 1883 + 10k
      const shard = Number(me.mqtt.shards?.of?.[me.mqtt.mqttId] || 0);
      liveShard = shard;
      const c = mqtt.connect(`mqtt://mqtt:${1883 + 10 * shard}`, { username: me.mqtt.user, password: me.mqtt.pass, reconnectPeriod: 0, connectTimeout: 4000 });
      const done = (v) => { try { c.end(true); } catch { /* */ } resolve(v); };
      const t = setTimeout(() => done({ error: 'không có telemetry trong 12 giây' }), 12000);
      c.on('connect', () => c.subscribe(`${base}/telemetry`));
      c.on('message', (_t, buf) => { clearTimeout(t); try { done(JSON.parse(buf.toString()).d || {}); } catch { done({ error: 'telemetry không phải JSON' }); } });
      c.on('error', (e) => { clearTimeout(t); done({ error: `mqtt: ${e.message}` }); });
    });
  }
  console.log(JSON.stringify({ plan: d.plan?.label, devices: devs, brokerShard: liveShard, live }));
} else if (cmd === 'cmd') {
  const s = state();
  const d = (await j('/api/v1/ui/dashboard?mode=simple', {}, s.token)).body;
  const dev = (d.devices || []).find((x) => x.childId === rest[0]);
  const gw = dev?.gw ? `${dev.gw.site}/${dev.gw.device}` : undefined;
  const noStep = await j('/api/control/cmd', { method: 'POST', body: JSON.stringify({ child: rest[0], key: rest[1], v: Number(rest[2]), gw }) }, s.token);
  const withStep = await j('/api/control/cmd', { method: 'POST', body: JSON.stringify({ child: rest[0], key: rest[1], v: Number(rest[2]), gw }) }, s.token, { 'X-Control-Token': s.controlToken });
  console.log(JSON.stringify({ withoutStepUp: { status: noStep.status, error: noStep.body.error }, withStepUp: { status: withStep.status, ok: withStep.body.ok, id: withStep.body.id, error: withStep.body.error, reason: withStep.body.reason } }));
} else if (cmd === 'cleanup') {
  const s = state();
  const out = [];
  for (const g of db.prepare("SELECT site, device FROM gateway_pairings WHERE user_id = ? AND status = 'approved' AND site IS NOT NULL").all(s.uid)) {
    const r = await j(`/api/admin/hardware/${g.site}/${g.device}?force=1`, { method: 'DELETE' }, s.adminTok);
    db.prepare('DELETE FROM user_devices WHERE site = ? AND user_id = ?').run(g.site, s.uid);
    out.push(`${g.site}/${g.device}:${r.ok ? 'đã thu hồi' : r.body.error}`);
  }
  try { fs.rmSync(STATE); } catch { /* */ }
  console.log(JSON.stringify({ cleaned: out }));
} else {
  console.error('dùng: e2e-flow.js prep | scan <qr> | dash | cmd <child> <key> <v> | cleanup');
  process.exit(2);
}
process.exit(0);
