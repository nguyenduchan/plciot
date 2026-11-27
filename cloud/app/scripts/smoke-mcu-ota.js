#!/usr/bin/env node
/** Smoke test: cập nhật firmware board có duyệt (mcuOta.js) — bản phát hành đã ký, tải về, chủ duyệt (step-up), lệnh ota_allow có chữ ký,
 *  lịch sử hệ thống (audit + cảnh báo bảo mật của board), cảnh báo bảo mật có tiêu đề riêng. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-ota-'));
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.DATA_DIR = tmp;

const { openDb } = await import('../src/db.js');
const { migrateUserDevices } = await import('../src/userDevices.js');
const { setPublisher } = await import('../src/controlPublisher.js');
const { verifySignedCmd } = await import('../src/cmdSign.js');
const { mountMcuOta, readMcuRelease } = await import('../src/mcuOta.js');
const { insertEvent } = await import('../src/historyStore.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

const db = openDb(tmp); migrateUserDevices(db);
const MQ = 'b1b2c3d4e5f60718';
const cols = db.prepare("PRAGMA table_info('devices')").all().map((c) => c.name);
if (!cols.includes('mqtt_id')) db.exec('ALTER TABLE devices ADD COLUMN mqtt_id TEXT');
for (const [site, dev, id] of [['siteA', 'gw01', MQ], ['siteA', 'pc01', 'c1c2c3d4e5f60718']]) {
  db.prepare(`INSERT INTO devices (tenant_id, site, device, mqtt_user, mqtt_pass, created_at, updated_at, mqtt_id) VALUES ('default', ?, ?, 'u', 'p', ?, ?, ?)`).run(site, dev, Date.now(), Date.now(), id);
}
db.prepare(`INSERT INTO users (username, password_hash, folder_path, role, notify_site, notify_device) VALUES ('owner1', 'x', 'f', 'operator', 'siteA', 'gw01')`).run();
db.prepare(`INSERT INTO users (username, password_hash, folder_path, role, notify_site, notify_device) VALUES ('other1', 'x', 'f', 'operator', 'siteB', 'gw09')`).run();
const uid = db.prepare("SELECT id FROM users WHERE username='owner1'").get().id;
db.prepare(`INSERT INTO user_devices (id, user_id, site, gateway_device, child_id, type, title, binds, created_at) VALUES ('x1', ?, 'siteA', 'pc01', 'c1', 't', 't', '[]', ?)`).run(uid, Date.now());
db.prepare("INSERT INTO gateway_clients (site, device, version, first_seen, last_seen) VALUES ('siteA','gw01','mcu-0.3.6',?,?), ('siteA','pc01','abc123',?,?)").run(Date.now(), Date.now(), Date.now(), Date.now());

// bản phát hành ký bằng khoá tạm (đúng công cụ thật)
const rel = path.join(tmp, 'releases');
const keyFile = path.join(tmp, 'k.pem'); const bin = path.join(tmp, 'firmware.bin');
fs.writeFileSync(bin, crypto.randomBytes(70_000));
const env = { ...process.env, FW_SIGN_KEY: keyFile };
const pub = execFileSync(process.execPath, [path.join(here, 'sign-mcu-firmware.js'), '--genkey'], { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

const published = [];
setPublisher(async (_s, _d, payload, opts) => { published.push({ payload, opts }); });

let stepUp = false;   // authorize giả: có yếu tố thứ hai hay chưa
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use((req, _res, next) => { const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.get('x-test-user') || ''); if (u) req.user = u; next(); });
const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'unauthorized' }));
mountMcuOta(app, { db, requireAuth, security: { authorize: () => (stepUp ? {} : { error: 'step_up_required', status: 401 }) }, releasesDir: rel });
const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
const call = (user, method, p, b) => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': user || '' }, body: b ? JSON.stringify(b) : undefined })
  .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null), r }));

ok((await call('', 'GET', '/api/v1/mcu-firmware')).status === 404, 'chưa có bản phát hành → 404');
execFileSync(process.execPath, [path.join(here, 'sign-mcu-firmware.js'), 'sign', bin, 'mcu-0.4.0', '--notes', 'Sửa lỗi X', '--out', path.join(rel, 'mcu')], { env, stdio: 'ignore' });
const meta = await call('', 'GET', '/api/v1/mcu-firmware');
ok(meta.status === 200 && meta.j.version === 'mcu-0.4.0' && meta.j.size === 70_000 && meta.j.notes === 'Sửa lỗi X', 'thông tin bản mới (công khai)');
const sha = crypto.createHash('sha256').update(fs.readFileSync(bin)).digest('hex');
const key = crypto.createPublicKey({ key: Buffer.from(pub, 'base64url'), format: 'der', type: 'spki' });
ok(meta.j.sha256 === sha && crypto.verify('sha256', Buffer.from(`fw1|${sha}|mcu-0.4.0`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(meta.j.sig, 'base64url')), 'chữ ký fw1|sha256|phiên bản kiểm được bằng khoá công khai (như board)');
ok(!crypto.verify('sha256', Buffer.from(`fw1|${sha}|mcu-9.9.9`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(meta.j.sig, 'base64url')), 'đổi phiên bản → chữ ký không còn hợp lệ');
const dl = await fetch(`${base}/api/v1/mcu-firmware/download`);
ok(dl.status === 200 && Buffer.from(await dl.arrayBuffer()).equals(fs.readFileSync(bin)), 'tải firmware đúng từng byte');
ok(fs.existsSync(`${bin}.json`) && JSON.parse(fs.readFileSync(`${bin}.json`, 'utf8')).Sig === meta.j.sig, 'firmware.bin.json cho GatewayApp nạp qua LAN');

ok((await call('', 'POST', '/api/v1/ota/approve', { gw: 'siteA/gw01' })).status === 401, 'duyệt không đăng nhập → 401');
ok((await call('other1', 'POST', '/api/v1/ota/approve', { gw: 'siteA/gw01' })).j.error === 'forbidden_gateway', 'người khác duyệt → forbidden_gateway');
ok((await call('owner1', 'POST', '/api/v1/ota/approve', { gw: 'siteA/pc01' })).j.error === 'not_mcu', 'gateway PC → not_mcu');
const noStep = await call('owner1', 'POST', '/api/v1/ota/approve', { gw: 'siteA/gw01' });
ok(noStep.status === 401 && noStep.j.error === 'step_up_required' && published.length === 0, 'chưa Face ID/TOTP → step_up_required, chưa gửi gì xuống board');
stepUp = true;
const ap = await call('owner1', 'POST', '/api/v1/ota/approve', { gw: 'siteA/gw01' });
await new Promise((r) => setTimeout(r, 50));
ok(ap.status === 200 && ap.j.version === 'mcu-0.4.0', 'chủ trạm duyệt (đã xác thực) → ok');
const p = published.at(-1);
ok(p && p.opts.mqttId === MQ && p.payload.sys === 'ota_allow' && p.payload.ttl === 900 && p.payload.by === 'owner1', 'server gửi {sys:"ota_allow", ttl:900, by} tới đúng gateway');

insertEvent(db, { ts: Date.now(), site: 'siteA', device: 'gw01', kind: 'alert', payload: JSON.stringify({ schema: 1, k: 'sec.ota_badsig', lv: 'high', txt: 'Từ chối firmware: CHỮ KÝ KHÔNG HỢP LỆ' }), o: null, i: null, a: null, c: null, s: null });
insertEvent(db, { ts: Date.now(), site: 'siteA', device: 'gw01', kind: 'alert', payload: JSON.stringify({ schema: 1, k: 'tank.level', lv: 'high', txt: 'Mức nước cao' }), o: null, i: null, a: null, c: null, s: null });
const h = await call('owner1', 'GET', '/api/v1/system-history?gw=siteA/gw01');
ok(h.status === 200 && h.j.kind === 'mcu' && h.j.version === 'mcu-0.3.6' && h.j.updateAvailable && h.j.release.version === 'mcu-0.4.0', 'lịch sử: phiên bản đang chạy + có bản mới');
ok(h.j.events.some((e) => e.type === 'ota_approve' && e.text.includes('mcu-0.4.0')), 'lịch sử có lần duyệt cập nhật (server)');
ok(h.j.events.some((e) => e.src === 'gateway' && e.type === 'ota_badsig' && e.alert) && !h.j.events.some((e) => e.text === 'Mức nước cao'), 'lịch sử có cảnh báo bảo mật của board, không lẫn cảnh báo dữ liệu');
ok((await call('other1', 'GET', '/api/v1/system-history?gw=siteA/gw01')).j.error === 'forbidden_gateway', 'người khác không xem được lịch sử');

// Board là SLAVE của gateway PC: gateway PC hỏi thay (id board + nonce board cấp) → server ký ota_allow kèm nonce
{
  const N = 'a1'.repeat(12);
  ok((await call('', 'POST', '/api/v1/mcu-firmware/allow', { id: 'xyz', nonce: N })).status === 400, 'chuyển tiếp: id sai → 400');
  ok((await call('', 'POST', '/api/v1/mcu-firmware/allow', { id: '0000000000000000', nonce: N })).j.error === 'unknown_gateway', 'chuyển tiếp: board lạ → unknown_gateway');
  const na = await call('', 'POST', '/api/v1/mcu-firmware/allow', { id: 'c1c2c3d4e5f60718', nonce: N, version: 'mcu-0.3.6' });
  ok(na.status === 404 && na.j.error === 'not_approved' && na.j.release?.version === 'mcu-0.4.0', 'chuyển tiếp: chủ trạm chưa cho phép → not_approved (kèm bản mới)');
  const r = await call('', 'POST', '/api/v1/mcu-firmware/allow', { id: MQ, nonce: N, version: 'mcu-0.3.7' });
  ok(r.status === 200 && r.j.ttl > 800 && r.j.release?.sha256 === sha, 'chuyển tiếp: đã cho phép → gói + thời gian còn lại + bản mới');
  ok(verifySignedCmd(MQ, r.j.packet), 'gói ký bằng khoá lệnh server, gắn mqttId board (board kiểm như lệnh MQTT)');
  ok(!verifySignedCmd('c1c2c3d4e5f60718', r.j.packet), 'gói không dùng được cho board khác');
  const pj = JSON.parse(r.j.packet.slice(0, r.j.packet.lastIndexOf(',"sig":"')) + '}');
  ok(pj.sys === 'ota_allow' && pj.nonce === N && pj.by === 'owner1', 'gói có nonce của board + người duyệt');
  ok(db.prepare("SELECT version FROM gateway_clients WHERE site='siteA' AND device='gw01'").get().version === 'mcu-0.3.7', 'phiên bản board (báo qua gateway PC) được ghi để webapp hiện bản mới');
  db.prepare("UPDATE audit_log SET ts = ts - 16 * 60000 WHERE event = 'ota_approve'").run();
  ok((await call('', 'POST', '/api/v1/mcu-firmware/allow', { id: MQ, nonce: N })).j.error === 'not_approved', 'quá 15 phút → hết quyền');
  const h2 = await call('owner1', 'GET', '/api/v1/system-history?gw=siteA/gw01');
  ok(h2.j.events.some((e) => e.type === 'ota_relay'), 'lịch sử ghi lần chuyển lệnh qua gateway PC');
}

// Firmware QUA MQTT (HTTPS của board hỏng, MQTT vẫn nối): board hỏi fwq → server trả fw từng đoạn; ghép lại phải đúng từng byte
{
  const { onFwRequest, FW_CHUNK_MAX } = await import('../src/mcuOta.js');
  const sent = [];
  const pub = async (id, kind, raw) => { sent.push({ id, kind, raw, m: JSON.parse(raw) }); };
  const ask = async (q, id = MQ) => { sent.length = 0; await onFwRequest(db, id, Buffer.from(JSON.stringify(q)), { publish: pub, releasesDir: rel }); return sent[0]; };
  const info = await ask({ q: 'info', ch: '' });
  ok(info?.id === MQ && info.kind === 'fw' && info.m.t === 'info' && info.m.version === 'mcu-0.4.0' && info.m.sha256 === sha && info.m.sig === meta.j.sig && info.m.size === 70_000, 'MQTT: thông tin bản mới (gw/<id>/fw) giống HTTPS');
  const parts = []; let off = 0, rounds = 0;
  while (off < info.m.size && rounds++ < 50) {
    const d = await ask({ q: 'get', ch: '', ver: 'mcu-0.4.0', off, n: 99_999 });
    if (d?.m.t !== 'data' || d.m.off !== off) break;
    const b = Buffer.from(d.m.z, 'base64'); parts.push(b); off += b.length;
    ok(b.length <= FW_CHUNK_MAX && JSON.stringify(d.m).length < 16_000 || rounds > 1, 'MQTT: mỗi gói ≤ 8 KB dữ liệu, < 16 KB bản tin (giới hạn broker)');
  }
  ok(Buffer.concat(parts).equals(fs.readFileSync(bin)), `MQTT: ghép ${parts.length} đoạn = đúng từng byte firmware`);
  ok((await ask({ q: 'get', ch: '', ver: 'mcu-0.3.9', off: 0 })).m.e === 'version_changed', 'MQTT: hỏi đoạn của phiên bản khác → version_changed (board bỏ, hỏi lại từ đầu)');
  ok((await ask({ q: 'get', ch: '', ver: 'mcu-0.4.0', off: 70_000 })).m.e === 'bad_offset' && (await ask({ q: 'get', ch: '', ver: 'mcu-0.4.0', off: -5 })).m.e === 'bad_offset', 'MQTT: offset ngoài file → bad_offset');
  ok((await ask({ q: 'info', ch: 'dev' })).m.e === 'no_release', 'MQTT: kênh dev chưa có bản → no_release');
  ok((await ask({ q: 'info' }, '0123456789abcdef')) === undefined, 'MQTT: board lạ (không có trong devices) → im lặng');
  {
    const N = 'ab'.repeat(12);
    const t = await ask({ q: 'time', n: N });
    ok(t?.kind === 'fw' && t.m.sys === 'time' && t.m.n === N && Math.abs(t.m.ms - Date.now()) < 5000, 'giờ: server trả {sys:"time", ms, n} trên gw/<id>/fw (không cần NTP/DNS)');
    ok(verifySignedCmd(MQ, t.raw) && !verifySignedCmd('c1c2c3d4e5f60718', t.raw), 'giờ: ký bằng khoá lệnh server, gắn đúng board');
    ok(verifySignedCmd(MQ, t.raw.replace(/"ms":\d+/, '"ms":1')) === false, 'giờ: sửa giờ → sai chữ ký');
    ok((await ask({ q: 'time', n: 'xyz' })) === undefined, 'giờ: nonce sai dạng → im lặng');
  }
  let silent = 0; for (let i = 0; i < 120; i++) if (!(await ask({ q: 'info' }))) silent++;
  ok(silent > 0, 'MQTT: quá 100 yêu cầu / 10 s / board → bỏ (chống spam)');
  const h3 = await call('owner1', 'GET', '/api/v1/system-history?gw=siteA/gw01');
  ok(h3.j.events.some((e) => e.type === 'ota_mqtt' && e.text.includes('đã nhận đủ')), 'lịch sử: tải firmware qua MQTT');
  const { deviceAclBlock } = await import('../src/mqttProvision.js');
  const acl = deviceAclBlock('d1', { mqttId: MQ });
  ok(acl.includes(`topic write gw/${MQ}/fwq`) && acl.includes(`topic read gw/${MQ}/fw`) && !acl.includes(`topic write gw/${MQ}/fw\n`), 'ACL: board ghi fwq, chỉ ĐỌC fw (không tự đóng vai server)');
}

// Chủ trạm khởi động lại board từ xa
{
  published.length = 0; stepUp = false;
  ok((await call('other1', 'POST', '/api/v1/gateway/reboot', { gw: 'siteA/gw01' })).j.error === 'forbidden_gateway', 'khởi động lại: người khác → forbidden_gateway');
  db.prepare("UPDATE gateway_clients SET version = 'abc123' WHERE site = 'siteA' AND device = 'pc01'").run();   // bước chuyển tiếp ở trên đã ghi pc01 thành mcu-…
  ok((await call('owner1', 'POST', '/api/v1/gateway/reboot', { gw: 'siteA/pc01' })).j?.error === 'not_mcu', 'khởi động lại: gateway PC → not_mcu');
  const ns = await call('owner1', 'POST', '/api/v1/gateway/reboot', { gw: 'siteA/gw01' });
  ok(ns.j?.error === 'step_up_required' && published.length === 0, 'khởi động lại: chưa Face ID/TOTP → step_up_required, chưa gửi gì');
  stepUp = true;
  const rb = await call('owner1', 'POST', '/api/v1/gateway/reboot', { gw: 'siteA/gw01' });
  await new Promise((r) => setTimeout(r, 50));
  const q = published.at(-1);
  ok(rb.status === 200 && q?.opts.mqttId === MQ && q.payload.sys === 'reboot' && q.payload.by === 'owner1' && /^rb-[0-9a-f]{12}$/.test(q.payload.id), 'khởi động lại: gửi {sys:"reboot", by, id} (id chống phát lại) tới đúng board');
  const h4 = await call('owner1', 'GET', '/api/v1/system-history?gw=siteA/gw01');
  ok(h4.j.events.some((e) => e.type === 'gateway_reboot'), 'lịch sử: khởi động lại từ xa');
}

const { forwardGatewayAlert } = await import('../src/pushAlerts.js');
ok(typeof forwardGatewayAlert === 'function', 'cảnh báo sec.* đi qua forwardGatewayAlert (tiêu đề "Cảnh báo bảo mật")');
ok(readMcuRelease(path.join(tmp, 'khong-co')) === null, 'thư mục phát hành hỏng/thiếu → không phát gì');

srv.close();
console.log(fails ? `\n${fails} FAIL` : '\nTẤT CẢ OK');
process.exit(fails ? 1 : 0);
