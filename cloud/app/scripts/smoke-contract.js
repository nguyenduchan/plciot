#!/usr/bin/env node
/** Offline: hợp đồng MQTT (topic gw/<mqttId>/<kind>), id MQTT ngẫu nhiên do server cấp, provision thiết bị, ACL theo id. */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-contract-'));
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.com';
process.env.MQTT_PUBLIC_MQTTS_PORT = '8883';

const { openDb } = await import('../src/db.js');
const {
  parseTopic, topicBase, topicBases, topicOf, withSchema, ingestTopicFilters, SCHEMA_VERSION, newMqttId, isValidMqttId,
} = await import('../src/contract.js');
const { createTenant, provisionDevice, findTenantByApiKey, listDevices, revokeDevice } = await import('../src/tenants.js');
const { rebuildAclFromUsers, userAclBlock } = await import('../src/mqttProvision.js');
const { deviceByMqttId, mqttIdFor, ensureMqttIdColumn, clearMqttIdCache } = await import('../src/mqttIds.js');

const db = openDb(tmp);
let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

// ---- hợp đồng topic
const sample = newMqttId();
ok(SCHEMA_VERSION === 1, 'schema version = 1');
ok(isValidMqttId(sample) && /^[a-f0-9]{16}$/.test(sample), 'id MQTT: 16 ký tự hex');
ok(newMqttId() !== newMqttId(), 'id MQTT ngẫu nhiên, mỗi lần khác nhau');
ok(!isValidMqttId('plant1') && !isValidMqttId('../x') && !isValidMqttId(''), 'id MQTT không hợp lệ bị từ chối');
ok(parseTopic(`gw/${sample}/telemetry`)?.mqttId === sample && parseTopic(`gw/${sample}/cmd`)?.kind === 'cmd', 'parse topic gw/<id>/<kind>');
ok(parseTopic(`gw/${sample}/config`)?.kind === 'config', 'kind config');
ok(parseTopic('plc/s1/d1/telemetry') === null, 'topic cũ plc/… bị bỏ');
ok(parseTopic('iot/acme/s1/d1/cmd') === null, 'topic cũ iot/… bị bỏ');
ok(parseTopic('bad/x') === null && parseTopic(`gw/${sample}`) === null && parseTopic(`gw/${sample}/xyz`) === null && parseTopic(`gw/${sample}/telemetry/extra`) === null, 'topic sai bị từ chối');
ok(topicBase({ mqttId: sample }) === `gw/${sample}` && topicOf({ mqttId: sample }, 'ack') === `gw/${sample}/ack`, 'topic base/of');
let threw = false; try { topicBase({ mqttId: 'site/device' }); } catch { threw = true; }
ok(threw, 'topic không nhận site/device làm id');
ok(topicBases({ mqttId: sample }).length === 1, 'một base duy nhất');
ok(withSchema({ a: 1 }).schema === 1, 'withSchema');
ok(ingestTopicFilters().length === 1 && ingestTopicFilters()[0] === 'gw/+/+', 'ingest filter gw/+/+');

// ---- tenant
const t = createTenant(db, { id: 'acme', name: 'ACME', profile: 'conveyor-v1' });
ok(t.ok && t.apiKey?.startsWith('pk_'), 'create tenant + api key');
ok(findTenantByApiKey(db, t.apiKey)?.id === 'acme', 'lookup by api key');
ok(createTenant(db, { id: 'acme' }).error === 'tenant_exists', 'duplicate tenant');
ok(createTenant(db, { id: 'bad/id' }).error === 'invalid_tenant_id', 'invalid tenant id');

// ---- provision: server cấp id ngẫu nhiên, lưu DB, ánh xạ gateway
const prov = provisionDevice(db, 'acme', { site: 'plant1', device: 'gw01' });
const id1 = prov.device?.mqttId;
ok(prov.ok && isValidMqttId(id1), 'provision cấp id MQTT ngẫu nhiên');
ok(prov.device.topicBase === `gw/${id1}`, 'topic base = gw/<id>');
ok(!prov.device.topicBase.includes('plant1') && !prov.device.topicBase.includes('gw01'), 'topic không lộ tên site/device');
ok(prov.device.topics.cmd === `gw/${id1}/cmd` && prov.device.topics.config === `gw/${id1}/config` && prov.device.topics.telemetry === `gw/${id1}/telemetry`, 'topics đủ các kind');
ok(prov.mqtt.username && prov.mqtt.password, 'mqtt credentials');
ok(prov.mqtt.mqtts === 'mqtts://mqtt.example.com:8883', 'mqtts endpoint');
ok(db.prepare("SELECT mqtt_id FROM devices WHERE site = 'plant1' AND device = 'gw01'").get().mqtt_id === id1, 'id lưu trong DB (bảng devices)');
ok(deviceByMqttId(db, id1)?.site === 'plant1' && deviceByMqttId(db, id1)?.device === 'gw01' && deviceByMqttId(db, id1)?.tenant_id === 'acme', 'tra ngược id → tenant/site/device');
ok(mqttIdFor(db, 'acme', 'plant1', 'gw01') === id1, 'tra xuôi site/device → id');
ok(deviceByMqttId(db, newMqttId()) === null, 'id lạ → không có thiết bị');

const prov2 = provisionDevice(db, 'acme', { site: 'plant1', device: 'gw02' });
const id2 = prov2.device.mqttId;
ok(id2 !== id1, 'hai gateway có hai id khác nhau');

// ---- ACL
const acl = fs.readFileSync(path.join(tmp, 'cfg', 'acl'), 'utf8');
ok(acl.includes('topic write gw/+/telemetry') && acl.includes('topic write gw/+/config'), 'static ACL ghi gw/+/<kind>');
ok(!acl.includes('plc/') && !acl.includes('iot/'), 'ACL không còn namespace cũ');
ok(acl.includes(`user ${prov.mqtt.username}`), 'device user in ACL');
ok(acl.includes(`topic write gw/${id1}/telemetry`) && acl.includes(`topic write gw/${id1}/config`), 'ACL ghi đúng topic của id mình');
ok(acl.includes(`topic read gw/${id1}/cmd`), 'ACL đọc cmd của id mình');
const block1 = acl.slice(acl.indexOf(`user ${prov.mqtt.username}\n`)).split('\nuser ')[0];
ok(!block1.includes(id2), 'gateway A không có quyền trên topic của gateway B');
ok(acl.includes('user ctl\ntopic write gw/+/cmd'), 'ctl ghi cmd');
ok(acl.includes('user ingest') && acl.includes('topic read gw/+/telemetry'), 'ingest đọc gw/+/<kind>');

const viewer = userAclBlock('u9', [id1], 'viewer', ['telemetry', 'status', 'history', 'ack'], true);
ok(viewer.includes(`topic read gw/${id1}/telemetry`) && !viewer.includes('write') && !viewer.includes(id2), 'user chỉ đọc topic của gateway được xem');
ok(!userAclBlock('u9', [], 'operator').includes('topic'), 'user chưa có gateway → không có quyền topic nào');
ok(!userAclBlock('u9', ['plant1/gw01'], 'operator').includes('topic'), 'id sai định dạng bị loại khỏi ACL');

// ---- vòng đời: xoay mật khẩu giữ nguyên id; thu hồi chặn ingest
ok(listDevices(db, 'acme').length === 2 && listDevices(db, 'acme').every((d) => isValidMqttId(d.mqttId)), 'list devices có mqttId');
const rot = provisionDevice(db, 'acme', { site: 'plant1', device: 'gw01' }, { rotate: true });
ok(rot.ok && rot.mqtt.password !== prov.mqtt.password, 'rotate password');
ok(rot.device.mqttId === id1, 'xoay mật khẩu KHÔNG đổi id MQTT');
ok(revokeDevice(db, 'acme', 'plant1', 'gw01').ok, 'revoke device');
ok(deviceByMqttId(db, id1) === null, 'thiết bị bị thu hồi: ingest không còn tra ra id');
rebuildAclFromUsers(db);
const acl2 = fs.readFileSync(path.join(tmp, 'cfg', 'acl'), 'utf8');
ok(!acl2.includes(`user ${prov.mqtt.username}\n`), 'revoked device removed from ACL');
ok(acl2.includes(`topic write gw/${id2}/telemetry`), 'gateway khác vẫn còn trong ACL');

// ---- ingest: gói gw/<id>/<kind> được gắn đúng thiết bị; id lạ / đã thu hồi bị bỏ
const { resolveIngestTopic } = await import('../src/mqttIngest.js');
const rv = resolveIngestTopic(db, `gw/${id2}/telemetry`);
ok(rv?.site === 'plant1' && rv?.device === 'gw02' && rv?.tenant === 'acme' && rv?.kind === 'telemetry', 'ingest: id → đúng tenant/site/device');
ok(resolveIngestTopic(db, `gw/${newMqttId()}/telemetry`) === null, 'ingest: id lạ bị bỏ');
ok(resolveIngestTopic(db, `gw/${id1}/telemetry`) === null, 'ingest: id đã thu hồi bị bỏ');
ok(resolveIngestTopic(db, 'plc/plant1/gw02/telemetry') === null && resolveIngestTopic(db, 'iot/acme/plant1/gw02/telemetry') === null, 'ingest: topic cũ theo tên site/device không còn được nhận');

// ---- dấu vân tay chứng chỉ broker tự ký: server trao trong kit enroll để gateway tự ghim
process.env.MQTT_PUBLIC_PIN_SHA256 = 'B2:DD:5C 55';
const { mqttPublicEndpoints } = await import('../src/contract.js');
ok(mqttPublicEndpoints().pinSha256 === 'b2dd5c55', 'pinSha256: bỏ dấu : và khoảng trắng, chữ thường');
const provPin = provisionDevice(db, 'acme', { site: 'plant1', device: 'gw02' });
ok(provPin.mqtt.pinSha256 === 'b2dd5c55', 'kit provision/enroll mang pinSha256');
delete process.env.MQTT_PUBLIC_PIN_SHA256;
ok(mqttPublicEndpoints().pinSha256 === null, 'không đặt env → pinSha256 null (chứng chỉ CA thật)');

// ---- migrate DB cũ: thiết bị chưa có id được cấp id ngẫu nhiên
db.exec('CREATE TABLE devices_old AS SELECT * FROM devices WHERE 0');
db.prepare("INSERT INTO devices (tenant_id, site, device, mqtt_user, mqtt_pass, topic_ns, profile, status, created_at, updated_at, mqtt_id) VALUES ('acme','old','gwx','dold','p','plc','conveyor-v1','active',1,1,NULL)").run();
clearMqttIdCache();
ensureMqttIdColumn(db);
const mig = db.prepare("SELECT mqtt_id FROM devices WHERE site = 'old'").get().mqtt_id;
ok(isValidMqttId(mig), 'migrate: thiết bị cũ được cấp id ngẫu nhiên');
ensureMqttIdColumn(db);
ok(db.prepare("SELECT mqtt_id FROM devices WHERE site = 'old'").get().mqtt_id === mig, 'migrate lặp lại không đổi id');

console.log(fails ? `FAILED ${fails}` : 'smoke-contract OK');
process.exit(fails ? 1 : 0);
