#!/usr/bin/env node
/**
 * Smoke: gateway TỰ LẤY LẠI QR hiện hành của tem bằng khoá riêng (QR trên máy đã cũ) — tem có khoá và tem cũ chỉ có hw;
 *        khoá khác / chữ ký sai / tem không tồn tại đều bị từ chối như nhau.
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
process.env.APP_JWT_SECRET = 'gateway-qr-smoke-secret1616';
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-qr-'));
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
const { makeGateway } = await import('./gw-identity.js');
const { migrateUserDevices } = await import('../src/userDevices.js');
migrateUserDevices(db);

let failed = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { console.error('FAIL', m); failed += 1; } };
db.prepare("INSERT INTO users (username) VALUES ('chu')").run();
const owner = db.prepare("SELECT * FROM users WHERE username='chu'").get();
const GW = makeGateway(); const EVIL = makeGateway();
const reg = P.registerForUser(db, owner, GW.registerBody(owner.id, { config: { devices: [] } }));
ok(reg.ok && reg.approved, 'đăng ký gateway (tem có khoá công khai)');
const { site, device } = reg;
const body = (g, s = site, d = device, kind = 'qr') => { const ts = Date.now(); return { site: s, device: d, pubkey: g.pubkey, ts, sig: g.sign(`${kind}|${s}|${d}|${ts}`) }; };

const r1 = refreshGatewayQr(db, body(GW));
ok(r1.ok && r1.qr === reg.qr, 'đúng khoá riêng → nhận QR hiện hành');
ok(refreshGatewayQr(db, body(EVIL)).error === 'not_allowed', 'khoá khác → từ chối');
ok(refreshGatewayQr(db, body(GW, site, device, 'config')).error === 'not_allowed', 'chữ ký sai loại → từ chối');
const old = body(GW); old.ts = Date.now() - 3600_000; old.sig = GW.sign(`qr|${site}|${device}|${old.ts}`);
ok(refreshGatewayQr(db, old).error === 'not_allowed', 'chữ ký quá hạn → từ chối');
ok(refreshGatewayQr(db, body(GW, site, 'gw99')).error === 'not_allowed', 'tem không tồn tại → cùng lỗi');
const replay = body(GW); refreshGatewayQr(db, replay);
ok(refreshGatewayQr(db, replay).error === 'not_allowed', 'phát lại cùng chữ ký → từ chối');

// Tem cũ: chưa lưu khoá, chỉ có hw (= băm khoá công khai) → khoá đúng hw mới qua, và được gắn khoá luôn
db.prepare('UPDATE hardware_devices SET gw_pubkey = NULL WHERE site = ? AND device = ?').run(site, device);
ok(refreshGatewayQr(db, body(EVIL)).error === 'not_allowed', 'tem cũ: khoá không sinh ra đúng hw → từ chối');
const r2 = refreshGatewayQr(db, body(GW));
ok(r2.ok && r2.keyBound, 'tem cũ: khoá đúng hw → nhận QR + gắn khoá công khai');
ok(db.prepare('SELECT gw_pubkey FROM hardware_devices WHERE site = ? AND device = ?').get(site, device).gw_pubkey === GW.pubkey, 'khoá đã lưu vào tem');
const cfg = enrollGateway(db, { qr: r2.qr, hw: GW.hw, ...GW.proof('config', site, device) }, { kind: 'config' });
ok(!cfg.error && cfg.site === site, 'QR mới + chữ ký → đồng bộ cấu hình được');

console.log(failed ? `\n${failed} FAIL` : '\nall ok');
process.exit(failed ? 1 : 0);
