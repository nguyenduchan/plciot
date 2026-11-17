#!/usr/bin/env node
/**
 * Smoke: (1) lệnh cloud được ký ES256, gateway kiểm được bằng khoá công khai trong kit, giả mạo/sai mqttId bị từ chối;
 *        (2) chuyển gateway sang PC mới: chỉ chủ mới chuyển được, giữ nguyên tem/id MQTT, PC cũ bị cắt.
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
process.env.APP_JWT_SECRET = 'gateway-rebind-smoke-secret16';
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-rebind-'));
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

const { enrollGateway } = await import('../src/gatewayEnroll.js');
const P = await import('../src/gatewayPairing.js');
const { signCmd, verifySignedCmd, cmdPublicKey } = await import('../src/cmdSign.js');
const { makeGateway } = await import('./gw-identity.js');
const { migrateUserDevices } = await import('../src/userDevices.js');
migrateUserDevices(db);

let failed = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { console.error('FAIL', m); failed += 1; } };

// ---- 1. ký lệnh
const pub = cmdPublicKey();
const raw = signCmd('aaaaaaaaaaaaaaaa', { schema: 1, id: 'x1', a: 4, v: 5, ts: 123 });
ok(JSON.parse(raw).sig && verifySignedCmd('aaaaaaaaaaaaaaaa', raw, pub), 'lệnh ký xong kiểm lại đúng');
ok(!verifySignedCmd('bbbbbbbbbbbbbbbb', raw, pub), 'cùng lệnh nhưng mqttId khác → sai chữ ký (không phát lại sang gateway khác)');
ok(!verifySignedCmd('aaaaaaaaaaaaaaaa', raw.replace('"v":5', '"v":9'), pub), 'sửa giá trị → sai chữ ký');
ok(fs.existsSync(path.join(tmp, 'cmd-sign.pem')), 'khoá ký được lưu để lần chạy sau dùng lại');

// ---- 2. đăng ký rồi chuyển PC
db.prepare("INSERT INTO users (username) VALUES ('chu')").run();
db.prepare("INSERT INTO users (username) VALUES ('khac')").run();
const owner = db.prepare("SELECT * FROM users WHERE username='chu'").get();
const other = db.prepare("SELECT * FROM users WHERE username='khac'").get();
const OLD = makeGateway(); const NEW = makeGateway();
const reg = P.registerForUser(db, owner, OLD.registerBody(owner.id, { config: { devices: [] } }));
ok(reg.ok && reg.approved && reg.kit?.mqttId, 'đăng ký PC cũ');
ok(typeof reg.kit.cmdKey === 'string' && reg.kit.cmdKey === pub, 'kit mang khoá công khai ký lệnh (cmdKey)');
const { site, device } = reg;

const mineOwner = P.listGatewaysOfUser(db, owner);
ok(mineOwner.gateways.length === 1 && mineOwner.gateways[0].site === site, 'chủ thấy gateway của mình');
ok(P.listGatewaysOfUser(db, other).gateways.length === 0, 'người khác không thấy');

const body = (g, kind = 'rebind') => { const ts = Date.now(); return { site, device, pubkey: g.pubkey, ts, sig: g.sign(`${kind}|${site}|${device}|${ts}`) }; };
ok(P.rebindForUser(db, other, body(NEW)).error === 'not_found', 'người khác không chuyển được gateway của chủ');
ok(P.rebindForUser(db, owner, body(NEW, 'enroll')).error === 'invalid_proof', 'chữ ký sai loại (enroll) → từ chối');
const r = P.rebindForUser(db, owner, body(NEW));
ok(r.ok && r.kit.mqttId === reg.kit.mqttId, 'chủ chuyển sang PC mới: giữ nguyên id MQTT/tem');
ok(r.qr === reg.qr, 'QR không đổi');
ok(r.kit.mqtt?.password && r.kit.mqtt.password !== reg.kit.mqtt?.password, 'mật khẩu MQTT xoay → PC cũ bị cắt');
const oldTry = enrollGateway(db, { qr: reg.qr, ...OLD.proof('enroll', site, device) }, { kind: 'enroll' });
ok(oldTry.error, 'PC cũ không enroll lại được nữa');
const newTry = enrollGateway(db, { qr: reg.qr, ...NEW.proof('enroll', site, device) }, { kind: 'enroll' });
ok(!newTry.error && newTry.mqttId === reg.kit.mqttId, 'PC mới enroll được');

console.log(failed ? `\n${failed} FAIL` : '\nall ok');
process.exit(failed ? 1 : 0);
