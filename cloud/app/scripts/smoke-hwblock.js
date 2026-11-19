#!/usr/bin/env node
/**
 * Smoke: khoá thiết bị MẤT TRỘM theo mã phần cứng (hwBlock.js) — admin khoá hw → gateway hỏi cấu hình / enroll / lấy QR bị từ chối
 * (device_blocked), tín hiệu ký { sys:'lock' } gửi tới gateway; mở khoá → { sys:'unlock' }, gateway hoạt động lại. Mã sai định dạng bị từ chối.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { configure, migrateSecurity, generateClaimRootKeyPair } from '@plciot/security';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, '..'));
const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = 'hw-block-smoke-secret-161616';
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-hwblock-'));
process.env.MQTT_CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;

const db = new Database(path.join(tmp, 't.db'));
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT NOT NULL DEFAULT 'x',
    folder_path TEXT NOT NULL DEFAULT 'f', disabled INTEGER DEFAULT 0, setup_complete INTEGER DEFAULT 1,
    notify_site TEXT DEFAULT 'f', notify_device TEXT DEFAULT 'plc01', mqtt_user TEXT, mqtt_pass TEXT,
    role TEXT DEFAULT 'operator', tenant_id TEXT DEFAULT 'default', monitor_scopes TEXT, site_owner INTEGER DEFAULT 0
  );
`);
migrateSecurity(db);
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile TEXT NOT NULL DEFAULT 'conveyor-v1', api_key_hash TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, site TEXT NOT NULL, device TEXT NOT NULL,
    mqtt_user TEXT, mqtt_pass TEXT, topic_ns TEXT NOT NULL DEFAULT 'iot', profile TEXT,
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tenant_id, site, device)
  );
`);
configure({ secret: () => process.env.APP_JWT_SECRET, publicUrl: () => 'https://plc.example' });

const { refreshGatewayQr, enrollGateway } = await import('../src/gatewayEnroll.js');
const P = await import('../src/gatewayPairing.js');
const H = await import('../src/hwBlock.js');
const { setPublisher } = await import('../src/controlPublisher.js');
const { makeGateway } = await import('./gw-identity.js');
const { migrateUserDevices } = await import('../src/userDevices.js');
const { ensureMqttIdColumn } = await import('../src/mqttIds.js');
migrateUserDevices(db);
H.initHwBlockTable(db);

const sent = [];
setPublisher(async (site, device, payload) => { sent.push({ site, device, payload }); });

let failed = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { console.error('FAIL', m); failed += 1; } };
db.prepare("INSERT INTO users (username) VALUES ('chu')").run();
const owner = db.prepare("SELECT * FROM users WHERE username='chu'").get();
const GW = makeGateway(), OTHER = makeGateway();
const reg = P.registerForUser(db, owner, GW.registerBody(owner.id, { config: { devices: [] } }));
ok(reg.ok && reg.approved, 'đăng ký gateway (tem có khoá công khai)');
const { site, device } = reg;
try { ensureMqttIdColumn(db); } catch { /* đã có */ }
if (!db.prepare('SELECT mqtt_id FROM devices WHERE site = ? AND device = ?').get(site, device)?.mqtt_id)
  db.prepare("UPDATE devices SET mqtt_id = '0123456789abcdef' WHERE site = ? AND device = ?").run(site, device);
const cfg = () => enrollGateway(db, { qr: reg.qr, ...GW.proof('config', site, device) }, { kind: 'config', includePassword: false });
const qrBody = () => { const ts = Date.now(); return { site, device, pubkey: GW.pubkey, ts, sig: GW.sign(`qr|${site}|${device}|${ts}`) }; };

ok(!cfg().error, 'trước khi khoá: gateway hỏi cấu hình bình thường');
ok(H.devicesOfHw(db, GW.hw).some((d) => d.site === site && d.device === device), 'tìm được tem theo mã phần cứng (khoá công khai đã lưu)');
ok(H.blockHw(db, { hw: 'NOT-A-HW', reason: 'x' }).error === 'bad_hw', 'mã phần cứng sai định dạng → từ chối');

const b = H.blockHw(db, { hw: GW.hw.toLowerCase().replace(/(.{5})/g, '$1-'), reason: 'khách báo mất 19/11', adminId: 1 });
ok(b.ok && b.hw === GW.hw, 'khoá theo mã phần cứng (chấp nhận chữ thường / gạch nối)');
await new Promise((r) => setTimeout(r, 20));
ok(sent.some((s) => s.site === site && s.payload.sys === 'lock'), 'gửi tín hiệu { sys:"lock" } tới gateway đang nối');
ok(H.isHwBlocked(db, H.hwOfPubkey(GW.pubkey)) && !H.isHwBlocked(db, OTHER.hw), 'isHwBlocked đúng máy, không dính máy khác');
ok(cfg().error === 'device_blocked', 'đã khoá: hỏi cấu hình → device_blocked (board tự vào chế độ khoá)');
ok(refreshGatewayQr(db, qrBody()).error === 'device_blocked', 'đã khoá: lấy lại QR → device_blocked');
ok(H.listHwBlocks(db).some((x) => x.hw === GW.hw && x.reason.includes('mất') && x.devices.length === 1), 'danh sách khoá có lý do + tem gắn kèm');

const u = H.unblockHw(db, GW.hw);
await new Promise((r) => setTimeout(r, 20));
ok(u.ok && sent.some((s) => s.site === site && s.payload.sys === 'unlock'), 'mở khoá → gửi { sys:"unlock" }');
ok(!cfg().error, 'mở khoá: gateway hỏi cấu hình bình thường lại');
ok(H.unblockHw(db, GW.hw).error === 'not_found', 'mở khoá máy không bị khoá → not_found');

console.log(failed ? `\n${failed} kiểm tra hỏng` : '\nTất cả đạt');
process.exit(failed ? 1 : 0);
