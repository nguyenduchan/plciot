#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { normalizeTelemetryPayload, resolveTelemetryMessage } from '../src/telemetryNormalize.js';
import { evaluateIngest, initPolicyTables } from '../src/policy.js';
import { parseTopic } from '../src/contract.js';

process.env.INGEST_REQUIRE_KNOWN = 'false';
process.env.INGEST_REQUIRE_ACTIVE_SUB = 'false';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-norm-'));
const db = new Database(path.join(tmp, 't.db'));
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT DEFAULT 'x', folder_path TEXT DEFAULT 'f',
    disabled INTEGER DEFAULT 0, setup_complete INTEGER DEFAULT 1, notify_site TEXT, notify_device TEXT,
    mqtt_user TEXT, role TEXT DEFAULT 'operator', tenant_id TEXT DEFAULT 'default', site_owner INTEGER DEFAULT 0
  );
  CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, profile TEXT, created_at INTEGER);
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY, tenant_id TEXT, site TEXT, device TEXT, status TEXT DEFAULT 'active',
    topic_ns TEXT, profile TEXT, created_at INTEGER, updated_at INTEGER
  );
`);
initPolicyTables(db);
db.prepare(`INSERT INTO tenants (id, name, profile, created_at) VALUES ('default','D','monitor-only',?)`).run(Date.now());
db.prepare(`INSERT INTO devices (tenant_id, site, device, status, topic_ns, created_at, updated_at)
  VALUES ('default','demo','gw01','active','plc',?,?)`).run(Date.now(), Date.now());

let fails = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { fails++; console.error('FAIL', m); } };

ok(normalizeTelemetryPayload({ schema: 2, d: { env1: { t: 1 } } }).d.env1.t === 1, 'schema2 d');
ok(Array.isArray(normalizeTelemetryPayload({ r: Array(20).fill(0) }).r), 'legacy r[]');
ok(normalizeTelemetryPayload({ temp: 1 }).error === 'policy_telemetry_shape', 'reject flat (no format mgmt)');

const resolved = resolveTelemetryMessage(db, {
  payloadBuf: Buffer.from(JSON.stringify({ schema: 2, d: { pump1: { run: 1 } } })),
});
ok(resolved.ok && resolved.canonical.d.pump1.run === 1, 'resolve schema2');

const topic = `gw/${'d'.repeat(16)}/telemetry`;
const parsed = { ns: 'gw', mqttId: 'd'.repeat(16), tenant: 'default', site: 'demo', device: 'gw01', kind: 'telemetry' };
const v = evaluateIngest(db, {
  topic, parsed,
  payloadBuf: Buffer.from(JSON.stringify({ schema: 2, d: { env1: { t: 9 } } })),
});
ok(v.allow && v.resolved?.canonical?.d?.env1?.t === 9, 'policy allow schema2');

const bad = evaluateIngest(db, {
  topic, parsed,
  payloadBuf: Buffer.from(JSON.stringify({ temp: 1 })),
});
ok(!bad.allow && bad.reason === 'policy_telemetry_shape', 'policy reject unmanaged flat');

console.log(fails ? `FAILED ${fails}` : 'smoke-telemetry-normalize OK');
process.exit(fails ? 1 : 0);
