#!/usr/bin/env node
/**
 * Smoke: vòng đời id MQTT khi cấp / đổi QR cho gateway (đi đúng các thao tác của route admin):
 *   A. cấp mới                          → id mới, ACL + ingest nhận id đó
 *   B. đổi QR khi id VẪN CÒN trên server → QR mới, id GIỮ NGUYÊN (topic không đổi, gateway chỉ cần QR mới)
 *   C. đổi QR khi id ĐÃ BỊ XOÁ trên server → id MỚI; id cũ mất quyền ở ACL + ingest, QR cũ vô hiệu
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  configure, migrateSecurity, generateClaimRootKeyPair, provisionHardwareDevice,
  reissueHardwareDeviceQr, deleteHardwareDevice,
} from '@plciot/security';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, '..'));

const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = 'mqtt-id-lifecycle-secret-16';
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mqid-'));
process.env.MQTT_CONFIG_DIR = tmp;
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container-for-test';

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

const { enrollGateway, attachGatewayBundle } = await import('../src/gatewayEnroll.js');
const { revokeDevice } = await import('../src/tenants.js');
const { revokeDeviceBinding } = await import('../src/sites.js');
const { deviceByMqttId } = await import('../src/mqttIds.js');
const { migrateUserDevices } = await import('../src/userDevices.js');
migrateUserDevices(db);

let failed = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { console.error('FAIL', m); failed += 1; } };
const acl = () => fs.readFileSync(path.join(tmp, 'acl'), 'utf8');
const SITE = 'tram_x', DEV = 'gw01';
const meta = { configRev: 1, seed: [{ childId: 'bon1', type: 'dynamic', title: 'Bồn', fields: ['level'] }] };

/** Giống POST /api/admin/hardware: gỡ chủ cũ nếu có, cấp QR, cấp MQTT. */
function adminProvision() {
  const prev = db.prepare('SELECT claimed_by FROM hardware_devices WHERE site = ? AND device = ?').get(SITE, DEV);
  if (prev?.claimed_by) revokeDeviceBinding(db, SITE, DEV, { ip: '127.0.0.1', adminId: 1 });
  const r = provisionHardwareDevice(db, { site: SITE, device: DEV, label: 'Test', profile: 'iot-hub', uiMeta: meta });
  return attachGatewayBundle(db, r, { rotateMqtt: true, includePassword: false });
}
const enroll = (qr) => enrollGateway(db, { qr }, { includePassword: true });
const row = () => db.prepare('SELECT * FROM devices WHERE site = ? AND device = ?').get(SITE, DEV);

// ───────── A. cấp mới
const A = adminProvision();
ok(A.ok && A.qr && A.gateway?.mqttId, 'A: cấp mới có QR + id MQTT');
const id1 = A.gateway.mqttId;
ok(/^[a-f0-9]{16}$/.test(id1) && A.gateway.topicBase === `gw/${id1}`, 'A: topic = gw/<id ngẫu nhiên>');
ok(acl().includes(`topic write gw/${id1}/telemetry`) && acl().includes(`topic read gw/${id1}/cmd`), 'A: ACL có quyền cho id mới');
ok(deviceByMqttId(db, id1)?.site === SITE, 'A: ingest tra ngược id → thiết bị');
const enA = enroll(A.qr);
ok(enA.mqttId === id1 && enA.mqtt?.password, 'A: gateway enroll bằng QR nhận đúng id');
const qr1 = A.qr, pass1 = enA.mqtt.password;

// ───────── B. đổi QR khi id vẫn còn
const B = adminProvision();
ok(B.ok && B.qr && B.qr !== qr1, 'B: QR mới khác QR cũ');
ok(B.gateway.mqttId === id1, 'B: id còn trên server → GIỮ NGUYÊN id');
ok(row().mqtt_id === id1 && row().status === 'active', 'B: DB vẫn id cũ, active');
ok(acl().includes(`gw/${id1}/telemetry`), 'B: ACL vẫn cho id đó');
ok(deviceByMqttId(db, id1)?.site === SITE, 'B: ingest vẫn nhận id đó');
const enB = enroll(B.qr);
ok(enB.mqttId === id1 && enB.mqtt?.password && enB.mqtt.password !== pass1, 'B: QR mới enroll → cùng id, mật khẩu mới');
ok(enroll(qr1).error, 'B: QR cũ không còn enroll được');
const qr2 = B.qr;

// ───────── C. đổi QR khi id đã bị xoá trên server (giống DELETE /api/admin/hardware?force=1)
revokeDeviceBinding(db, SITE, DEV, { ip: '127.0.0.1', adminId: 1 });
const del = deleteHardwareDevice(db, { site: SITE, device: DEV, force: true });
ok(!del.error, 'C: xoá tem');
revokeDevice(db, 'default', SITE, DEV);
ok(deviceByMqttId(db, id1) === null, 'C: sau khi xoá, ingest không nhận id cũ');
ok(!acl().includes(id1), 'C: sau khi xoá, ACL không còn id cũ');
ok(enroll(qr2).error, 'C: QR cũ không enroll được sau khi xoá');
const C = adminProvision();
ok(C.ok && C.qr && C.qr !== qr2 && C.qr !== qr1, 'C: cấp QR mới');
const id2 = C.gateway?.mqttId;
ok(/^[a-f0-9]{16}$/.test(id2 || '') && id2 !== id1, `C: id đã xoá → cấp id MỚI (không tái dùng id cũ) [${id1} → ${id2}]`);
ok(C.gateway?.topicBase === `gw/${id2}`, 'C: topic theo id mới');
ok(row().mqtt_id === id2 && row().status === 'active', 'C: DB: id mới, active');
ok(acl().includes(`gw/${id2}/telemetry`) && !acl().includes(id1), 'C: ACL chỉ có id mới');
ok(deviceByMqttId(db, id2)?.site === SITE && deviceByMqttId(db, id1) === null, 'C: ingest nhận id mới, từ chối id cũ');
const enC = enroll(C.qr);
ok(enC.mqttId === id2 && enC.mqtt?.password, 'C: gateway enroll bằng QR mới nhận id mới');
ok(enroll(qr1).error && enroll(qr2).error, 'C: mọi QR cũ vô hiệu');

// ───────── D. dọn: reissue (unclaim) cũng giữ id nếu còn
const D = attachGatewayBundle(db, reissueHardwareDeviceQr(db, { site: SITE, device: DEV, unclaim: true }), { rotateMqtt: true, includePassword: false });
ok(D.ok && D.qr !== C.qr && D.gateway.mqttId === id2, 'D: reissue QR khi id còn → giữ id');

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nsmoke-mqtt-id-lifecycle: all ok');
