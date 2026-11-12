#!/usr/bin/env node
/**
 * Smoke: admin phát mã ghép cặp → gateway gửi bản khai → admin duyệt → QR → gateway enroll + user quét thấy đúng UI.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  configure, migrateSecurity, generateClaimRootKeyPair, provisionHardwareDevice,
} from '@plciot/security';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, '..'));

const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = 'gateway-enroll-smoke-secret16';
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-pair-'));
process.env.MQTT_CONFIG_DIR = tmp;

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
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, profile TEXT NOT NULL DEFAULT 'conveyor-v1',
    api_key_hash TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, site TEXT NOT NULL, device TEXT NOT NULL,
    mqtt_user TEXT, mqtt_pass TEXT, topic_ns TEXT NOT NULL DEFAULT 'iot', profile TEXT,
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id, site, device)
  );
`);

configure({
  secret: () => process.env.APP_JWT_SECRET,
  publicUrl: () => 'https://plc.example',
});

const { enrollGateway } = await import('../src/gatewayEnroll.js');
const P = await import('../src/gatewayPairing.js');
const { migrateUserDevices, addDeviceFromQr, getDashboardFor, previewFromQr } = await import('../src/userDevices.js');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('OK', msg);
  else { console.error('FAIL', msg); failed += 1; }
}
migrateUserDevices(db);

const cfg = { gw: 'GW01', devices: [
  { id: 'bon1', name: 'Bồn nước', icon: 'tank', color: 'blue', fields: [
    { key: 'level', lbl: 'Mức nước', unit: '%', widget: 'tank', min: 0, max: 100, low: 15, high: 92 },
    { key: 'q_run', lbl: 'Bơm', widget: 'switch', writable: true, on: 'Đang chạy', off: 'Dừng' }] },
] };

// --- mã do admin phát
const made = P.createPairing(db, { adminId: 1, label: 'Trạm A' });
ok(made.ok && /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(made.code), 'tạo mã dạng XXXX-XXXX');
ok(!JSON.stringify(db.prepare('SELECT * FROM gateway_pairings').all()).includes(made.code.replace('-', '')), 'DB không lưu mã gốc (chỉ hash)');

// --- chống spam: mọi kiểu mã sai trả CÙNG một lỗi, không ghi DB
const before = db.prepare('SELECT COUNT(*) AS n FROM gateway_pairings').get().n;
const bad = [P.submitPairing(db, { code: 'ZZZZ-ZZZZ', config: cfg }), P.submitPairing(db, { code: 'abc', config: cfg }),
  P.submitPairing(db, {}), P.submitPairing(db, { code: 12345678, config: cfg })];
ok(bad.every((r) => r.error === 'invalid_pairing' && r.status === 404), 'mã sai/thiếu/định dạng xấu → cùng lỗi invalid_pairing');
ok(db.prepare('SELECT COUNT(*) AS n FROM gateway_pairings').get().n === before, 'mã sai không ghi DB');
ok(P.createPairing(db, { adminId: 7 }).ok, 'admin khác tạo được mã');
for (let i = 0; i < P.MAX_OPEN_PER_ADMIN - 1; i++) P.createPairing(db, { adminId: 1 });
ok(P.createPairing(db, { adminId: 1 }).error === 'too_many_pairings', `quá ${P.MAX_OPEN_PER_ADMIN} mã mở / admin bị chặn`);

// --- gateway gửi bản khai
const huge = { devices: [{ id: 'x', fields: Array.from({ length: 32 }, (_, i) => ({ key: `k${i}`, lbl: 'L'.repeat(60), unit: 'u' })) }] };
ok(P.submitPairing(db, { code: made.code, config: { devices: Array.from({ length: 200 }, (_, i) => ({ id: `d${i}`, fields: huge.devices[0].fields })) } }).error === 'config_too_large', 'bản khai quá lớn bị chặn trước khi phân tích');
ok(P.submitPairing(db, { code: made.code, config: { devices: [] } }).error === 'config_empty', 'bản khai rỗng bị từ chối');
const sub = P.submitPairing(db, { code: made.code.toLowerCase(), fp: 'AB12-CD34', config: cfg });
ok(sub.ok && sub.devices === 1 && sub.fp === 'AB12-CD34', 'gateway gửi bản khai bằng mã (không phân biệt hoa/thường, có/không dấu -)');
const got = P.getPairing(db, made.id);
ok(got.status === 'received' && got.config[0].icon === 'tank' && got.config[0].fields[0].low === 15, 'admin xem được bản khai: icon, ngưỡng');

// --- admin duyệt → QR
ok(P.approvePairing(db, { id: made.id, site: 'bad site!', device: 'gw01' }).error === 'invalid_site_or_device', 'site/device sai bị từ chối');
const ap = P.approvePairing(db, { id: made.id, site: 'tram_a', device: 'gw01', label: 'Trạm A' });
ok(ap.ok && ap.qr && /^gw\/[a-f0-9]{16}$/.test(ap.gateway?.topicBase || ''), 'duyệt → có QR + topic gw/<id ngẫu nhiên>');
ok(ap.gateway.pack?.[0]?.id === 'bon1' && ap.gateway.pack[0].fields.join() === 'level,q_run', 'pack của gateway = khoá MQTT trong bản khai');
ok(P.approvePairing(db, { id: made.id, site: 'tram_a', device: 'gw02' }).error === 'pairing_not_received', 'duyệt lần hai bị chặn');
ok(P.submitPairing(db, { code: made.code, config: cfg }).error === 'invalid_pairing', 'mã đã duyệt không dùng lại được');
const taken = P.createPairing(db, { adminId: 9 });
P.submitPairing(db, { code: taken.code, config: cfg });
ok(P.approvePairing(db, { id: taken.id, site: 'tram_a', device: 'gw01' }).error === 'site_device_taken', 'trùng site/device bị chặn');

// --- gateway enroll bằng cùng QR
const en = enrollGateway(db, { qr: ap.qr }, { includePassword: true });
ok(en.mqtt?.password && en.pack?.[0]?.id === 'bon1', 'gateway enroll bằng QR vừa cấp');

// --- user quét tem → thấy đúng UI gateway đã khai
db.prepare("INSERT INTO users (id, username) VALUES (50, 'nguoidung')").run();
const user = db.prepare('SELECT * FROM users WHERE id = 50').get();
const claimed = await addDeviceFromQr(db, user, { qr: ap.qr, ip: '127.0.0.1', deviceId: 'dev-test' });
ok(!claimed.error, `user quét QR → thêm thiết bị (${claimed.error || 'ok'})`);
const dash = getDashboardFor(db, db.prepare('SELECT * FROM users WHERE id = 50').get(), 'simple');
const bon = dash.devices.find((d) => d.childId === 'bon1');
ok(bon && bon.icon === 'tank' && bon.color === 'blue', 'dashboard user: icon + màu từ bản khai');
ok(bon?.widgets.find((w) => w.bind === 'level')?.kind === 'tank', 'dashboard user: bồn giữ kiểu tank');
ok(bon?.widgets.find((w) => w.bind === 'q_run')?.cmd?.key === 'q_run' && bon.widgets.find((w) => w.bind === 'q_run').onText === 'Đang chạy', 'dashboard user: điều khiển + chữ Bật/Tắt theo khoá MQTT');

// --- admin quét QR: chỉ xem thử, không thành chủ gateway, không ghi gì
db.prepare("INSERT INTO users (id, username, role, notify_site, notify_device) VALUES (60, 'quantri', 'admin', 'admin_site', 'plc01')").run();
const adminRow = () => db.prepare('SELECT * FROM users WHERE id = 60').get();
const before2 = { ud: db.prepare('SELECT COUNT(*) AS n FROM user_devices').get().n, hw: db.prepare('SELECT claimed_by FROM hardware_devices WHERE site = ? AND device = ?').get('tram_a', 'gw01') };
const rv = await addDeviceFromQr(db, adminRow(), { qr: ap.qr, ip: '127.0.0.1', deviceId: 'dev-admin' });
ok(rv.ok && rv.review === true && !rv.added, 'admin quét QR → chế độ xem thử (không "added")');
ok(rv.devices.find((d) => d.childId === 'bon1')?.widgets.find((w) => w.bind === 'level')?.kind === 'tank', 'xem thử vẽ đúng UI gateway (bồn tank)');
ok(db.prepare('SELECT COUNT(*) AS n FROM user_devices').get().n === before2.ud, 'xem thử không ghi user_devices');
ok(adminRow().notify_site === 'admin_site' && !adminRow().site_owner, 'admin không đổi site và không thành chủ gateway');
ok(db.prepare('SELECT claimed_by FROM hardware_devices WHERE site = ? AND device = ?').get('tram_a', 'gw01').claimed_by === before2.hw.claimed_by, 'tem không bị claim bởi admin');
const pv = previewFromQr(db, { qr: `https://plc.example/login.html?claim=${ap.qr}`, ip: '127.0.0.1', adminId: 60 });
ok(pv.ok && pv.review && pv.claimed === true, 'xem thử nhận cả link login.html?claim=… và báo tem đã có chủ');
ok(previewFromQr(db, { qr: 'khong-phai-qr' }).error === 'invalid_claim_payload', 'QR rác bị từ chối');

// --- mã hết hạn
const old = P.createPairing(db, { adminId: 11 });
db.prepare('UPDATE gateway_pairings SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, old.id);
ok(P.submitPairing(db, { code: old.code, config: cfg }).error === 'invalid_pairing', 'mã hết hạn → invalid_pairing');

// --- quá số lần gửi
const many = P.createPairing(db, { adminId: 12 });
let last;
for (let i = 0; i < P.MAX_SUBMITS + 1; i++) last = P.submitPairing(db, { code: many.code, config: { devices: 'x' } });
ok(last.error === 'invalid_pairing', `mã bị khoá sau ${P.MAX_SUBMITS} lần gửi`);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nsmoke-gateway-pairing: all ok');
