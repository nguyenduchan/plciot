import fs from 'fs';
import crypto from 'crypto';
import { findUserById, findUserByUsername } from './db.js';
import { hashPassword } from './auth.js';
import { resolveBundleRoot } from './bundle.js';
import { solutionOf, solutionVersion, writeSolution, isKnownSolution, listSolutions, defaultSolution } from './solutions.js';
import {
  provisionUserMqtt, rebuildAclFromUsers, reloadMosquitto,
  setMosquittoPassword, randomMqttPassword,
} from './mqttProvision.js';
import { ROLES, MONITOR_SCOPES, isRole, userScopes, parseScopes, canPromoteToAdmin } from './roles.js';
import { audit } from '@plciot/security';
import { applyDefaultSubscription } from './entitlements.js';
import { purgeUserAccount } from './accountData.js';
import { sealMqttPass } from './mqttProvision.js';

const SAFE = /^[a-zA-Z0-9_-]{1,48}$/;
const USER_RE = /^[a-zA-Z0-9_]{3,48}$/;

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    scopes: userScopes(u),
    site: u.notify_site,
    device: u.notify_device,
    disabled: !!u.disabled,
    solution: u.solution || '',
    createdAt: u.created_at,
  };
}

export { listSolutions, defaultSolution };

export function listUsers(db) {
  return db.prepare('SELECT * FROM users WHERE setup_complete != 0 ORDER BY id').all().map(publicUser);
}

const activeAdmins = (db) => db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0").get().n;

function syncBroker(db) {
  rebuildAclFromUsers(db);
  return reloadMosquitto();
}

export function createUser(db, admin, body, { dataDir, webappSrc, ip }) {
  const { role = 'operator', site, device = 'plc01' } = body;
  const scopes = body.scopes === undefined ? null : parseScopes(body.scopes);
  if (body.scopes !== undefined && !scopes) return { error: 'invalid_scopes', status: 400 };
  let username = String(body.username || '').trim();
  if (!username) username = `u_${crypto.randomBytes(6).toString('hex')}`;
  if (!USER_RE.test(username)) return { error: 'invalid_username', status: 400 };
  if (!isRole(role)) return { error: 'invalid_role', status: 400 };
  if (role === 'admin' && !canPromoteToAdmin(username)) return { error: 'admin_not_allowlisted', status: 403 };
  const siteName = String(site || `d_${username}`);
  const dev = String(device || 'plc01');
  if (!SAFE.test(siteName) || !SAFE.test(dev)) return { error: 'invalid_site_or_device', status: 400 };
  if (findUserByUsername(db, username)) return { error: 'username_in_use', status: 409 };
  if (!fs.existsSync(webappSrc)) return { error: 'webapp_src_missing', status: 500 };
  const solution = String(body.solution || '').trim();
  if (solution && !isKnownSolution(webappSrc, solution)) return { error: 'invalid_solution', status: 400 };

  const folder = `u_${username}`;
  const eff = solutionOf(webappSrc, { solution });
  writeSolution(webappSrc, eff, resolveBundleRoot(dataDir, folder));
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, folder_path, version, notify_site, notify_device, role, created_by, setup_complete, solution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(username, hashPassword(crypto.randomBytes(24).toString('hex')), folder, solutionVersion(webappSrc, eff), siteName, dev, role, admin.id, solution);
  if (scopes) db.prepare('UPDATE users SET monitor_scopes = ? WHERE id = ?').run(scopes.join(','), info.lastInsertRowid);
  const { user } = provisionUserMqtt(db, findUserById(db, info.lastInsertRowid), { site: siteName, device: dev });
  applyDefaultSubscription(db, user.id);
  const fresh = findUserById(db, user.id);
  audit(db, 'admin_user_create', { userId: admin.id, ip, detail: `${user.id} ${role} ${siteName}/${dev}` });
  return { ok: true, user: publicUser(fresh) };
}

export function updateUser(db, admin, id, patch, { ip, shellDir, dataDir }) {
  const u = findUserById(db, id);
  if (!u) return { error: 'user_not_found', status: 404 };
  const self = u.id === admin.id;
  const sets = [];
  const vals = [];
  let revoke = false;
  let rotateMqtt = false;
  let applySolution = false;

  if (patch.role !== undefined) {
    if (!isRole(patch.role)) return { error: 'invalid_role', status: 400 };
    if (u.role === 'admin' && patch.role !== 'admin' && (self || activeAdmins(db) <= 1)) {
      return { error: 'last_admin', status: 409 };
    }
    if (patch.role === 'admin' && !canPromoteToAdmin(u.username)) {
      return { error: 'admin_not_allowlisted', status: 403 };
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
    rotateMqtt = true;
  }
  if (patch.scopes !== undefined) {
    const sc = parseScopes(patch.scopes);
    if (!sc) return { error: 'invalid_scopes', status: 400 };
    sets.push('monitor_scopes = ?'); vals.push(sc.join(','));
  }
  if (patch.solution !== undefined) {
    const sol = String(patch.solution || '').trim();
    if (shellDir && sol && !isKnownSolution(shellDir, sol)) return { error: 'invalid_solution', status: 400 };
    sets.push('solution = ?'); vals.push(sol);
    applySolution = true;
  }
  if (patch.revokeSessions) revoke = true;
  if (!sets.length) return { error: 'nothing_to_update', status: 400 };
  if (revoke) sets.push('token_version = token_version + 1');
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, u.id);

  if (rotateMqtt && u.mqtt_user) {
    const np = randomMqttPassword();
    db.prepare('UPDATE users SET mqtt_pass = ? WHERE id = ?').run(sealMqttPass(np), u.id);
    setMosquittoPassword(u.mqtt_user, np);
  }
  if (applySolution && shellDir && dataDir && u.folder_path) {   // đổi giải pháp: thay bundle ngay (điện thoại thấy version mới ở lần mở kế)
    const eff = solutionOf(shellDir, { solution: String(patch.solution || '').trim() });
    writeSolution(shellDir, eff, resolveBundleRoot(dataDir, u.folder_path));
    db.prepare('UPDATE users SET version = ? WHERE id = ?').run(solutionVersion(shellDir, eff), u.id);
  }
  const reload = syncBroker(db);
  audit(db, 'admin_user_update', {
    userId: admin.id, ip, detail: `${u.id} ${Object.keys(patch).join(',')}`,
  });
  return { ok: true, user: publicUser(findUserById(db, u.id)), reload };
}

/**
 * Mapping 1-1 webapp ↔ gateway: user vừa quét QR của gateway có giải pháp X mà CHƯA đặt giải pháp riêng (và mặc định là bản cơ bản)
 * → webapp của user chuyển sang X (bundle thay ngay). User đã được admin đặt giải pháp thì giữ nguyên. Trả giải pháp đã áp dụng hoặc ''.
 */
export function adoptSolution(db, userId, solution, { shellDir, dataDir } = {}) {
  const sol = String(solution || '').trim();
  if (!sol || !shellDir || !dataDir) return '';
  const u = findUserById(db, userId);
  if (!u || String(u.solution || '').trim() || defaultSolution() !== 'basic' || !u.folder_path) return '';
  if (!isKnownSolution(shellDir, sol)) return '';
  db.prepare('UPDATE users SET solution = ? WHERE id = ?').run(sol, u.id);
  const eff = solutionOf(shellDir, { solution: sol });
  writeSolution(shellDir, eff, resolveBundleRoot(dataDir, u.folder_path));
  db.prepare('UPDATE users SET version = ? WHERE id = ?').run(solutionVersion(shellDir, eff), u.id);
  audit(db, 'user_solution_adopted', { userId: u.id, detail: sol });
  return sol;
}

export function deleteUser(db, admin, id, { ip, dataDir }) {
  const u = findUserById(db, id);
  if (!u) return { error: 'user_not_found', status: 404 };
  if (u.id === admin.id || (u.role === 'admin' && activeAdmins(db) <= 1 && !u.disabled)) {
    return { error: 'last_admin', status: 409 };
  }
  return purgeUserAccount(db, u, {
    wipeHistory: true,
    removeBundle: true,
    dataDir,
    actorId: admin.id,
    ip,
    reason: 'admin_user_delete',
  });
}

export function purgeIncompleteUsers(db, maxAgeHours = 24) {
  const rows = db.prepare("SELECT * FROM users WHERE setup_complete = 0 AND created_at < datetime('now', ?)").all(`-${maxAgeHours} hours`);
  for (const u of rows) {
    purgeUserAccount(db, u, {
      wipeHistory: false,
      removeBundle: true,
      reason: 'setup_incomplete_purged',
    });
  }
  return rows.length;
}

/** ADMIN_USERNAMES="alice,bob" — luôn nâng role=admin. */
export function applyBootstrapAdmins(db) {
  // PHASE TEST: TEST_ADMIN_USERNAMES gộp thêm vào danh sách admin tạm thời. PRODUCTION: để trống.
  const list = String((process.env.ADMIN_USERNAMES || process.env.ADMIN_PHONES || '') + ',' + (process.env.TEST_ADMIN_USERNAMES || ''))
    .split(',').map((s) => s.trim()).filter(Boolean);
  let n = 0;
  for (const name of list) {
    n += db.prepare("UPDATE users SET role = 'admin' WHERE username = ? COLLATE NOCASE AND role != 'admin'").run(name).changes;
  }
  if (n) console.log(`ADMIN_USERNAMES: ${n} user(s) promoted to admin`);
  return n;
}

export { ROLES, MONITOR_SCOPES };
