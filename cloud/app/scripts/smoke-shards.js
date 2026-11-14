#!/usr/bin/env node
/**
 * Smoke: chia nhóm Mosquitto (MQTT_SHARDS=3).
 *  - shardOf ổn định + phân đều, N=1 luôn nhóm 0
 *  - ACL/passwd từng nhóm: gateway chỉ ở đúng nhóm của nó, người xem chỉ ở nhóm có gateway của họ (xem nhiều nhóm)
 *  - endpoint gateway: cổng công khai = gốc + nhóm
 *  - cấu hình tự động: auto = số core - dành riêng, giới hạn 1..16, cổng nội bộ = gốc + 10k
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { configure, migrateSecurity, generateClaimRootKeyPair, provisionHardwareDevice } from '@plciot/security';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, '..'));

const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = 'shards-secret-16-chars';
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';
process.env.MQTT_SHARDS = '3';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shards-'));
process.env.MQTT_CONFIG_DIR = tmp;
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container-for-test';

let failed = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { console.error('FAIL', m); failed += 1; } };

const sh = await import('../src/shards.js');
ok(sh.shardCount() === 3, 'MQTT_SHARDS=3 → 3 nhóm');
const ids = Array.from({ length: 3000 }, (_, i) => (i * 2654435761 % 4294967296).toString(16).padStart(8, '0') + '0123456789abcdef'.slice(0, 8));
const cnt = [0, 0, 0];
for (const id of ids) cnt[sh.shardOf(id)] += 1;
ok(cnt.every((c) => c > 800 && c < 1200), `phân đều 3 nhóm (${cnt.join('/')})`);
ok(sh.shardOf(ids[5]) === sh.shardOf(ids[5]) && sh.shardOf(ids[5], 1) === 0 && sh.shardOf('', 3) === 0, 'ổn định; N=1 và id rỗng → nhóm 0');
ok(sh.shardContainer() === 'no-such-container-for-test' && sh.shardHost() === 'mqtt', 'mọi nhóm cùng một container/host (mỗi nhóm một tiến trình)');
ok(sh.shardUrls('X_URLS', 'X_URL', 1885).join() === 'mqtt://mqtt:1885,mqtt://mqtt:1895,mqtt://mqtt:1905', 'URL nội bộ: cổng gốc + 10k');
ok(sh.shardConfigDirInContainer(0) === '/mosquitto/config' && sh.shardConfigDirInContainer(2) === '/mosquitto/config/shard2', 'thư mục cấu hình từng nhóm trong container');
const cores = (await import('node:os')).cpus().length;
process.env.MQTT_SHARDS = 'auto'; delete process.env.MQTT_RESERVE_CORES;
ok(sh.shardCount() === Math.max(1, Math.min(16, cores - 1)), `auto = số core - 1 (${cores} core → ${sh.shardCount()} nhóm)`);
process.env.MQTT_RESERVE_CORES = '0';
ok(sh.shardCount() === Math.max(1, Math.min(16, cores)), 'auto với reserve 0 = số core');
process.env.MQTT_SHARDS = '99'; ok(sh.shardCount() === 16, 'tối đa 16 nhóm');
process.env.MQTT_SHARDS = 'abc'; ok(sh.shardCount() === 1, 'giá trị sai → 1 nhóm');
process.env.MQTT_SHARDS = '3';

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
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id, site, device)
  );
`);
configure({ secret: () => process.env.APP_JWT_SECRET, publicUrl: () => 'https://plc.example' });
const { attachGatewayBundle } = await import('../src/gatewayEnroll.js');
const { rebuildAclFromUsers } = await import('../src/mqttProvision.js');
const { addFromHardwareRow, migrateUserDevices } = await import('../src/userDevices.js');
const { mqttClientConfig, sealMqttPass } = await import('../src/mqttProvision.js');
migrateUserDevices(db);

// cấp nhiều gateway cho tới khi có đủ ở cả 3 nhóm
const meta = { configRev: 1, seed: [{ childId: 'bon1', type: 'dynamic', title: 'Bồn', fields: ['level'] }] };
const gws = [];
for (let i = 0; gws.length < 12 || new Set(gws.map((g) => g.shard)).size < 3; i += 1) {
  const r = provisionHardwareDevice(db, { site: `s${i}`, device: 'gw01', label: 'T', profile: 'iot-hub', uiMeta: meta });
  const a = attachGatewayBundle(db, r, { rotateMqtt: true, includePassword: false });
  gws.push({ id: a.gateway.mqttId, shard: sh.shardOf(a.gateway.mqttId), site: `s${i}`, ep: a.gateway.mqtt });
  if (i > 200) break;
}
ok(new Set(gws.map((g) => g.shard)).size === 3, 'gateway rải đủ cả 3 nhóm');

const aclOf = (k) => fs.readFileSync(path.join(tmp, k === 0 ? '' : `shard${k}`, 'acl'), 'utf8');
for (const g of gws) {
  const inRight = aclOf(g.shard).includes(`topic write gw/${g.id}/telemetry`);
  const inOthers = [0, 1, 2].filter((k) => k !== g.shard).some((k) => aclOf(k).includes(`gw/${g.id}/`));
  if (!inRight || inOthers) { ok(false, `gateway ${g.id} sai nhóm`); break; }
}
ok(true, 'ACL: mỗi gateway chỉ có ở đúng nhóm của nó');
const g0 = gws.find((g) => g.shard === 0);
const g2 = gws.find((g) => g.shard === 2);
ok(g0.ep.mqtts?.endsWith(':48263') || String(g0.ep.mqtts || g0.ep.port || '').includes('48263'), 'endpoint gateway nhóm 0: cổng gốc');
ok(String(g2.ep.mqtts || g2.ep.port || '').includes('48265'), 'endpoint gateway nhóm 2: cổng gốc + 2');

// người xem có gateway ở nhóm 0 và nhóm 2
db.prepare("INSERT INTO users (username, mqtt_user, mqtt_pass, notify_site, notify_device) VALUES ('viewer', 'uview', ?, ?, 'gw01')").run(sealMqttPass('pw'), g0.site);
const u = db.prepare("SELECT * FROM users WHERE username = 'viewer'").get();
for (const g of [g0, g2]) {
  const hw = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(g.site, 'gw01');
  try { addFromHardwareRow(db, u, hw); } catch { /* một số bản kiểm tra thêm gateway cần chủ; ACL vẫn kiểm bằng gatewaysOfUser */ }
}
rebuildAclFromUsers(db);
const has = (k) => aclOf(k).includes('user uview');
const owned = new Set([sh.shardOf(g0.id), sh.shardOf(g2.id)]);
let usersOk = true;
for (const k of [0, 1, 2]) if (has(k) !== owned.has(k)) usersOk = false;
ok(usersOk, `người xem chỉ có mặt ở nhóm có gateway của họ (nhóm ${[...owned].join(',')})`);
const cfg = mqttClientConfig(db, db.prepare("SELECT * FROM users WHERE username = 'viewer'").get());
ok(cfg?.shards?.count === 3 && Object.keys(cfg.shards.endpoints || {}).length === owned.size, 'client config có endpoint từng nhóm của người xem');

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} lỗi`); process.exit(1); }
console.log('\nsmoke-shards OK');
