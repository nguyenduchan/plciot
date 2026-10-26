import fs from 'fs';
import { findUserById, findUserByPhone } from './db.js';
import { hashPassword } from './auth.js';
import { copyDir, resolveBundleRoot } from './bundle.js';
import { normalizePhone, isValidVnPhone, formatVnLocal } from './phone.js';
import {
  provisionUserMqtt, rebuildAclFromUsers, reloadMosquitto,
  setMosquittoPassword, randomMqttPassword,
} from './mqttProvision.js';
import { ROLES, MONITOR_SCOPES, isRole, userScopes, parseScopes } from './roles.js';
import { audit } from './audit.js';

const SAFE = /^[a-zA-Z0-9_-]{1,48}$/;
const MIN_PASS = 8;

export function publicUser(u) {
  return {
    id: u.id,
    phone: u.phone || u.username,
    phoneLocal: formatVnLocal(u.phone || u.username),
    role: u.role,
    scopes: userScopes(u),
    site: u.notify_site,
    device: u.notify_device,
    disabled: !!u.disabled,
    createdAt: u.created_at,
    telegramLinked: !!u.chat_id,
  };
}

export function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser);
}

const activeAdmins = (db) => db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0").get().n;

function syncBroker(db) {
  rebuildAclFromUsers(db);
  return reloadMosquitto();
}

export function createUser(db, admin, body, { dataDir, webappSrc, ip }) {
  const { phone, password, role = 'operator', site, device = 'plc01' } = body;
  const scopes = body.scopes === undefined ? null : parseScopes(body.scopes);
  if (body.scopes !== undefined && !scopes) return { error: 'invalid_scopes', status: 400 };
  const p = normalizePhone(phone);
  if (!isValidVnPhone(p)) return { error: 'invalid_phone', status: 400 };
  if (!isRole(role)) return { error: 'invalid_role', status: 400 };
  if (String(password || '').length < MIN_PASS) return { error: 'weak_password', status: 400 };
  const siteName = String(site || `s${p}`);
  const dev = String(device || 'plc01');
  if (!SAFE.test(siteName) || !SAFE.test(dev)) return { error: 'invalid_site_or_device', status: 400 };
  if (findUserByPhone(db, p)) return { error: 'phone_in_use', status: 409 };
  if (!fs.existsSync(webappSrc)) return { error: 'webapp_src_missing', status: 500 };

  const folder = `u${p}`;
  copyDir(webappSrc, resolveBundleRoot(dataDir, folder));
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, folder_path, version, phone, notify_site, notify_device, role, created_by)
    VALUES (?, ?, ?, '1', ?, ?, ?, ?, ?)
  `).run(p, hashPassword(password), folder, p, siteName, dev, role, admin.id);
  if (scopes) db.prepare('UPDATE users SET monitor_scopes = ? WHERE id = ?').run(scopes.join(','), info.lastInsertRowid);
  const { user, provision } = provisionUserMqtt(db, findUserById(db, info.lastInsertRowid), { site: siteName, device: dev });
  audit(db, 'admin_user_create', { userId: admin.id, ip, detail: `${user.id} ${role} ${siteName}/${dev}` });
  return { ok: true, user: publicUser(user), provision };
}

export function updateUser(db, admin, id, patch, { ip }) {
  const u = findUserById(db, id);
  if (!u) return { error: 'user_not_found', status: 404 };
  const self = u.id === admin.id;
  const sets = [];
  const vals = [];
  let revoke = false;
  let rotateMqtt = false;

  if (patch.role !== undefined) {
    if (!isRole(patch.role)) return { error: 'invalid_role', status: 400 };
    if (u.role === 'admin' && patch.role !== 'admin' && (self || activeAdmins(db) <= 1)) {
      return { error: 'last_admin', status: 409 };
    }
    sets.push('role = ?'); vals.push(patch.role);
  }
  if (patch.disabled !== undefined) {
    const d = patch.disabled ? 1 : 0;
    if (d && (self || (u.role === 'admin' && activeAdmins(db) <= 1))) return { error: 'last_admin', status: 409 };
    sets.push('disabled = ?'); vals.push(d);
    if (d) { revoke = true; rotateMqtt = true; }
  }
  if (patch.site !== undefined || patch.device !== undefined) {
    const site = String(patch.site ?? u.notify_site);
    const dev = String(patch.device ?? u.notify_device);
    if (!SAFE.test(site) || !SAFE.test(dev)) return { error: 'invalid_site_or_device', status: 400 };
    sets.push('notify_site = ?', 'notify_device = ?'); vals.push(site, dev);
    rotateMqtt = true; // thu hồi mật khẩu MQTT đang giữ quyền trên site cũ
  }
  if (patch.scopes !== undefined) {
    const sc = parseScopes(patch.scopes);
    if (!sc) return { error: 'invalid_scopes', status: 400 };
    sets.push('monitor_scopes = ?'); vals.push(sc.join(','));
  }
  if (patch.password !== undefined) {
    if (String(patch.password).length < MIN_PASS) return { error: 'weak_password', status: 400 };
    sets.push('password_hash = ?'); vals.push(hashPassword(String(patch.password)));
    revoke = true;
  }
  if (!sets.length) return { error: 'nothing_to_update', status: 400 };
  if (revoke) sets.push('token_version = token_version + 1');
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, u.id);

  if (rotateMqtt && u.mqtt_user) {
    const np = randomMqttPassword();
    db.prepare('UPDATE users SET mqtt_pass = ? WHERE id = ?').run(np, u.id);
    setMosquittoPassword(u.mqtt_user, np);
  }
  const reload = syncBroker(db);
  audit(db, 'admin_user_update', {
    userId: admin.id, ip, detail: `${u.id} ${Object.keys(patch).filter((k) => k !== 'password').join(',')}${patch.password ? ',password' : ''}`,
  });
  return { ok: true, user: publicUser(findUserById(db, u.id)), reload };
}

export function deleteUser(db, admin, id, { ip }) {
  const u = findUserById(db, id);
  if (!u) return { error: 'user_not_found', status: 404 };
  if (u.id === admin.id || (u.role === 'admin' && activeAdmins(db) <= 1 && !u.disabled)) {
    return { error: 'last_admin', status: 409 };
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
  if (u.mqtt_user) setMosquittoPassword(u.mqtt_user, randomMqttPassword());
  const reload = syncBroker(db);
  audit(db, 'admin_user_delete', { userId: admin.id, ip, detail: `${u.id} ${u.phone || u.username}` });
  return { ok: true, reload };
}

/** ADMIN_PHONES="0912345678,0987654321": các số này luôn là admin (bootstrap). */
export function applyBootstrapAdmins(db) {
  const list = String(process.env.ADMIN_PHONES || '').split(',').map((s) => normalizePhone(s.trim())).filter(Boolean);
  let n = 0;
  for (const p of list) {
    n += db.prepare("UPDATE users SET role = 'admin' WHERE (phone = ? OR username = ?) AND role != 'admin'").run(p, p).changes;
  }
  if (n) console.log(`ADMIN_PHONES: ${n} user(s) promoted to admin`);
  return n;
}

export { ROLES, MONITOR_SCOPES };
