#!/usr/bin/env node
/** Offline: MQTT contract, tenant/device provision, dual ACL. */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-contract-'));
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';
process.env.MQTT_DUAL_NS = 'true';
process.env.MQTT_PREFERRED_NS = 'plc';
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.com';
process.env.MQTT_PUBLIC_MQTTS_PORT = '8883';

const { openDb } = await import('../src/db.js');
const {
  parseTopic, topicBase, topicBases, withSchema, ingestTopicFilters, SCHEMA_VERSION, PLATFORM_NS,
} = await import('../src/contract.js');
const { createTenant, provisionDevice, findTenantByApiKey, listDevices, revokeDevice } = await import('../src/tenants.js');
const { rebuildAclFromUsers } = await import('../src/mqttProvision.js');

const db = openDb(tmp);
let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

ok(SCHEMA_VERSION === 1, 'schema version = 1');
ok(parseTopic('plc/s1/d1/telemetry')?.kind === 'telemetry', 'parse legacy topic');
ok(parseTopic('iot/acme/s1/d1/cmd')?.tenant === 'acme', 'parse iot topic');
ok(parseTopic('bad/x') === null, 'reject bad topic');
ok(topicBase({ ns: 'plc', site: 'a', device: 'b' }) === 'plc/a/b', 'legacy base');
ok(topicBase({ ns: 'iot', tenant: 'acme', site: 'a', device: 'b' }) === 'iot/acme/a/b', 'iot base');
ok(topicBases({ site: 'a', device: 'b', tenant: 't1' }).length === 2, 'dual bases');
ok(withSchema({ a: 1 }).schema === 1, 'withSchema');
ok(ingestTopicFilters().includes('plc/+/+/+') && ingestTopicFilters().includes('iot/+/+/+/+'), 'ingest filters');

const t = createTenant(db, { id: 'acme', name: 'ACME', profile: 'conveyor-v1' });
ok(t.ok && t.apiKey?.startsWith('pk_'), 'create tenant + api key');
ok(findTenantByApiKey(db, t.apiKey)?.id === 'acme', 'lookup by api key');
ok(createTenant(db, { id: 'acme' }).error === 'tenant_exists', 'duplicate tenant');
ok(createTenant(db, { id: 'bad/id' }).error === 'invalid_tenant_id', 'invalid tenant id');

const prov = provisionDevice(db, 'acme', { site: 'plant1', device: 'gw01' });
ok(prov.ok && prov.device.topicBase === 'iot/acme/plant1/gw01', 'provision → iot topic');
ok(prov.mqtt.username && prov.mqtt.password, 'mqtt credentials');
ok(prov.mqtt.mqtts === 'mqtts://mqtt.example.com:8883', 'mqtts endpoint');
ok(prov.device.topics.cmd === 'iot/acme/plant1/gw01/cmd', 'cmd topic');

const acl = fs.readFileSync(path.join(tmp, 'cfg', 'acl'), 'utf8');
ok(acl.includes('topic write iot/+/+/+/telemetry'), 'static ACL iot write');
ok(acl.includes('topic write plc/+/+/telemetry'), 'static ACL plc write');
ok(acl.includes(`user ${prov.mqtt.username}`), 'device user in ACL');
ok(acl.includes('topic write iot/acme/plant1/gw01/telemetry'), 'device telemetry ACL');
ok(acl.includes('topic read iot/acme/plant1/gw01/cmd'), 'device cmd read ACL');
ok(acl.includes('user ctl\ntopic write plc/+/+/cmd'), 'ctl write plc cmd');
ok(acl.includes('topic write iot/+/+/+/cmd'), 'ctl write iot cmd');

ok(listDevices(db, 'acme').length === 1, 'list devices');
const rot = provisionDevice(db, 'acme', { site: 'plant1', device: 'gw01' }, { rotate: true });
ok(rot.ok && rot.mqtt.password !== prov.mqtt.password, 'rotate password');
ok(revokeDevice(db, 'acme', 'plant1', 'gw01').ok, 'revoke device');
rebuildAclFromUsers(db);
const acl2 = fs.readFileSync(path.join(tmp, 'cfg', 'acl'), 'utf8');
ok(!acl2.includes(`user ${prov.mqtt.username}\n`), 'revoked device removed from ACL');

// legacy ns explicit
const leg = provisionDevice(db, 'acme', { site: 'old', device: 'gw', ns: 'plc' });
ok(leg.ok && leg.device.topicBase === 'plc/old/gw', 'ns=plc provision');

console.log(fails ? `FAILED ${fails}` : 'smoke-contract OK');
process.exit(fails ? 1 : 0);
