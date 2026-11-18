#!/usr/bin/env node
/**
 * Smoke: ƯU TIÊN NGƯỜI CẦM THIẾT BỊ — mất điện thoại/tài khoản: tài khoản mới đăng nhập trên gateway (đúng khoá riêng) được nhận gateway
 *        NGAY, không chờ chủ cũ; chủ cũ mất quyền; người không giữ khoá riêng của gateway thì không được.
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
process.env.APP_JWT_SECRET = 'gateway-transfer-smoke-secret16';
delete process.env.TRANSFER_WAIT_HOURS;   // mặc định: không chờ
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-transfer-'));
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

process.env.REAUTH_DISABLED = 'true';
const P = await import('../src/gatewayPairing.js');
const T = await import('../src/gatewayTransfer.js');
const { makeGateway } = await import('./gw-identity.js');
const { migrateUserDevices } = await import('../src/userDevices.js');
const { initPushTables } = await import('../src/webPush.js');
migrateUserDevices(db); initPushTables(db); T.migrateGatewayTransfers(db);

let failed = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { console.error('FAIL', m); failed += 1; } };
for (const u of ['a', 'b', 'c']) db.prepare('INSERT INTO users (username) VALUES (?)').run(u);
const U = (n) => db.prepare('SELECT * FROM users WHERE username = ?').get(n);
const A = U('a'); const B = U('b'); const C = U('c');
const GW = makeGateway(); const OTHER = makeGateway();
let fresh; try { fresh = P.findForeignPairing(db, A, GW.registerBody(A.id, {})); } catch (e) { fresh = e; }
ok(fresh === null, 'DB mới (chưa đăng ký lần nào): tra cứu đổi chủ không lỗi (cột user_id có sẵn)');
const reg = P.registerForUser(db, A, GW.registerBody(A.id, { config: { devices: [] } }));
ok(reg.ok && reg.approved, 'A đăng ký gateway');
const ownerOf = () => db.prepare("SELECT user_id FROM gateway_pairings WHERE site = ? AND device = ? AND status = 'approved'").get(reg.site, reg.device)?.user_id;

// Không giữ khoá riêng → không xin được (chữ ký của máy khác với khoá công khai của gateway)
const forged = { ...OTHER.registerBody(B.id, {}), pubkey: GW.pubkey };
const prev = P.findForeignPairing(db, B, forged);
ok(prev && prev.user_id === A.id, 'B tra được gateway đang thuộc A');
ok(P.checkTransferRequest(db, B, forged).error === 'invalid_proof', 'không giữ khoá riêng → invalid_proof');

// Người cầm gateway (giữ khoá riêng) tạo tài khoản mới B → chuyển NGAY, không chờ chủ cũ
ok(P.checkTransferRequest(db, B, GW.registerBody(B.id, {})).ok, 'B giữ khoá riêng → được xin');
const t1 = await T.requestTransfer(db, B, prev, {});
ok(t1.status === 'transfer_done' && ownerOf() === B.id, 'không chờ: gateway chuyển ngay sang B');
const left = db.prepare("SELECT COUNT(*) n FROM gateway_transfers WHERE status = 'pending'").get().n;
ok(left === 0, 'không còn yêu cầu chờ');
ok(!db.prepare("SELECT 1 FROM user_devices WHERE user_id = ? AND site = ? AND gateway_device = ?").get(A.id, reg.site, reg.device), 'chủ cũ không còn ô thiết bị của gateway này');
ok(db.prepare("SELECT 1 FROM hardware_devices WHERE site = ? AND device = ?").get(reg.site, reg.device), 'gateway (dữ liệu gắn thiết bị) vẫn còn nguyên, không bị xoá theo tài khoản cũ');

// Người thứ ba (C) không có khoá riêng thì vẫn không chen được
const prev2 = P.findForeignPairing(db, C, forged);
ok(P.checkTransferRequest(db, C, forged).error === 'invalid_proof', 'C không giữ khoá riêng → từ chối');

console.log(failed ? `${failed} FAIL` : 'all ok');
process.exit(failed ? 1 : 0);
