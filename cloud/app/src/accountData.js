/**
 * Quyền chủ thể dữ liệu: xuất hồ sơ + xoá tài khoản (cascade).
 */
import fs from 'fs';
import path from 'path';
import { audit, recoveryCodesRemaining, factorSummary } from '@plciot/security';
import { findUserById } from './db.js';
import { wipeDeviceHistory } from './retention.js';
import {
  rebuildAclFromUsers, reloadMosquitto, setMosquittoPassword, randomMqttPassword,
} from './mqttProvision.js';

const USER_TABLES = [
  'recovery_codes',
  'passkeys',
  'app_sessions',
  'control_sessions',
  'device_requests',
  'auth_devices',
  'known_devices',
  'pair_codes',
  'stations',
  'recovery_enrollments',
  'login_attempts',
];

function syncBroker(db) {
  rebuildAclFromUsers(db);
  return reloadMosquitto();
}

/** Xuất dữ liệu cá nhân gắn tài khoản (không gồm bí mật: mật khẩu, TOTP, MQTT pass). */
export function exportAccountData(db, user, { auditLimit = 500 } = {}) {
  const u = findUserById(db, user.id) || user;
  const limit = Math.min(Math.max(Number(auditLimit) || 500, 1), 5000);
  const factors = factorSummary(db, u.id);
  const passkeys = db.prepare(
    'SELECT name, created_at, last_used_at, device_id FROM passkeys WHERE user_id = ? ORDER BY id',
  ).all(u.id);
  const known = db.prepare(
    'SELECT first_seen, last_seen, last_ip FROM known_devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT 50',
  ).all(u.id);
  const stations = db.prepare(
    'SELECT id, name, kind, site, device, created_at, last_seen_at, last_ip FROM stations WHERE user_id = ?',
  ).all(u.id);
  const auditRows = db.prepare(
    'SELECT ts, event, ip, detail FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?',
  ).all(u.id, limit);
  const hw = db.prepare(
    'SELECT site, device, label, claimed_at FROM hardware_devices WHERE claimed_by = ?',
  ).all(u.id);

  return {
    ok: true,
    exportedAt: new Date().toISOString(),
    profile: {
      userId: u.id,
      username: u.username,
      role: u.role,
      site: u.notify_site,
      device: u.notify_device,
      siteOwner: Boolean(u.site_owner),
      createdAt: u.created_at,
      privacyConsentAt: u.privacy_consent_at || null,
      privacyVersion: u.privacy_version || null,
      retentionDays: u.retention_days,
      subPlan: u.sub_plan || null,
    },
    security: {
      hasPassword: Boolean(u.login_password_hash),
      totpEnabled: Boolean(u.totp_enabled),
      passkeys: factors.passkeys,
      passkeyList: passkeys,
      recoveryCodesRemaining: recoveryCodesRemaining(db, u.id),
      knownDevices: known,
      stations,
    },
    hardware: hw,
    audit: auditRows,
  };
}

/**
 * Xoá toàn bộ dữ liệu gắn user (dùng cho self-delete và admin delete).
 * @param {{ wipeHistory?: boolean, removeBundle?: boolean, dataDir?: string, actorId?: number|null, ip?: string, reason?: string }} opts
 */
export function purgeUserAccount(db, userOrId, opts = {}) {
  const u = typeof userOrId === 'object' ? userOrId : findUserById(db, userOrId);
  if (!u) return { error: 'user_not_found', status: 404 };

  const {
    wipeHistory = Boolean(u.site_owner),
    removeBundle = true,
    dataDir,
    actorId = null,
    ip = null,
    reason = 'account_deleted',
  } = opts;

  let historyDeleted = 0;
  if (wipeHistory && u.notify_site && u.notify_device) {
    const others = db.prepare(`
      SELECT COUNT(*) AS n FROM users
      WHERE id != ? AND disabled = 0 AND notify_site = ? AND notify_device = ?
    `).get(u.id, u.notify_site, u.notify_device)?.n || 0;
    if (others === 0) {
      historyDeleted = wipeDeviceHistory(db, u.notify_site, u.notify_device);
    }
  }

  db.transaction(() => {
    for (const table of USER_TABLES) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(u.id);
      } catch { /* bảng có thể chưa có */ }
    }
    try {
      db.prepare('UPDATE hardware_devices SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by = ?').run(u.id);
    } catch { /* ignore */ }
    try {
      db.prepare("UPDATE site_invites SET status = 'cancelled' WHERE invited_by = ? AND status = 'pending'").run(u.id);
    } catch { /* ignore */ }
    try {
      db.prepare('DELETE FROM admin_home_pcs WHERE user_id = ?').run(u.id);
    } catch { /* ignore */ }
    // Ẩn danh nhật ký thay vì xoá hết (có thể cần cho điều tra sự cố trong hạn lưu).
    db.prepare(`
      UPDATE audit_log SET detail = '[redacted]', ip = NULL WHERE user_id = ? AND event NOT IN ('account_purged', 'admin_user_delete')
    `).run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  })();

  if (u.mqtt_user) {
    try { setMosquittoPassword(u.mqtt_user, randomMqttPassword()); } catch { /* ignore */ }
  }
  const reload = syncBroker(db);

  if (removeBundle && dataDir && u.folder_path) {
    try {
      const root = path.join(dataDir, 'bundles', u.folder_path);
      fs.rmSync(root, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  audit(db, reason, {
    userId: actorId,
    ip,
    detail: `purged user ${u.id} ${u.username} history=${historyDeleted}`,
  });

  return { ok: true, purgedUserId: u.id, historyDeleted, reload };
}

export function deleteOwnAccount(db, user, { reauthed, ip, dataDir }) {
  if (reauthed !== true) return { error: 'invalid_credentials', status: 401 };
  if (user.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
    if (admins <= 1) return { error: 'last_admin', status: 409 };
  }
  return purgeUserAccount(db, user, {
    wipeHistory: true,
    removeBundle: true,
    dataDir,
    actorId: user.id,
    ip,
    reason: 'account_self_deleted',
  });
}
