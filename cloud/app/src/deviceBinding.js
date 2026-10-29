/**
 * Liên kết gói tin MQTT ↔ thuê bao.
 *
 * 1) Broker ACL: chỉ user MQTT đã provision mới publish được topic của mình.
 * 2) Ingest: topic phải khớp thiết bị/user đã đăng ký; gói còn hạn (tuỳ env).
 *
 * Thiết bị công nghiệp/dân dụng: MQTTS + username/password + topic cố định
 * (không cần SDK riêng) — xem docs/DEVICE-BINDING.md.
 */
import { DEFAULT_TENANT, PLATFORM_NS } from './contract.js';
import { planActive } from './entitlements.js';
import { findDevice } from './tenants.js';

export function requireKnownDevice() {
  return String(process.env.INGEST_REQUIRE_KNOWN || 'true').toLowerCase() !== 'false';
}

export function requireActiveSubscription() {
  return String(process.env.INGEST_REQUIRE_ACTIVE_SUB || 'true').toLowerCase() !== 'false';
}

/**
 * @returns {{ ok: true, source: 'device'|'user', tenantId: string, subscriber?: object }
 *          |{ ok: false, reason: string }}
 */
export function resolveSubscriber(db, { tenant, site, device, ns }) {
  const hint = tenant || DEFAULT_TENANT;

  // Ưu tiên bảng devices (partner / IoT MQTTS)
  let row = null;
  if (ns === PLATFORM_NS || hint !== DEFAULT_TENANT) {
    row = findDevice(db, hint, site, device);
  }
  if (!row) {
    row = db.prepare(
      "SELECT * FROM devices WHERE site = ? AND device = ? AND status = 'active' ORDER BY id LIMIT 1",
    ).get(site, device);
  }
  if (row && row.status === 'active') {
    const tenantRow = db.prepare('SELECT * FROM tenants WHERE id = ?').get(row.tenant_id);
    if (requireActiveSubscription()) {
      const fake = {
        sub_plan: tenantRow?.sub_plan || row.profile,
        sub_expires_at: tenantRow?.sub_expires_at ?? null,
      };
      // Tenant chưa gán gói (null): cho phép (legacy) — coi như đang dùng
      if (tenantRow?.sub_plan && !planActive(fake)) {
        return { ok: false, reason: 'tenant_plan_expired', tenantId: row.tenant_id };
      }
      if (tenantRow?.sub_expires_at != null && Number(tenantRow.sub_expires_at) <= Date.now()) {
        return { ok: false, reason: 'tenant_plan_expired', tenantId: row.tenant_id };
      }
    }
    return {
      ok: true,
      source: 'device',
      tenantId: row.tenant_id,
      deviceId: row.id,
      mqttUser: row.mqtt_user,
      topicNs: row.topic_ns,
      profile: row.profile,
    };
  }

  // App user gắn site/device (điện thoại / gateway cũ plc/)
  const users = db.prepare(`
    SELECT * FROM users
    WHERE notify_site = ? AND notify_device = ? AND disabled = 0
    ORDER BY site_owner DESC, id ASC
  `).all(site, device);

  if (!users.length) {
    if (requireKnownDevice()) return { ok: false, reason: 'unknown_device' };
    return { ok: true, source: 'anonymous', tenantId: hint };
  }

  if (requireActiveSubscription()) {
    const anyActive = users.some((u) => planActive(u));
    if (!anyActive) return { ok: false, reason: 'user_plan_expired', tenantId: users[0].tenant_id || DEFAULT_TENANT };
  }

  const owner = users.find((u) => u.site_owner) || users[0];
  return {
    ok: true,
    source: 'user',
    tenantId: owner.tenant_id || DEFAULT_TENANT,
    userId: owner.id,
    mqttUser: owner.mqtt_user,
    subscribers: users.map((u) => u.id),
  };
}
