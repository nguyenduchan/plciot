#!/usr/bin/env node
/**
 * Smoke: admin seed một lần → gateway enroll bằng QR → nhận mqtt + seed (không nhập lại).
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-enroll-'));
process.env.MQTT_CONFIG_DIR = tmp;

const db = new Database(path.join(tmp, 't.db'));
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT NOT NULL DEFAULT 'x',
    folder_path TEXT NOT NULL DEFAULT 'f', disabled INTEGER DEFAULT 0, setup_complete INTEGER DEFAULT 1,
    notify_site TEXT DEFAULT 'f', notify_device TEXT DEFAULT 'plc01', mqtt_user TEXT, mqtt_pass TEXT,
    role TEXT DEFAULT 'operator', tenant_id TEXT DEFAULT 'default', monitor_scopes TEXT
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

const { enrollGateway, attachGatewayBundle, bumpConfigRev } = await import('../src/gatewayEnroll.js');
const { updateHardwareDeviceMeta } = await import('@plciot/security');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('OK', msg);
  else { console.error('FAIL', msg); failed += 1; }
}

const hw = provisionHardwareDevice(db, {
  site: 'demo_home',
  device: 'gw01',
  profile: 'iot-hub',
  label: 'GW nhà',
  uiMeta: {
    configRev: 1,
    seed: [
      { childId: 'env1', type: 'env', title: 'Phòng khách' },
      { childId: 'pump1', type: 'pump' },
    ],
  },
});
ok(hw.ok && hw.qr, 'provision hardware + qr');

const bundled = attachGatewayBundle(db, hw, { rotateMqtt: true, includePassword: false });
ok(/^gw\/[a-f0-9]{16}$/.test(bundled.gateway?.topicBase || '') && !bundled.gateway.topicBase.includes('gw01') && bundled.gateway.mqttId === bundled.gateway.topicBase.slice(3), 'admin bundle topicBase = gw/<id ngẫu nhiên>, không lộ site/device');
ok(bundled.gateway?.pack?.length === 2, 'admin bundle pack');
ok(!bundled.gateway?.mqtt?.password, 'admin bundle ẩn password');

const enrolled = enrollGateway(db, { qr: hw.qr }, { includePassword: true });
ok(enrolled.ok && enrolled.mqtt?.password, 'enroll trả password');
ok(enrolled.mqtt?.username, 'enroll mqtt user');
ok(enrolled.pack?.[0]?.id === 'env1' && enrolled.pack[0].fields?.includes('t'), 'pack env fields');
ok(enrolled.schema === 2 && enrolled.configRev === 1, 'schema + configRev');
ok(enrolled.topics?.cmd?.endsWith('/cmd') && enrolled.topics?.telemetry?.endsWith('/telemetry'), 'topics monitor+control');
ok(!enrolled.guides && !enrolled.ingestSuggest && !enrolled.manualSetup, 'khong quan ly format thua');

const again = enrollGateway(db, { qr: hw.qr }, { includePassword: true });
ok(again.mqtt?.password === enrolled.mqtt.password, 'enroll lại giữ password (không rotate)');

const cfg = enrollGateway(db, { qr: hw.qr }, { includePassword: false });
ok(!cfg.mqtt?.password && cfg.pack?.length === 2, 'config không lộ password');

const bumped = bumpConfigRev(hw.uiMeta, {
  seed: [
    { childId: 'env1', type: 'env' },
    { childId: 'pump1', type: 'pump' },
    { childId: 'sw1', type: 'switch' },
  ],
});
ok(bumped.configRev === 2, 'bump configRev');
updateHardwareDeviceMeta(db, { site: 'demo_home', device: 'gw01', uiMeta: bumped });
const after = enrollGateway(db, { qr: hw.qr }, { includePassword: false });
ok(after.configRev === 2 && after.pack?.length === 3, 'config sau patch pack');

const bad = enrollGateway(db, { qr: 'not-a-qr' });
ok(bad.error === 'invalid_claim_payload', 'reject qr hỏng');

ok(enrolled.role === 'hub' && enrolled.payloadExample?.d?.env1, 'hub payloadExample');
ok(Array.isArray(enrolled.pack?.[0]?.fields) && !('type' in (enrolled.pack[0] || {})), 'pack khong mang type');

const leaf = provisionHardwareDevice(db, {
  site: 'demo_home',
  device: 'pump1',
  profile: 'pump',
  label: 'Bơm sân',
});
ok(leaf.ok, 'provision leaf');
const leafEnroll = enrollGateway(db, { qr: leaf.qr }, { includePassword: true });
ok(leafEnroll.role === 'leaf', 'leaf role');
ok(leafEnroll.pack?.[0]?.id === 'pump1' && leafEnroll.pack[0].fields?.includes('run'), 'leaf pack');
ok(leafEnroll.payloadExample?.d?.pump1?.run === 0, 'leaf payloadExample');
ok(leafEnroll.mqtt?.password, 'leaf mqtt');
ok(leafEnroll.topicBase !== enrolled.topicBase, 'leaf topic khác hub');

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nsmoke-gateway-enroll: all ok (hub + leaf + guides)');
