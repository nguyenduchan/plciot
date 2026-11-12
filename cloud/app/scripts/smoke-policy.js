#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-pol-'));
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';
process.env.INGEST_REQUIRE_KNOWN = 'true';
process.env.INGEST_REQUIRE_ACTIVE_SUB = 'true';
process.env.POLICY_FLOOD_MAX = '5';
process.env.POLICY_FLOOD_WINDOW_SEC = '60';
process.env.POLICY_AUTO_BLOCK_AFTER = '3';
process.env.POLICY_AUTO_BLOCK_WINDOW_SEC = '60';
process.env.POLICY_AUTO_BLOCK_TTL_SEC = '3600';

const { openDb, upsertUser } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { evaluateIngest, createBlock, listBlocks, recordDeny, hardBlockDevice } = await import('../src/policy.js');
// ingest tra id MQTT ngẫu nhiên → thiết bị rồi mới gọi evaluateIngest với parsed đã có site/device/tenant
const parsedOf = (site, device, mqttId = 'a'.repeat(16)) => ({ ns: 'gw', mqttId, tenant: 'default', site, device, kind: 'telemetry' });

const db = openDb(tmp);
let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

upsertUser(db, {
  username: '84901110001', passwordHash: hashPassword('x'), folderPath: 's', version: '1',
  notifySite: 'p', notifyDevice: 'd1',
});

const tele = Buffer.from(JSON.stringify({ schema: 1, r: Array.from({ length: 40 }, (_, i) => i) }));
const topic = `gw/${'a'.repeat(16)}/telemetry`;
const parsed = parsedOf('p', 'd1');

let v = evaluateIngest(db, { topic, parsed, payloadBuf: tele });
ok(v.allow, 'known user telemetry allowed');

v = evaluateIngest(db, { topic: `gw/${'b'.repeat(16)}/telemetry`, parsed: parsedOf('no', 'no', 'b'.repeat(16)), payloadBuf: tele });
ok(!v.allow && v.reason === 'unknown_device', 'unknown denied');

v = evaluateIngest(db, { topic, parsed, payloadBuf: Buffer.from('not-json') });
ok(!v.allow && v.reason === 'invalid_json', 'bad json denied');

v = evaluateIngest(db, { topic, parsed, payloadBuf: Buffer.from('x'.repeat(9000)) });
ok(!v.allow && v.reason === 'payload_too_large', 'oversized denied');

createBlock(db, { scope: 'device', site: 'p', device: 'd1', reason: 'test', createdBy: 'smoke' });
v = evaluateIngest(db, { topic, parsed, payloadBuf: tele });
ok(!v.allow && v.reason === 'manual_block', 'manual block');

// flood on another device
upsertUser(db, {
  username: '84901110002', passwordHash: hashPassword('x'), folderPath: 's2', version: '1',
  notifySite: 'p', notifyDevice: 'd2',
});
const t2 = `gw/${'c'.repeat(16)}/telemetry`;
const p2 = parsedOf('p', 'd2', 'c'.repeat(16));
let flooded = false;
for (let i = 0; i < 8; i++) {
  const r = evaluateIngest(db, { topic: t2, parsed: p2, payloadBuf: tele });
  if (!r.allow && r.reason === 'flood') flooded = true;
}
ok(flooded, 'flood denied');

// auto-block after denies
for (let i = 0; i < 3; i++) {
  recordDeny(db, { reason: 'unknown_device', site: 'z', device: 'evil', tenantId: 'default', kind: 'telemetry' });
}
ok(listBlocks(db).some((b) => b.site === 'z' && b.device === 'evil' && b.mode === 'auto'), 'auto-block created');

ok(hardBlockDevice(db, { tenantId: 'default', site: 'p', device: 'd2', reason: 'hard', createdBy: 'smoke' }).ok, 'hard block');

console.log(fails ? `FAILED ${fails}` : 'smoke-policy OK');
process.exit(fails ? 1 : 0);
