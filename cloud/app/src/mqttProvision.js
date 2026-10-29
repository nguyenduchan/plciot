import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { userScopes } from './roles.js';
import {
  LEGACY_NS, PLATFORM_NS, DEFAULT_TENANT, dualNamespace, preferredNamespace,
  sanitizeId, topicBase, topicBases, mqttPublicEndpoints, contractInfo,
} from './contract.js';

// Hai file ACL cho hai nhóm listener của Mosquitto (per_listener_settings):
//   acl          — listener đã mã hoá (qua TLS): monitor + control tuỳ vai trò
//   acl-monitor  — listener KHÔNG mã hoá: chỉ monitor, không ai (trừ gateway) được ghi cmd
// Hỗ trợ cả plc/{site}/{device} và iot/{tenant}/{site}/{device}.
function staticHeader(secure) {
  const lines = [
    '# plciot ACL — static roles (do not put per-user lines above MARKER)',
    'user gw',
    ...deviceWriteAcl(LEGACY_NS),
    ...(dualNamespace() || preferredNamespace() === PLATFORM_NS ? deviceWriteAcl(PLATFORM_NS) : []),
    '',
    'user edge',
    ...deviceWriteAcl(LEGACY_NS),
    ...(dualNamespace() || preferredNamespace() === PLATFORM_NS ? deviceWriteAcl(PLATFORM_NS) : []),
    '',
  ];
  if (secure) {
    lines.push('user ctl');
    lines.push(`topic write ${LEGACY_NS}/+/+/cmd`);
    if (dualNamespace() || preferredNamespace() === PLATFORM_NS) {
      lines.push(`topic write ${PLATFORM_NS}/+/+/+/cmd`);
    }
    lines.push('');
  }
  lines.push('user ingest');
  lines.push(...ingestReadAcl(LEGACY_NS));
  if (dualNamespace() || preferredNamespace() === PLATFORM_NS) {
    lines.push(...ingestReadAcl(PLATFORM_NS));
  }
  lines.push('');
  lines.push('# MARKER_USER_ACL');
  lines.push('');
  return lines.join('\n');
}

function deviceWriteAcl(ns) {
  const kinds = ['telemetry', 'status', 'ack', 'history'];
  if (ns === LEGACY_NS) {
    return [
      ...kinds.map((k) => `topic write ${LEGACY_NS}/+/+/${k}`),
      `topic read ${LEGACY_NS}/+/+/cmd`,
    ];
  }
  return [
    ...kinds.map((k) => `topic write ${PLATFORM_NS}/+/+/+/${k}`),
    `topic read ${PLATFORM_NS}/+/+/+/cmd`,
  ];
}

function ingestReadAcl(ns) {
  const kinds = ['telemetry', 'status', 'ack', 'history'];
  if (ns === LEGACY_NS) return kinds.map((k) => `topic read ${LEGACY_NS}/+/+/${k}`);
  return kinds.map((k) => `topic read ${PLATFORM_NS}/+/+/+/${k}`);
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
 * ACL block: user may only touch their site/device (và tenant nếu dual/iot).
 * @param {string[]} scopes nhóm topic được đọc (monitor)
 * @param {boolean} secure true = listener mã hoá (cho phép control theo vai trò); false = chỉ monitor
 */
export function userAclBlock(mqttUser, site, device, role = 'operator', scopes = ['telemetry', 'status', 'ack', 'history'], secure = true, tenant = DEFAULT_TENANT) {
  const u = sanitizeId(mqttUser);
  const bases = topicBases({ tenant, site, device, ns: preferredNamespace() });
  const control = secure && role !== 'viewer';
  const directWrite = control && !controlViaServer();
  const readKinds = ['telemetry', 'status', 'ack', 'history'].filter((k) => scopes.includes(k) || (control && k === 'ack'));
  const lines = [`user ${u}`];
  for (const base of bases) {
    for (const k of readKinds) lines.push(`topic read ${base}/${k}`);
    if (directWrite) lines.push(`topic write ${base}/cmd`);
  }
  lines.push('');
  return lines.join('\n');
}

/** ACL cho thiết bị IoT (chỉ publish telemetry/status/…, đọc cmd). */
export function deviceAclBlock(mqttUser, { tenant, site, device, topicNs }) {
  const u = sanitizeId(mqttUser);
  const base = topicBase({ ns: topicNs || PLATFORM_NS, tenant, site, device });
  const lines = [
    `user ${u}`,
    `topic write ${base}/telemetry`,
    `topic write ${base}/status`,
    `topic write ${base}/ack`,
    `topic write ${base}/history`,
    `topic read ${base}/cmd`,
  ];
  // Dual: cho phép legacy song song nếu thiết bị khai báo iot (firmware cũ thử plc/)
  if (dualNamespace() && (topicNs || PLATFORM_NS) === PLATFORM_NS) {
    const legacy = topicBase({ ns: LEGACY_NS, site, device });
    lines.push(
      `topic write ${legacy}/telemetry`,
      `topic write ${legacy}/status`,
      `topic write ${legacy}/ack`,
      `topic write ${legacy}/history`,
      `topic read ${legacy}/cmd`,
    );
  }
  lines.push('');
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
      SELECT mqtt_user, tenant_id, site, device, topic_ns FROM devices
      WHERE mqtt_user IS NOT NULL AND mqtt_user != '' AND status = 'active'
    `).all();
  } catch {
    devices = [];
  }
  let secure = staticHeader(true);
  let plain = staticHeader(false);
  for (const u of users) {
    const scopes = userScopes(u);
    const tenant = u.tenant_id || DEFAULT_TENANT;
    secure += userAclBlock(u.mqtt_user, u.notify_site, u.notify_device, u.role, scopes, true, tenant);
    plain += userAclBlock(u.mqtt_user, u.notify_site, u.notify_device, u.role, scopes, false, tenant);
  }
  for (const d of devices) {
    const block = deviceAclBlock(d.mqtt_user, {
      tenant: d.tenant_id, site: d.site, device: d.device, topicNs: d.topic_ns,
    });
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
  let mqttPass = u.mqtt_pass;
  if (rotate || !mqttPass) mqttPass = randomMqttPassword();

  db.prepare(`
    UPDATE users
    SET mqtt_user = ?, mqtt_pass = ?, notify_site = ?, notify_device = ?, tenant_id = ?
    WHERE id = ?
  `).run(mqttUser, mqttPass, siteName, deviceName, tenantId, u.id);

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
  const tenant = user.tenant_id || DEFAULT_TENANT;
  const ns = preferredNamespace();
  const base = topicBase({ ns, tenant, site: user.notify_site, device: user.notify_device });
  return {
    user: user.mqtt_user,
    pass: user.mqtt_pass,
    scopes: userScopes(user),
    canControl: user.role !== 'viewer',
    controlVia: controlViaServer() ? 'server' : 'mqtt',
    site: user.notify_site,
    device: user.notify_device,
    tenant,
    topicNs: ns,
    topicBase: base,
    topicBases: topicBases({ tenant, site: user.notify_site, device: user.notify_device, ns }),
    endpoints: mqttPublicEndpoints(),
    contract: contractInfo(),
  };
}
