/**
 * Đăng ký tenant (công ty solution) + thiết bị IoT MQTTS.
 * User app (điện thoại) vẫn dùng users.notify_*; thiết bị gateway/partner dùng bảng devices.
 */
import crypto from 'crypto';
import {
  DEFAULT_TENANT, PLATFORM_NS, LEGACY_NS,
  isValidId, sanitizeId, hashApiKey, randomApiKey, topicBase, topicBases, mqttPublicEndpoints, withSchema,
} from './contract.js';
import { randomMqttPassword, setMosquittoPassword, rebuildAclFromUsers, reloadMosquitto } from './mqttProvision.js';
import { PROFILES, listProfiles } from './profiles.js';

export function ensureDefaultTenant(db) {
  const row = db.prepare('SELECT id FROM tenants WHERE id = ?').get(DEFAULT_TENANT);
  if (row) return row;
  db.prepare(`
    INSERT INTO tenants (id, name, profile, created_at)
    VALUES (?, ?, ?, ?)
  `).run(DEFAULT_TENANT, 'Default', 'conveyor-v1', Date.now());
  return { id: DEFAULT_TENANT };
}

export function listTenants(db) {
  return db.prepare(`
    SELECT t.id, t.name, t.profile, t.created_at,
      (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id AND d.status = 'active') AS devices
    FROM tenants t ORDER BY t.id
  `).all();
}

export function getTenant(db, id) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

/** Tạo tenant; trả apiKey một lần (chỉ lúc tạo/rotate). */
export function createTenant(db, { id, name, profile = 'conveyor-v1' } = {}) {
  // Từ chối trước khi sanitize (tránh 'bad/id' → 'bad_id' lách kiểm tra)
  if (!isValidId(id)) return { error: 'invalid_tenant_id', status: 400 };
  const tid = sanitizeId(id);
  if (profile && !PROFILES[profile]) return { error: 'unknown_profile', status: 400 };
  const existing = getTenant(db, tid);
  if (existing) {
    // Tenant 'default' có sẵn lúc migrate: lần đầu gắn API key thay vì báo trùng
    if (tid === DEFAULT_TENANT && !existing.api_key_hash) {
      const apiKey = randomApiKey();
      db.prepare('UPDATE tenants SET name = COALESCE(?, name), profile = ?, api_key_hash = ? WHERE id = ?')
        .run(name ? String(name).slice(0, 120) : null, profile || existing.profile, hashApiKey(apiKey), tid);
      return { ok: true, tenant: publicTenant(getTenant(db, tid)), apiKey, profiles: listProfiles() };
    }
    return { error: 'tenant_exists', status: 409 };
  }
  const apiKey = randomApiKey();
  db.prepare(`
    INSERT INTO tenants (id, name, profile, api_key_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tid, String(name || tid).slice(0, 120), profile || 'conveyor-v1', hashApiKey(apiKey), Date.now());
  return { ok: true, tenant: publicTenant(getTenant(db, tid)), apiKey, profiles: listProfiles() };
}

export function rotateTenantKey(db, tenantId) {
  const t = getTenant(db, tenantId);
  if (!t) return { error: 'not_found', status: 404 };
  const apiKey = randomApiKey();
  db.prepare('UPDATE tenants SET api_key_hash = ? WHERE id = ?').run(hashApiKey(apiKey), t.id);
  return { ok: true, tenant: publicTenant(getTenant(db, t.id)), apiKey };
}

export function findTenantByApiKey(db, rawKey) {
  if (!rawKey) return null;
  const h = hashApiKey(rawKey);
  return db.prepare('SELECT * FROM tenants WHERE api_key_hash = ?').get(h) || null;
}

function publicTenant(t) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    profile: t.profile,
    createdAt: t.created_at,
    hasApiKey: Boolean(t.api_key_hash),
  };
}

export function mqttUsernameForDevice(tenantId, site, device) {
  return sanitizeId(`d_${tenantId}_${site}_${device}`, 60);
}

/**
 * Cấp (hoặc xoay) credential MQTT cho một thiết bị thuộc tenant.
 * @returns connection kit cho firmware / edge
 */
export function provisionDevice(db, tenant, body = {}, { rotate = false, actor = 'api' } = {}) {
  const t = typeof tenant === 'string' ? getTenant(db, tenant) : tenant;
  if (!t) return { error: 'tenant_not_found', status: 404 };

  if (!isValidId(body.site) || !isValidId(body.device)) return { error: 'invalid_site_or_device', status: 400 };
  const site = sanitizeId(body.site);
  const device = sanitizeId(body.device);

  // Mặc định thiết bị partner mới → iot/; chỉ dùng plc/ khi gọi rõ ns=plc
  const topicNs = body.ns === LEGACY_NS ? LEGACY_NS : PLATFORM_NS;
  const profile = body.profile && PROFILES[body.profile] ? body.profile : (t.profile || 'conveyor-v1');
  if (body.profile && !PROFILES[body.profile]) return { error: 'unknown_profile', status: 400 };

  let row = db.prepare(
    'SELECT * FROM devices WHERE tenant_id = ? AND site = ? AND device = ?',
  ).get(t.id, site, device);

  const mqttUser = row?.mqtt_user || mqttUsernameForDevice(t.id, site, device);
  let mqttPass = row?.mqtt_pass;
  if (rotate || !mqttPass) mqttPass = randomMqttPassword();

  if (row) {
    db.prepare(`
      UPDATE devices SET mqtt_user = ?, mqtt_pass = ?, topic_ns = ?, profile = ?, status = 'active', updated_at = ?
      WHERE id = ?
    `).run(mqttUser, mqttPass, topicNs, profile, Date.now(), row.id);
  } else {
    const info = db.prepare(`
      INSERT INTO devices (tenant_id, site, device, mqtt_user, mqtt_pass, topic_ns, profile, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(t.id, site, device, mqttUser, mqttPass, topicNs, profile, Date.now(), Date.now());
    row = { id: info.lastInsertRowid };
  }

  const pw = setMosquittoPassword(mqttUser, mqttPass);
  rebuildAclFromUsers(db);
  const reload = reloadMosquitto();

  const fresh = db.prepare('SELECT * FROM devices WHERE id = ?').get(row.id);
  const base = topicBase({ ns: fresh.topic_ns, tenant: t.id, site, device });
  const endpoints = mqttPublicEndpoints();

  return {
    ok: true,
    device: {
      id: fresh.id,
      tenantId: t.id,
      site,
      device,
      topicNs: fresh.topic_ns,
      profile: fresh.profile,
      topicBase: base,
      topics: Object.fromEntries(['telemetry', 'status', 'history', 'cmd', 'ack'].map((k) => [k, `${base}/${k}`])),
      dualBases: topicBases({ tenant: t.id, site, device, ns: fresh.topic_ns }),
    },
    mqtt: {
      username: mqttUser,
      password: mqttPass,
      clientIdHint: `${mqttUser}-${crypto.randomBytes(2).toString('hex')}`,
      ...endpoints,
      useTls: true,
      qosTelemetry: 0,
      qosCmd: 1,
      retainTelemetry: true,
      retainStatus: true,
    },
    schema: withSchema({}),
    provision: { password: pw, reload, actor },
  };
}

export function listDevices(db, tenantId) {
  return db.prepare(`
    SELECT id, tenant_id AS tenantId, site, device, mqtt_user AS mqttUser,
           topic_ns AS topicNs, profile, status, created_at AS createdAt, updated_at AS updatedAt
    FROM devices WHERE tenant_id = ? ORDER BY site, device
  `).all(tenantId);
}

export function findDevice(db, tenantId, site, device) {
  return db.prepare(
    'SELECT * FROM devices WHERE tenant_id = ? AND site = ? AND device = ?',
  ).get(tenantId, sanitizeId(site), sanitizeId(device));
}

/** Tìm thiết bị theo site/device (ưu tiên tenant của user, rồi bất kỳ active). */
export function resolveDeviceForUser(db, user) {
  const site = user.notify_site;
  const device = user.notify_device;
  const tenantId = user.tenant_id || DEFAULT_TENANT;
  return findDevice(db, tenantId, site, device)
    || db.prepare(
      "SELECT * FROM devices WHERE site = ? AND device = ? AND status = 'active' ORDER BY id LIMIT 1",
    ).get(site, device)
    || null;
}

export function revokeDevice(db, tenantId, site, device) {
  const row = findDevice(db, tenantId, site, device);
  if (!row) return { error: 'not_found', status: 404 };
  const newPass = randomMqttPassword();
  db.prepare(`UPDATE devices SET status = 'revoked', mqtt_pass = ?, updated_at = ? WHERE id = ?`)
    .run(newPass, Date.now(), row.id);
  setMosquittoPassword(row.mqtt_user, newPass);
  rebuildAclFromUsers(db);
  reloadMosquitto();
  return { ok: true };
}

export { publicTenant, listProfiles };
