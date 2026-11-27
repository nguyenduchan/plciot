#!/usr/bin/env node
/**
 * E2E (không cần VPS/board thật): server (remoteAdmin + gatewayLogic, mã thật) ⇄ broker MQTTS tối giản (trong script) ⇄ gw-sim (firmware thật).
 *   node scripts/sim-logic-e2e.js --target 127.0.0.1:8443 --data <SIM_DATA>
 * gw-sim phải vừa khởi động (cửa sổ ghép PC còn mở) với cùng SIM_DATA. Script tự: sinh chứng chỉ broker (openssl), ghép PC + đẩy cấu hình
 * cloud vào gw-sim qua API LAN (ghim chứng chỉ broker, khoá ký lệnh của server), rồi kiểm:
 *   rpc ký rpc1 (enc b64) → board trả rpcr; thiếu mã duyệt → owner_approval_required; sai chữ ký → bỏ + cảnh báo sec.rpc_badsig; phát lại → bỏ;
 *   admin đề xuất text → chủ trạm duyệt (step-up) → board áp dụng → bản tin config mang chương trình mới → server lưu;
 *   lệnh cloud bị chương trình chặn (ack logic_need) / được phép; hẹn giờ của chủ trạm; cảnh báo sec.logic_changed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import tls from 'tls';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import express from 'express';
import mqttPacket from 'mqtt-packet';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TARGET = arg('--target', '127.0.0.1:8443'), SIMDATA = arg('--data');
if (!SIMDATA) { console.error('cần --data <SIM_DATA>'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-e2e-'));
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.DATA_DIR = tmp;
process.env.RADMIN_RPC_TIMEOUT_MS = '8000';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // API LAN của gw-sim dùng chứng chỉ tự ký (GatewayApp ghim khoá; ở đây chỉ thử)

const { openDb } = await import('../src/db.js');
const { setPublisher } = await import('../src/controlPublisher.js');
const R = await import('../src/remoteAdmin.js');
const L = await import('../src/gatewayLogic.js');
const { cmdPublicKey, signCmd, signRpc } = await import('../src/cmdSign.js');

let fails = 0;
const ok = (c, l, extra = '') => { if (!c) { fails++; console.error('FAIL', l, extra); } else console.log('ok  ', l, extra ? `— ${extra}` : ''); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; }

// ---------------------------------------------------------------- broker MQTTS tối giản (MQTT 3.1.1, đủ cho PubSubClient)
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=plciot-test',
  '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
const certPem = fs.readFileSync(path.join(tmp, 'c.pem'));
const PIN = crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).raw).digest('hex');
const MQ = 'a1b2c3d4e5f60718';
let gwSock = null;
const got = { config: [], rpcr: [], ack: [], alert: [] };
const send = (sock, p) => sock.write(mqttPacket.generate(p));
const broker = tls.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: certPem }, (sock) => {
  const parser = mqttPacket.parser({ protocolVersion: 4 });
  sock.on('data', (d) => parser.parse(d));
  sock.on('error', () => {});
  sock.on('close', () => { if (gwSock === sock) gwSock = null; });
  parser.on('packet', (p) => {
    if (p.cmd === 'connect') { send(sock, { cmd: 'connack', returnCode: 0, sessionPresent: false }); gwSock = sock; }
    else if (p.cmd === 'subscribe') send(sock, { cmd: 'suback', messageId: p.messageId, granted: p.subscriptions.map((s) => s.qos) });
    else if (p.cmd === 'pingreq') send(sock, { cmd: 'pingresp' });
    else if (p.cmd === 'publish') {
      if (p.qos === 1) send(sock, { cmd: 'puback', messageId: p.messageId });
      const m = /^gw\/([0-9a-f]{16})\/(\w+)$/.exec(p.topic);
      if (!m) return;
      const kind = m[2], buf = Buffer.from(p.payload);
      if (kind === 'rpcr') { got.rpcr.push(JSON.parse(buf)); R.onRpcReply(m[1], buf); }
      else if (kind === 'config') { const c = JSON.parse(buf); got.config.push(c); if (c.logic) L.recordReportedLogic(db, { site: 'siteA', device: 'gw01', logic: c.logic }); }
      else if (kind === 'ack' || kind === 'alert') got[kind].push(JSON.parse(buf));
    }
  });
});
await new Promise((r) => broker.listen(0, '127.0.0.1', r));
const BPORT = broker.address().port;
const toGw = (topic, payload) => { if (gwSock) send(gwSock, { cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false }); };
setPublisher(async (_s, _d, raw, opts) => { toGw(`gw/${opts.mqttId}/${opts.kind || 'cmd'}`, opts.kind ? raw : signCmd(opts.mqttId, raw)); return {}; });

// ---------------------------------------------------------------- server (mã thật) + DB thử
const db = openDb(tmp);
const { migrateUserDevices } = await import('../src/userDevices.js');
migrateUserDevices(db);
db.prepare(`INSERT INTO users (username, password_hash, folder_path, role, notify_site, notify_device) VALUES ('owner1', 'x', 'f', 'operator', 'siteA', 'gw01')`).run();
{
  const cols = db.prepare("PRAGMA table_info('devices')").all().map((c) => c.name);
  if (!cols.includes('mqtt_id')) db.exec('ALTER TABLE devices ADD COLUMN mqtt_id TEXT');
  db.prepare(`INSERT INTO devices (tenant_id, site, device, mqtt_user, mqtt_pass, created_at, updated_at, mqtt_id) VALUES ('default', 'siteA', 'gw01', 'u1', 'p', ?, ?, ?)`).run(Date.now(), Date.now(), MQ);
  db.prepare(`INSERT INTO gateway_clients (site, device, version, first_seen, last_seen) VALUES ('siteA', 'gw01', 'mcu-sim', ?, ?)`).run(Date.now(), Date.now());
  db.prepare(`INSERT INTO remote_admin_consent (site, device, enabled, updated_at) VALUES ('siteA', 'gw01', 1, ?)`).run(Date.now());
}
const { privateKey: admPriv, publicKey: admPub } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keyId = R.addAdminKey(db, 'may-e2e', admPub.export({ type: 'spki', format: 'der' }).toString('base64url'));
const app = express();
app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
const requireAuth = (req, res, next) => { const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.get('x-test-user') || ''); if (!u) return res.status(401).end(); req.user = u; next(); };
const security = { authorize: (req) => (req.get('x-stepup') === '1' ? {} : { error: 'step_up_required', status: 401 }) };
const admin = R.mountRemoteAdmin(app, { db, requireAuth });
L.mountGatewayLogic(app, { db, requireAuth, security, admin });
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
async function radm(method, p, bodyObj) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const ts = Date.now(), nonce = crypto.randomBytes(12).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(R.radmMessage(method, p.split('?')[0], ts, nonce, crypto.createHash('sha256').update(body).digest('hex'))), { key: admPriv, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-radm-key': keyId, 'x-radm-ts': String(ts), 'x-radm-nonce': nonce, 'x-radm-sig': sig }, body: body || undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const owner = (method, p, b, step) => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': 'owner1', ...(step ? { 'x-stepup': '1' } : {}) }, body: b ? JSON.stringify(b) : undefined })
  .then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

// ---------------------------------------------------------------- ghép PC + cấu hình cloud cho gw-sim (API LAN)
const lan = `https://${TARGET}`;
const pc = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ch = await (await fetch(`${lan}/api/challenge`)).json();
const pk = pc.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const lsig = crypto.sign('sha256', Buffer.from(`admin-login|${ch.Hw}|${ch.Nonce}`), { key: pc.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const login = await (await fetch(`${lan}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Pubkey: pk, Nonce: ch.Nonce, Sig: lsig, Name: 'e2e' }) })).json();
ok(login.Ok, 'ghép PC thử với gw-sim', login.Err || '');
const H = { 'content-type': 'application/json', authorization: `Bearer ${login.Token}` };
const cfg = await (await fetch(`${lan}/api/config`, { headers: H })).json();
cfg.Config = {
  ...cfg.Config, Site: 'siteA', Device: 'gw01', MqttId: MQ, Mobile: 'Control', CloudHost: '127.0.0.1', CloudPort: BPORT, CloudUser: 'gw', CloudPassword: 'x',
  CloudPinSha256: 'f'.repeat(64) + ',' + PIN, CloudCmdKey: cmdPublicKey(), CloudSendData: true, CloudApiUrl: '',   // danh sách ghim (dự phòng giả + đang dùng)
  Connections: [{ Protocol: 'ModbusRtu', Host: 'RS485', Port: 9600, Options: { parity: 'Even', difilter: '0' } }],
  Pack: [
    { Child: 'pump', Field: 'run', MqttKey: 'run', Address: 20, Protocol: 'ModbusRtu', Access: 'ReadWrite', DataType: 'Bool', Scale: 1, Params: { unit: '0' } },
    { Child: 'pump', Field: 'boost', MqttKey: 'boost', Address: 21, Protocol: 'ModbusRtu', Access: 'ReadWrite', DataType: 'Bool', Scale: 1, Params: { unit: '0' } },
    { Child: 'pump', Field: 'float', MqttKey: 'float', Address: 12, Protocol: 'ModbusRtu', Access: 'Read', DataType: 'Bool', Scale: 1, Params: { unit: '0' } },
    // thêm bộ đếm DI cho cấu hình đủ lớn (> 1 phần rpcr) — thử ghép trả lời nhiều phần
    ...Array.from({ length: 16 }, (_, k) => ({ Child: 'counters', Field: `dem_dau_vao_so_${k + 1}`, MqttKey: `c${k + 1}`, Address: 40 + (k % 8) * 2, Protocol: 'ModbusRtu', Access: 'Read', DataType: 'UInt32', Scale: 1, Params: { unit: '0' } })),
  ],
};
const put = await (await fetch(`${lan}/api/config`, { method: 'PUT', headers: H, body: JSON.stringify(cfg) })).json();
ok(put.Ok, 'đẩy cấu hình cloud (broker thử, ghim chứng chỉ, khoá ký server) vào gw-sim', put.Err || '');
await fetch(`${lan}/api/offline`, { method: 'PUT', headers: H, body: JSON.stringify({ Do: [] }) });   // bắt đầu từ chương trình trống
fs.writeFileSync(path.join(SIMDATA, 'di.txt'), '0');
const doNow = () => { try { return parseInt(fs.readFileSync(path.join(SIMDATA, 'do.txt'), 'utf8').trim(), 10); } catch { return -1; } };

ok(await until(() => gwSock, 30000), 'gw-sim nối broker MQTTS (TLS + ghim chứng chỉ)');
ok(await until(() => got.config.find((c) => c.logic && Array.isArray(c.logic.do)), 15000), 'bản tin config có "logic" (rev, sha, do, names, keys)');
const lc = got.config.at(-1)?.logic || {};
ok(lc.keys?.['1'] === 'pump.run' && lc.keys?.['2'] === 'pump.boost' && lc.names?.di?.['3'], 'keys DO↔nút + tên DI', JSON.stringify(lc.keys));

// ---------------------------------------------------------------- rpc
let r = await radm('POST', '/api/v1/radmin/rpc', { site: 'siteA', device: 'gw01', method: 'GET', path: '/api/offline' });
const off = JSON.parse(r.j.body || '{}');
ok(r.j.status === 200 && off.Ok && typeof off.Sha === 'string', 'GatewayAdmin GET /api/offline qua broker → board trả (enc b64)', `status=${r.j.status}`);
r = await radm('POST', '/api/v1/radmin/rpc', { site: 'siteA', device: 'gw01', method: 'GET', path: '/api/config' });
{
  const parts = got.rpcr.filter((x) => x.rid === got.rpcr.at(-1)?.rid);
  ok(r.j.status === 200 && JSON.parse(r.j.body).Config?.MqttId === MQ && parts[0]?.n > 1 && parts.length === parts[0].n,
    'trả lời lớn (GET /api/config) chia nhiều phần rpcr, ghép đúng', `${r.j.body.length} byte, ${parts[0]?.n} phần`);
}
let x = await R.callGateway(MQ, { method: 'PUT', path: '/api/offline', body: JSON.stringify({ Do: [{ Ch: 1, Mode: 'on' }] }), label: 'e2e', mcu: true });
ok(x.status === 403 && JSON.parse(x.body).Err === 'owner_approval_required', 'PUT /api/offline thiếu mã duyệt → board từ chối', x.body);
x = await R.callGateway(MQ, { method: 'POST', path: '/api/offline/test', body: '{"Sec":5}', label: 'e2e', mcu: true });
ok(x.status === 403 && JSON.parse(x.body).Err === 'remote_route_blocked', 'thử mất mạng từ xa → board chặn route', x.body);

const nRpcr = got.rpcr.length, nAlert = got.alert.length;
const goodRaw = signRpc(MQ, { rid: 'e2e-replay-1', ts: Date.now(), m: 'GET', p: '/api/state', b: '', adm: 'e2e', enc: 'b64' });
const badRaw = goodRaw.replace('"p":"/api/state"', '"p":"/api/ota"');
toGw(`gw/${MQ}/rpc`, badRaw);
await sleep(1500);
ok(got.rpcr.length === nRpcr, 'rpc sửa nội dung (sai chữ ký) → board bỏ, không trả lời');
ok(await until(() => got.alert.slice(nAlert).find((a) => a.k === 'sec.rpc_badsig'), 8000), 'board gửi cảnh báo sec.rpc_badsig');
toGw(`gw/${MQ}/rpc`, goodRaw); await sleep(1200); toGw(`gw/${MQ}/rpc`, goodRaw); await sleep(1500);
ok(got.rpcr.filter((p) => p.rid === 'e2e-replay-1').length === 1, 'phát lại cùng rid → chỉ trả lời một lần');
const staleRaw = signRpc(MQ, { rid: 'e2e-stale', ts: Date.now() - 5 * 60_000, m: 'GET', p: '/api/state', b: '', adm: 'e2e', enc: 'b64' });
toGw(`gw/${MQ}/rpc`, staleRaw);
ok(await until(() => got.rpcr.find((p) => p.rid === 'e2e-stale' && p.st === 401), 5000), 'rpc cũ 5 phút → 401 stale_rpc');

// ---------------------------------------------------------------- đề xuất → duyệt → board áp dụng
const TEXT = 'tz 7\ndo1: need di3=1, hold | block do2\ndo2: block do1 | offline 1m: off';
r = await radm('POST', '/api/v1/radmin/logic/propose', { site: 'siteA', device: 'gw01', text: TEXT, note: 'e2e' });
ok(r.status === 200, 'admin gửi đề xuất text');
const pid = r.j.id;
r = await owner('GET', '/api/v1/gateway-logic?gw=siteA/gw01');
ok(r.j.pending?.id === pid && r.j.pending.rows.find((w) => w.ch === 1)?.user.join(' ').includes('Chỉ cho BẬT'), 'chủ trạm thấy bảng đề xuất');
const nAlert2 = got.alert.length;
const revBefore = L.currentLogic(db, 'siteA', 'gw01')?.rev;
r = await owner('POST', '/api/v1/gateway-logic/approve', { gw: 'siteA/gw01', id: pid }, true);
ok(r.status === 200 && r.j.rev === revBefore + 1, 'duyệt → board áp dụng qua broker', JSON.stringify(r.j));
ok(await until(() => { const c = L.currentLogic(db, 'siteA', 'gw01'); return c?.rev === r.j.rev && c.sha && c.program.Do.find((o) => o.Ch === 1)?.NeedHold; }, 8000), 'board gửi lại config → server lưu chương trình mới (rev + sha)');
ok(await until(() => got.alert.slice(nAlert2).find((a) => a.k === 'sec.logic_changed' && /chủ trạm duyệt owner1/.test(a.txt)), 8000), 'cảnh báo sec.logic_changed ghi người duyệt');

// ---------------------------------------------------------------- lệnh cloud qua chương trình
const cmd = async (key, v) => {
  const id = crypto.randomBytes(6).toString('hex');
  toGw(`gw/${MQ}/cmd`, signCmd(MQ, { id, child: 'pump', key, v, ts: Date.now() }));
  return until(() => got.ack.find((a) => a.id === id), 6000);
};
let a = await cmd('run', 1);
ok(a && a.ok === false && a.err === 'logic_need' && (doNow() & 1) === 0, 'lệnh cloud BẬT bơm khi phao = 0 → ack logic_need', JSON.stringify(a));
fs.writeFileSync(path.join(SIMDATA, 'di.txt'), '0x04'); await sleep(1200);
a = await cmd('run', 1);
ok(a?.ok === true && await until(() => (doNow() & 1) === 1, 3000), 'phao = 1 → bật được', JSON.stringify(a));
a = await cmd('boost', 1);
ok(a && a.ok === false && a.err === 'logic_interlock' && (doNow() & 2) === 0, 'bật bơm tăng áp khi bơm giếng chạy → ack logic_interlock', JSON.stringify(a));
fs.writeFileSync(path.join(SIMDATA, 'di.txt'), '0');
ok(await until(() => doNow() >= 0 && (doNow() & 1) === 0, 4000), 'phao mất → bơm tự tắt (hold)');

// ---------------------------------------------------------------- hẹn giờ chủ trạm
r = await owner('PUT', '/api/v1/gateway-logic/timer', { gw: 'siteA/gw01', ch: 2, timers: [{ On: '06:00', Off: '06:30', Days: [1, 2, 3, 4, 5] }] }, true);
ok(r.status === 200, 'chủ trạm cài hẹn giờ DO2 qua broker', JSON.stringify(r.j));
const back = JSON.parse((await radm('POST', '/api/v1/radmin/rpc', { site: 'siteA', device: 'gw01', method: 'GET', path: '/api/offline' })).j.body);
const d2 = back.Do.find((o) => o.Ch === 2);
ok(d2?.Timer?.[0]?.On === '06:00' && d2.Timer[0].Days?.length === 5 && d2.Block?.[0] === 1 && d2.Mode === 'off', 'board: Timer DO2 mới, liên động + khi mất mạng giữ nguyên', JSON.stringify(d2));

// dọn
await fetch(`${lan}/api/offline`, { method: 'PUT', headers: H, body: JSON.stringify({ Do: [] }) });
srv.close(); broker.close(); gwSock?.destroy();
console.log(fails ? `\n${fails} FAIL` : '\nTẤT CẢ OK');
process.exit(fails ? 1 : 0);
