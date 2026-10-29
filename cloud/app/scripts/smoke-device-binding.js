#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-bind-'));
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';
process.env.INGEST_REQUIRE_KNOWN = 'true';
process.env.INGEST_REQUIRE_ACTIVE_SUB = 'true';

const { openDb, upsertUser } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { createTenant, provisionDevice } = await import('../src/tenants.js');
const { resolveSubscriber } = await import('../src/deviceBinding.js');
const { grantPlan, grantTenantPlan } = await import('../src/entitlements.js');

const db = openDb(tmp);
let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

ok(resolveSubscriber(db, { site: 'x', device: 'y', tenant: 'default' }).reason === 'unknown_device', 'unknown dropped');

const u = upsertUser(db, {
  username: '84905556677', passwordHash: hashPassword('x'), folderPath: 's', version: '1',
  phone: '84905556677', notifySite: 'plantA', notifyDevice: 'plc01',
});
ok(resolveSubscriber(db, { site: 'plantA', device: 'plc01' }).ok, 'user site accepted');
grantPlan(db, u.id, 'pro', { expiresAt: '2020-01-01' });
ok(resolveSubscriber(db, { site: 'plantA', device: 'plc01' }).reason === 'user_plan_expired', 'expired user dropped');

createTenant(db, { id: 'acme', name: 'A' });
provisionDevice(db, 'acme', { site: 'p1', device: 'gw1' });
ok(resolveSubscriber(db, { ns: 'iot', tenant: 'acme', site: 'p1', device: 'gw1' }).source === 'device', 'device ok');
grantTenantPlan(db, 'acme', 'factory', { expiresAt: '2020-01-01' });
ok(resolveSubscriber(db, { ns: 'iot', tenant: 'acme', site: 'p1', device: 'gw1' }).reason === 'tenant_plan_expired', 'tenant expired');

console.log(fails ? `FAILED ${fails}` : 'smoke-device-binding OK');
process.exit(fails ? 1 : 0);
