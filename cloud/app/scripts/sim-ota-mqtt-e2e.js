#!/usr/bin/env node
/**
 * E2E (không cần VPS/board): cập nhật firmware QUA MQTT khi HTTPS của board hỏng + khởi động lại từ xa.
 *   node scripts/sim-ota-mqtt-e2e.js --fw <firmware.bin đã ký> [--sim ../../gateway-mcu/build-sim/gw-sim.exe]
 * <firmware.bin>.json (do sign-mcu-firmware.js tạo) phải nằm cạnh file — bản giả lập kiểm chữ ký bằng khoá thật trong fwkey.h.
 * Script tự chạy MỘT bản sao gw-sim (thư mục tạm), broker MQTTS tối giản, mã server thật (mcuOta.js: duyệt, fwq/fw, reboot). Kiểm:
 *   - CloudApiUrl trỏ tới cổng đóng → HTTPS lỗi → board ghi sự kiện (kèm lỗi) và chuyển sang MQTT;
 *   - chữ ký sai qua MQTT → board từ chối trước khi ghi (sec.ota_badsig), không có file mới;
 *   - đúng chữ ký → board tải từng đoạn qua MQTT, ghi ra ota-new.bin ĐÚNG từng byte, khởi động lại;
 *   - chưa được chủ trạm cho phép → board không tải;
 *   - reboot không chữ ký → bad_sig; chủ trạm khởi động lại (step-up) → ack ok + cảnh báo sec.reboot_remote + board nối lại.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import tls from 'tls';
import net from 'net';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import express from 'express';
import mqttPacket from 'mqtt-packet';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FW = arg('--fw'); const SIM = path.resolve(arg('--sim', path.join(here, '..', '..', '..', 'gateway-mcu', 'build-sim', 'gw-sim.exe')));
if (!FW || !fs.existsSync(`${FW}.json`)) { console.error('cần --fw <firmware.bin> (có <firmware.bin>.json đã ký)'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-otamq-'));
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.DATA_DIR = tmp;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // API LAN của gw-sim: chứng chỉ tự ký

const { openDb } = await import('../src/db.js');
const { setPublisher } = await import('../src/controlPublisher.js');
const { cmdPublicKey, signCmd } = await import('../src/cmdSign.js');
const M = await import('../src/mcuOta.js');

let fails = 0;
const ok = (c, l, extra = '') => { if (!c) { fails++; console.error('FAIL', l, extra); } else console.log('ok  ', l, extra ? `— ${extra}` : ''); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; }
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---------------------------------------------------------------- broker MQTTS tối giản
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=plciot-test',
  '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
const certPem = fs.readFileSync(path.join(tmp, 'c.pem'));
const PIN = crypto.createHash('sha256').update(new crypto.X509Certificate(certPem).raw).digest('hex');
const MQ = 'a1b2c3d4e5f60719';
let gwSock = null, connects = 0;
const got = { ack: [], alert: [], fwq: [], subs: new Set() };
const send = (sock, p) => sock.write(mqttPacket.generate(p));
const broker = tls.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: certPem }, (sock) => {
  const parser = mqttPacket.parser({ protocolVersion: 4 });
  sock.on('data', (d) => parser.parse(d));
  sock.on('error', () => {});
  sock.on('close', () => { if (gwSock === sock) gwSock = null; });
  parser.on('packet', (p) => {
    if (p.cmd === 'connect') { send(sock, { cmd: 'connack', returnCode: 0, sessionPresent: false }); gwSock = sock; connects++; }
    else if (p.cmd === 'subscribe') { p.subscriptions.forEach((s) => got.subs.add(s.topic)); send(sock, { cmd: 'suback', messageId: p.messageId, granted: p.subscriptions.map((s) => s.qos) }); }
    else if (p.cmd === 'pingreq') send(sock, { cmd: 'pingresp' });
    else if (p.cmd === 'publish') {
      if (p.qos === 1) send(sock, { cmd: 'puback', messageId: p.messageId });
      const m = /^gw\/([0-9a-f]{16})\/(\w+)$/.exec(p.topic);
      if (!m) return;
      const kind = m[2], buf = Buffer.from(p.payload);
      if (kind === 'fwq') { got.fwq.push(JSON.parse(buf)); M.onFwRequest(db, m[1], buf, { releasesDir: rel }); }
      else if (kind === 'ack' || kind === 'alert') got[kind].push(JSON.parse(buf));
    }
  });
});
await new Promise((r) => broker.listen(0, '127.0.0.1', r));
const BPORT = broker.address().port;
const toGw = (topic, payload) => { if (gwSock) send(gwSock, { cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false }); };
setPublisher(async (_s, _d, raw, opts) => { toGw(`gw/${opts.mqttId}/${opts.kind || 'cmd'}`, opts.kind ? raw : signCmd(opts.mqttId, raw)); return {}; });

// ---------------------------------------------------------------- server (mã thật) + bản phát hành
const db = openDb(tmp);
const { migrateUserDevices } = await import('../src/userDevices.js');
migrateUserDevices(db);
db.prepare(`INSERT INTO users (username, password_hash, folder_path, role, notify_site, notify_device) VALUES ('owner1', 'x', 'f', 'operator', 'siteA', 'gw01')`).run();
{
  const cols = db.prepare("PRAGMA table_info('devices')").all().map((c) => c.name);
  if (!cols.includes('mqtt_id')) db.exec('ALTER TABLE devices ADD COLUMN mqtt_id TEXT');
  db.prepare(`INSERT INTO devices (tenant_id, site, device, mqtt_user, mqtt_pass, created_at, updated_at, mqtt_id) VALUES ('default', 'siteA', 'gw01', 'u1', 'p', ?, ?, ?)`).run(Date.now(), Date.now(), MQ);
  db.prepare(`INSERT INTO gateway_clients (site, device, version, first_seen, last_seen) VALUES ('siteA', 'gw01', 'mcu-sim', ?, ?)`).run(Date.now(), Date.now());
}
const rel = path.join(tmp, 'releases');
const signed = JSON.parse(fs.readFileSync(`${FW}.json`, 'utf8'));
function publishRelease(sig) {
  const d = path.join(rel, 'mcu'); fs.mkdirSync(d, { recursive: true });
  const file = `firmware-${signed.Version}.bin`;
  fs.copyFileSync(FW, path.join(d, file));
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ version: signed.Version, file, sha256: signed.Sha256, sig, size: signed.Size, builtAt: signed.BuiltAt, notes: 'e2e' }));
}
const app = express();
app.use(express.json());
const requireAuth = (req, res, next) => { const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.get('x-test-user') || ''); if (!u) return res.status(401).end(); req.user = u; next(); };
const security = { authorize: (req) => (req.get('x-stepup') === '1' ? {} : { error: 'step_up_required', status: 401 }) };
M.mountMcuOta(app, { db, requireAuth, security, releasesDir: rel });
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const owner = (method, p, b, step) => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': 'owner1', ...(step ? { 'x-stepup': '1' } : {}) }, body: b ? JSON.stringify(b) : undefined })
  .then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

// ---------------------------------------------------------------- gw-sim (bản sao riêng → dọn được mà không đụng gw-sim khác)
const simDir = path.join(tmp, 'sim'); const simData = path.join(tmp, 'simdata'); fs.mkdirSync(simDir); fs.mkdirSync(simData);
const simExe = path.join(simDir, 'gw-sim-otamq.exe'); fs.copyFileSync(SIM, simExe);
const API = await freePort();
const simEnv = { ...process.env, SIM_API_PORT: String(API), SIM_HTTP_PORT: String(await freePort()), SIM_MBS_PORT: String(await freePort()), SIM_DATA: simData, SIM_WINDOW_SEC: '600' };
const simLog = fs.openSync(path.join(tmp, 'sim.log'), 'a');
spawn(simExe, [], { cwd: simDir, env: simEnv, stdio: ['ignore', simLog, simLog], detached: true }).unref();
const killSim = () => { try { execFileSync('taskkill', ['/F', '/IM', 'gw-sim-otamq.exe'], { stdio: 'ignore' }); } catch { /* đã thoát */ } };
process.on('exit', killSim);
const lan = `https://127.0.0.1:${API}`;
ok(await until(() => fetch(`${lan}/api/challenge`).then((r) => r.ok).catch(() => false), 20000), 'gw-sim khởi động (API LAN)');

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
  CloudPinSha256: PIN, CloudCmdKey: cmdPublicKey(), CloudSendData: true,
  CloudApiUrl: `https://127.0.0.1:${await freePort()}`,   // cổng ĐÓNG: mọi HTTPS tới "server" lỗi như board ở nhà
};
const put = await (await fetch(`${lan}/api/config`, { method: 'PUT', headers: H, body: JSON.stringify(cfg) })).json();
ok(put.Ok, 'đẩy cấu hình cloud vào gw-sim (HTTPS tới server cố ý hỏng)', put.Err || '');
ok(await until(() => gwSock, 30000), 'gw-sim nối broker MQTTS');
ok(await until(() => got.subs.has(`gw/${MQ}/fw`), 5000), 'board đăng ký nhận gw/<id>/fw');
const newBin = path.join(simData, 'ota-new.bin');
// nhật ký gw-sim (stdout): sự kiện "SỰ KIỆN [loại] …" — đọc được cả sau khi board khởi động lại (token LAN cũ hết hiệu lực)
const simEv = (k, re) => fs.readFileSync(path.join(tmp, 'sim.log'), 'utf8').split('\n').find((l) => l.includes(`SỰ KIỆN [${k}]`) && re.test(l));

// ---------------------------------------------------------------- 0. chưa được cho phép → không tải
publishRelease(signed.Sig);
await sleep(3000);
ok(!got.fwq.some((q) => q.q !== 'time') && !fs.existsSync(newBin), 'chưa được chủ trạm cho phép → board không hỏi firmware');
ok(got.fwq.some((q) => q.q === 'time' && /^[0-9a-f]{24}$/.test(q.n)), 'board hỏi giờ server qua MQTT (nonce), không dùng NTP bên thứ ba');

// ---------------------------------------------------------------- 1. chữ ký sai qua MQTT → từ chối trước khi ghi
const badSig = Buffer.from(signed.Sig, 'base64url'); badSig[5] ^= 0xff;
publishRelease(badSig.toString('base64url'));
let r = await owner('POST', '/api/v1/ota/approve', { gw: 'siteA/gw01' }, true);
ok(r.status === 200, 'chủ trạm cho phép cập nhật (step-up)', JSON.stringify(r.j));
const evInfo = await until(() => simEv('ota_info', /qua HTTPS \(HTTP -1 .*chuyển sang tải qua MQTT/), 60000);
ok(evInfo, 'HTTPS lỗi → board ghi sự kiện (kèm lỗi) và chuyển sang MQTT', evInfo?.slice(evInfo.indexOf('Đã duyệt')));
ok(await until(() => got.fwq.find((q) => q.q === 'info'), 10000), 'board hỏi thông tin firmware qua gw/<id>/fwq');
ok(await until(() => got.alert.find((a) => a.k === 'sec.ota_badsig'), 10000), 'chữ ký sai (qua MQTT) → board từ chối, cảnh báo sec.ota_badsig');
ok(!got.fwq.some((q) => q.q === 'get') && !fs.existsSync(newBin), 'chữ ký sai → không tải đoạn nào, không ghi file');

// ---------------------------------------------------------------- 2. đúng chữ ký → tải đủ qua MQTT, đúng từng byte, khởi động lại
publishRelease(signed.Sig);
got.fwq.length = 0;
const c0 = connects;
r = await owner('POST', '/api/v1/ota/approve', { gw: 'siteA/gw01' }, true);
const t0 = Date.now();
ok(await until(() => fs.existsSync(newBin) && fs.statSync(newBin).size === signed.Size, 240000), 'board tải đủ firmware qua MQTT',
  `${got.fwq.filter((q) => q.q === 'get').length} đoạn, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
ok(fs.existsSync(newBin) && crypto.createHash('sha256').update(fs.readFileSync(newBin)).digest('hex') === signed.Sha256, 'file nhận được ĐÚNG SHA-256 của bản đã ký');
const offs = got.fwq.filter((q) => q.q === 'get').map((q) => q.off);
ok(offs.length > 1 && offs.every((o, i) => i === 0 || o >= offs[i - 1]), 'board hỏi tuần tự từng đoạn (hỏi lại đoạn cũ khi mất gói)');
ok(await until(() => connects > c0 && gwSock, 30000), 'cài xong → board khởi động lại và nối lại cloud');
ok(simEv('ota_install', /nguồn server qua MQTT/), 'nhật ký board: ota_install nguồn "server qua MQTT"');
const h = await owner('GET', '/api/v1/system-history?gw=siteA/gw01');
ok(h.j.events?.some((e) => e.type === 'ota_mqtt' && /đã nhận đủ/.test(e.text)), 'lịch sử hệ thống: server đã gửi đủ firmware qua MQTT');

// ---------------------------------------------------------------- 3. khởi động lại từ xa
await until(() => fetch(`${lan}/api/challenge`).then((x) => x.ok).catch(() => false), 20000);
const nAck = got.ack.length;
toGw(`gw/${MQ}/cmd`, JSON.stringify({ schema: 1, sys: 'reboot', id: 'rb-unsigned', ts: Date.now() }));
ok(await until(() => got.ack.slice(nAck).find((a) => a.id === 'rb-unsigned' && a.ok === false && a.err === 'bad_sig'), 6000), 'reboot KHÔNG chữ ký → bad_sig, không khởi động lại');
const c1 = connects;
r = await owner('POST', '/api/v1/gateway/reboot', { gw: 'siteA/gw01' });
ok(r.j.error === 'step_up_required', 'khởi động lại chưa Face ID/TOTP → step_up_required');
r = await owner('POST', '/api/v1/gateway/reboot', { gw: 'siteA/gw01' }, true);
ok(r.status === 200 && await until(() => got.ack.find((a) => /^rb-/.test(a.id || '') && a.id !== 'rb-unsigned' && a.ok), 6000), 'chủ trạm khởi động lại → board ack ok');
ok(await until(() => got.alert.find((a) => a.k === 'sec.reboot_remote' && /owner1/.test(a.txt)), 8000), 'cảnh báo đỏ sec.reboot_remote ghi người bấm');
ok(await until(() => connects > c1 && gwSock, 30000), 'board khởi động lại và nối lại cloud');

srv.close(); broker.close(); gwSock?.destroy(); killSim();
console.log(fails ? `\n${fails} FAIL` : '\nTẤT CẢ OK');
process.exit(fails ? 1 : 0);
