import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { sealSecret, openSecret } from '@plciot/security';
import { userScopes } from './roles.js';
import {
  GW_NS, DEFAULT_TENANT, isValidMqttId,
  sanitizeId, topicBase, mqttPublicEndpoints, contractInfo,
} from './contract.js';
import { mqttIdFor, gatewaysOfUser } from './mqttIds.js';

/** Lưu mqtt_pass dạng AES-GCM (v1.…); plaintext cũ vẫn đọc được và được reseal khi ghi lại. */
export function sealMqttPass(plain) {
  if (!plain) return plain;
  if (String(plain).startsWith('v1.')) return plain;
  return sealSecret(String(plain));
}

export function openMqttPass(stored) {
  if (!stored) return null;
  const s = String(stored);
  if (s.startsWith('v1.')) return openSecret(s);
  return s;
}

// Hai file ACL cho hai nhóm listener của Mosquitto (per_listener_settings):
//   acl          — listener đã mã hoá (qua TLS): monitor + control tuỳ vai trò
//   acl-monitor  — listener KHÔNG mã hoá: chỉ monitor, không ai (trừ gateway) được ghi cmd
// Topic duy nhất: gw/{mqttId}/{kind} — mqttId là id ngẫu nhiên server cấp cho gateway (devices.mqtt_id).
const DEVICE_WRITE_KINDS = ['telemetry', 'status', 'ack', 'history', 'config'];

function staticHeader(secure) {
  const lines = [
    '# plciot ACL — static roles (do not put per-user lines above MARKER)',
    // KHÔNG có role dùng chung (gw/edge) ghi gw/+/…: mỗi gateway có tài khoản riêng khoá vào gw/<mqttId>/# (deviceAclBlock)
  ];
  if (secure) {
    lines.push('user ctl');
    lines.push(`topic write ${GW_NS}/+/cmd`);
    lines.push('');
  }
  lines.push('user ingest');
  lines.push(...DEVICE_WRITE_KINDS.map((k) => `topic read ${GW_NS}/+/${k}`));
  lines.push('');
  lines.push('# MARKER_USER_ACL');
  lines.push('');
  return lines.join('\n');
}

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

export function randomMqttPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

/** true (mặc định): điện thoại KHÔNG ghi cmd trực tiếp; lệnh đi qua /api/control/cmd để kiểm tra step-up. */
export const controlViaServer = () => String(process.env.CONTROL_VIA_SERVER || 'true').toLowerCase() !== 'false';

export function mqttUsernameFor(userId) {
  return `u${userId}`;
}

/**
 * ACL block: user chỉ đọc được topic của các gateway (mqttId) mà họ được xem.
 * @param {string[]} mqttIds id MQTT của gateway user được xem (devices.mqtt_id)
 * @param {string[]} scopes nhóm topic được đọc (monitor)
 * @param {boolean} secure true = listener mã hoá (cho phép control theo vai trò); false = chỉ monitor
 */
export function userAclBlock(mqttUser, mqttIds, role = 'operator', scopes = ['telemetry', 'status', 'ack', 'history'], secure = true) {
  const u = sanitizeId(mqttUser);
  const control = secure && role !== 'viewer';
  const directWrite = control && !controlViaServer();
  const readKinds = ['telemetry', 'status', 'ack', 'history', 'config'].filter((k) => scopes.includes(k) || (control && k === 'ack') || (k === 'config' && scopes.includes('telemetry')));
  const lines = [`user ${u}`];
  for (const id of (mqttIds || []).filter(isValidMqttId)) {
    const base = topicBase({ mqttId: id });
    for (const k of readKinds) lines.push(`topic read ${base}/${k}`);
    if (directWrite) lines.push(`topic write ${base}/cmd`);
  }
  lines.push('');
  return lines.join('\n');
}

/** ACL cho gateway/thiết bị IoT: chỉ ghi vào topic CỦA id mình (telemetry/status/…), đọc cmd của id mình. */
export function deviceAclBlock(mqttUser, { mqttId }) {
  const u = sanitizeId(mqttUser);
  const base = topicBase({ mqttId });
  const lines = [
    `user ${u}`,
    ...DEVICE_WRITE_KINDS.map((k) => `topic write ${base}/${k}`),
    `topic read ${base}/cmd`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Rebuild acl file from DB users + devices.
 * Keeps gw + ingest (+ ctl trên kênh mã hoá); drops shared wildcard "app".
 */
export function rebuildAclFromUsers(db) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const users = db.prepare(`
    SELECT id, mqtt_user, notify_site, notify_device, role, monitor_scopes, tenant_id FROM users
    WHERE mqtt_user IS NOT NULL AND mqtt_user != '' AND disabled = 0
  `).all();
  let devices = [];
  try {
    devices = db.prepare(`
      SELECT mqtt_user, tenant_id, site, device, mqtt_id FROM devices
      WHERE mqtt_user IS NOT NULL AND mqtt_user != '' AND mqtt_id IS NOT NULL AND status = 'active'
    `).all();
  } catch {
    devices = [];
  }
  let secure = staticHeader(true);
  let plain = staticHeader(false);
  for (const u of users) {
    const scopes = userScopes(u);
    const tenant = u.tenant_id || DEFAULT_TENANT;
    const ids = gatewaysOfUser(db, { ...u, tenant_id: tenant }).map((g) => g.mqttId).filter(Boolean);   // mọi gateway user đã thêm
    secure += userAclBlock(u.mqtt_user, ids, u.role, scopes, true);
    plain += userAclBlock(u.mqtt_user, ids, u.role, scopes, false);
  }
  for (const d of devices) {
    const block = deviceAclBlock(d.mqtt_user, { mqttId: d.mqtt_id });
    // Thiết bị được publish trên cả listener (monitor-only vẫn nhận telemetry)
    secure += block;
    plain += block;
  }
  fs.writeFileSync(aclPath(), secure, 'utf8');
  fs.writeFileSync(aclMonitorPath(), plain, 'utf8');
  return users.length + devices.length;
}

/** Set/update password in mosquitto passwd (shared config volume). */
export function setMosquittoPassword(username, password) {
  const user = sanitizeId(username, 60);
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
export function provisionUserMqtt(db, user, { site, device, rotate = false, tenant } = {}) {
  const u = typeof user === 'object' ? user : db.prepare('SELECT * FROM users WHERE id = ?').get(user);
  if (!u) throw new Error('user_not_found');
  const siteName = site || u.notify_site || 'factory1';
  const deviceName = device || u.notify_device || 'plc01';
  const tenantId = tenant || u.tenant_id || DEFAULT_TENANT;
  const mqttUser = u.mqtt_user || mqttUsernameFor(u.id);
  let mqttPassPlain = openMqttPass(u.mqtt_pass);
  if (rotate || !mqttPassPlain) mqttPassPlain = randomMqttPassword();
  const mqttPassStored = sealMqttPass(mqttPassPlain);

  db.prepare(`
    UPDATE users
    SET mqtt_user = ?, mqtt_pass = ?, notify_site = ?, notify_device = ?, tenant_id = ?
    WHERE id = ?
  `).run(mqttUser, mqttPassStored, siteName, deviceName, tenantId, u.id);

  const pw = setMosquittoPassword(mqttUser, mqttPassPlain);
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

export function mqttClientConfig(db, user) {
  const pass = openMqttPass(user?.mqtt_pass);
  if (!user?.mqtt_user || !pass) return null;
  const tenant = user.tenant_id || DEFAULT_TENANT;
  const mqttId = mqttIdFor(db, tenant, user.notify_site, user.notify_device);   // id ngẫu nhiên của gateway user đang xem
  const base = mqttId ? topicBase({ mqttId }) : null;
  return {
    user: user.mqtt_user,
    pass,
    scopes: userScopes(user),
    canControl: user.role !== 'viewer',
    controlVia: controlViaServer() ? 'server' : 'mqtt',
    site: user.notify_site,
    device: user.notify_device,
    tenant,
    mqttId,
    topicBase: base,
    topicBases: [...new Set([base, ...gatewaysOfUser(db, user).map((g) => (g.mqttId ? topicBase({ mqttId: g.mqttId }) : null))].filter(Boolean))],   // mọi gateway user đã thêm
    endpoints: mqttPublicEndpoints(),
    contract: contractInfo(),
  };
}
