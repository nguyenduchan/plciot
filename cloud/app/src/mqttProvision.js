import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { userScopes } from './roles.js';

// Hai file ACL cho hai nhóm listener của Mosquitto (per_listener_settings):
//   acl          — listener đã mã hoá (qua TLS): monitor + control tuỳ vai trò
//   acl-monitor  — listener KHÔNG mã hoá: chỉ monitor, không ai (trừ gateway) được ghi cmd
const HEADER = `# plciot ACL — static roles (do not put per-user lines above MARKER)
user gw
topic write plc/+/+/telemetry
topic write plc/+/+/status
topic write plc/+/+/ack
topic write plc/+/+/history
topic read plc/+/+/cmd

user edge
topic write plc/+/+/telemetry
topic write plc/+/+/status
topic write plc/+/+/ack
topic write plc/+/+/history
topic read plc/+/+/cmd

user ingest
topic read plc/+/+/telemetry
topic read plc/+/+/status
topic read plc/+/+/ack
topic read plc/+/+/history

# MARKER_USER_ACL
`;

function configDir() {
  return path.resolve(process.env.MQTT_CONFIG_DIR || path.join(process.env.DATA_DIR || './data', '..', '..', 'config'));
}

function aclPath() {
  return path.join(configDir(), 'acl');
}

function aclMonitorPath() {
  return path.join(configDir(), 'acl-monitor');
}

function passwdPath() {
  return path.join(configDir(), 'passwd');
}

function sanitize(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

export function randomMqttPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

export function mqttUsernameFor(userId) {
  return `u${userId}`;
}

/**
 * ACL block: user may only touch their site/device.
 * @param {string[]} scopes nhóm topic được đọc (monitor)
 * @param {boolean} secure true = listener mã hoá (cho phép control theo vai trò); false = chỉ monitor
 */
export function userAclBlock(mqttUser, site, device, role = 'operator', scopes = ['telemetry', 'status', 'ack', 'history'], secure = true) {
  const s = sanitize(site);
  const d = sanitize(device);
  const u = sanitize(mqttUser);
  const base = `plc/${s}/${d}`;
  const control = secure && role !== 'viewer';
  // người điều khiển cần đọc ack để biết lệnh đã được PLC thực hiện
  const readKinds = ['telemetry', 'status', 'ack', 'history'].filter((k) => scopes.includes(k) || (control && k === 'ack'));
  return [
    `user ${u}`,
    ...readKinds.map((k) => `topic read ${base}/${k}`),
    // control: chỉ qua kênh mã hoá và chỉ với vai trò operator/admin (viewer luôn chỉ xem)
    ...(control ? [`topic write ${base}/cmd`] : []),
    '',
  ].join('\n');
}

/**
 * Rebuild acl file from DB users that have mqtt_user set.
 * Keeps gw + ingest; drops shared wildcard "app" from active ACL
 * (legacy app user in passwd may remain but has no ACL → deny).
 */
export function rebuildAclFromUsers(db) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const users = db.prepare(`
    SELECT id, mqtt_user, notify_site, notify_device, role, monitor_scopes FROM users
    WHERE mqtt_user IS NOT NULL AND mqtt_user != '' AND disabled = 0
  `).all();
  let secure = HEADER;
  let plain = HEADER;
  for (const u of users) {
    const scopes = userScopes(u);
    secure += userAclBlock(u.mqtt_user, u.notify_site, u.notify_device, u.role, scopes, true);
    plain += userAclBlock(u.mqtt_user, u.notify_site, u.notify_device, u.role, scopes, false);
  }
  fs.writeFileSync(aclPath(), secure, 'utf8');
  fs.writeFileSync(aclMonitorPath(), plain, 'utf8');
  return users.length;
}

/** Set/update password in mosquitto passwd (shared config volume). */
export function setMosquittoPassword(username, password) {
  const user = sanitize(username);
  const pp = passwdPath();
  try {
    if (!fs.existsSync(pp)) fs.writeFileSync(pp, '');
    execFileSync('mosquitto_passwd', ['-b', pp, user, password], { stdio: 'pipe' });
    return { ok: true, via: 'local' };
  } catch (e1) {
    const container = process.env.MQTT_DOCKER_CONTAINER || 'plciot-mqtt';
    try {
      execFileSync('docker', [
        'exec', container, 'mosquitto_passwd', '-b', '/mosquitto/config/passwd', user, password,
      ], { stdio: 'pipe' });
      return { ok: true, via: 'docker' };
    } catch (e2) {
      return { ok: false, error: e2.message || e1.message || 'mosquitto_passwd failed' };
    }
  }
}

export function reloadMosquitto() {
  const container = process.env.MQTT_DOCKER_CONTAINER || 'plciot-mqtt';
  try {
    execFileSync('docker', ['kill', '-s', 'HUP', container], { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    // Image không có lệnh docker: gọi thẳng Docker API qua socket (tín hiệu HUP để broker nạp lại passwd/acl).
    const sock = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
    if (!fs.existsSync(sock)) return { ok: false, error: e.message };
    const req = http.request({ socketPath: sock, method: 'POST', path: `/containers/${encodeURIComponent(container)}/kill?signal=HUP` },
      (res) => { res.resume(); });
    req.on('error', (err) => console.error('mosquitto reload', err.message));
    req.end();
    return { ok: true, via: 'socket' };
  }
}

/**
 * Provision (or rotate) per-user MQTT credentials scoped to site/device.
 * Stores mqtt_user + mqtt_pass on the user row; rebuilds ACL; HUPs broker when possible.
 */
export function provisionUserMqtt(db, user, { site, device, rotate = false } = {}) {
  const u = typeof user === 'object' ? user : db.prepare('SELECT * FROM users WHERE id = ?').get(user);
  if (!u) throw new Error('user_not_found');
  const siteName = site || u.notify_site || 'factory1';
  const deviceName = device || u.notify_device || 'plc01';
  const mqttUser = u.mqtt_user || mqttUsernameFor(u.id);
  let mqttPass = u.mqtt_pass;
  if (rotate || !mqttPass) mqttPass = randomMqttPassword();

  db.prepare(`
    UPDATE users
    SET mqtt_user = ?, mqtt_pass = ?, notify_site = ?, notify_device = ?
    WHERE id = ?
  `).run(mqttUser, mqttPass, siteName, deviceName, u.id);

  const pw = setMosquittoPassword(mqttUser, mqttPass);
  rebuildAclFromUsers(db);
  const reload = reloadMosquitto();

  return {
    user: findFresh(db, u.id),
    provision: { password: pw, reload },
  };
}

function findFresh(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function mqttClientConfig(user) {
  if (!user?.mqtt_user || !user?.mqtt_pass) return null;
  return {
    user: user.mqtt_user,
    pass: user.mqtt_pass,
    scopes: userScopes(user),
    canControl: user.role !== 'viewer',
    site: user.notify_site,
    device: user.notify_device,
    topicBase: `plc/${user.notify_site}/${user.notify_device}`,
  };
}
