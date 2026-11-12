#!/usr/bin/env node
/**
 * Sinh cấu hình broker THỬ cho smoke-mqtt-id-broker.js (không đụng DB/broker thật):
 *   node scripts/gen-broker-test-config.js <thư-mục-ra>
 * → <ra>/acl, <ra>/acl-monitor, <ra>/users.json (user/mật khẩu để tạo file passwd bằng mosquitto_passwd) và <ra>/info.json
 * Hai gateway (A, B) có id MQTT ngẫu nhiên khác nhau + hai user app (xem gateway A / gateway B).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const out = path.resolve(process.argv[2] || './broker-test');
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brk-'));
process.env.MQTT_CONFIG_DIR = out;
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';
process.env.CONTROL_VIA_SERVER = 'true';

const { openDb, upsertUser, findUserById } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { ensureDefaultTenant, provisionDevice } = await import('../src/tenants.js');
const { provisionUserMqtt, rebuildAclFromUsers, openMqttPass } = await import('../src/mqttProvision.js');

const db = openDb(tmp);
ensureDefaultTenant(db);
const gwA = provisionDevice(db, 'default', { site: 'siteA', device: 'gwA' });
const gwB = provisionDevice(db, 'default', { site: 'siteB', device: 'gwB' });

const mkUser = (name, site, device) => {
  const u = upsertUser(db, { username: name, passwordHash: hashPassword('x'), folderPath: `f_${name}`, version: '1', notifySite: site, notifyDevice: device });
  const r = provisionUserMqtt(db, findUserById(db, u.id), { site, device });
  return { username: r.user.mqtt_user, password: openMqttPass(r.user.mqtt_pass) };
};
const userA = mkUser('user_a', 'siteA', 'gwA');
const userB = mkUser('user_b', 'siteB', 'gwB');
rebuildAclFromUsers(db);

const users = [
  { username: gwA.mqtt.username, password: gwA.mqtt.password },
  { username: gwB.mqtt.username, password: gwB.mqtt.password },
  userA, userB,
  { username: 'ingest', password: 'ingest-pw' }, { username: 'ctl', password: 'ctl-pw' },
];
fs.writeFileSync(path.join(out, 'users.json'), JSON.stringify(users));
// script tạo file passwd bằng mosquitto_passwd (chạy trong container mosquitto, thư mục ra gắn vào /c)
fs.writeFileSync(path.join(out, 'mkpw.sh'), ['#!/bin/sh', 'rm -f /c/passwd; touch /c/passwd', ...users.map((u) => `mosquitto_passwd -b /c/passwd '${u.username}' '${u.password}'`), ''].join(String.fromCharCode(10)));
fs.writeFileSync(path.join(out, 'info.json'), JSON.stringify({
  gwA: { user: gwA.mqtt.username, pass: gwA.mqtt.password, id: gwA.device.mqttId },
  gwB: { user: gwB.mqtt.username, pass: gwB.mqtt.password, id: gwB.device.mqttId },
  userA: { ...userA, id: gwA.device.mqttId }, userB: { ...userB, id: gwB.device.mqttId },
  ingest: { user: 'ingest', pass: 'ingest-pw' }, ctl: { user: 'ctl', pass: 'ctl-pw' },
}));
console.log('ok', out);
