/**
 * Phiên điều khiển (step-up), trạng thái yếu tố và hạn bắt buộc bật yếu tố.
 *   • Passkey (vân tay / Face ID): phiên ngắn (CONTROL_PASSKEY_TTL_SEC, mặc định 300 s)
 *   • TOTP (Authenticator): phiên CONTROL_TOTP_TTL_SEC (mặc định 300 s), gắn với mạng; đổi mạng → hỏi lại
 *   • PC trạm kiểu cũ: IP trong CONTROL_LAN_CIDRS + khoá do admin cấp
 * OTP qua Telegram/SMS KHÔNG phải là yếu tố điều khiển (dựa vào SIM/tài khoản chat).
 */
import crypto from 'crypto';
import { getConfig } from './config.js';
import { netOf, ipInCidrs } from './net.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const env = process.env;

export function securityConfig() {
  const shortTtl = (value) => Math.min(300_000, Math.max(30_000, (Number(value) || 300) * 1000));
  return {
    stepUp: String(env.CONTROL_STEPUP || 'true').toLowerCase() !== 'false',
    passkeyTtlMs: shortTtl(env.CONTROL_PASSKEY_TTL_SEC),
    totpTtlMs: shortTtl(env.CONTROL_TOTP_TTL_SEC),
    // Mặc định TẮT: điện thoại dùng 4G đổi IP liên tục nên gắn phiên theo mạng gây hỏi lại xác thực vô ích. Bật bằng CONTROL_BIND_NET=true.
    bindNet: String(env.CONTROL_BIND_NET || 'false').toLowerCase() === 'true',
    lanCidrs: String(env.CONTROL_LAN_CIDRS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/* ---------------- phiên điều khiển ---------------- */
export function createControlSession(db, userId, method, ip, cfg = securityConfig(), loginId = null, commandId = null, deviceId = null) {
  const now = Date.now();
  db.prepare('DELETE FROM control_sessions WHERE expires_at < ? OR revoked = 1').run(now - 86_400_000);
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = method === 'passkey' ? cfg.passkeyTtlMs : cfg.totpTtlMs;
  db.prepare(`
    INSERT INTO control_sessions (user_id, token_hash, method, net, expires_at, created_at, login_id, command_id, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, sha(token), method, netOf(ip), now + ttl, now, loginId, commandId, deviceId);
  return { token, method, expiresAt: now + ttl };
}

export function revokeControlSessions(db, userId, token = null) {
  if (token) db.prepare('UPDATE control_sessions SET revoked = 1 WHERE user_id = ? AND token_hash = ?').run(userId, sha(token));
  else db.prepare('UPDATE control_sessions SET revoked = 1 WHERE user_id = ?').run(userId);
}

/** @returns {{ok:true, method:string, expiresAt:number}|{error:string, reason:string}} */
export function checkControlSession(db, userId, token, ip, cfg = securityConfig(), now = Date.now()) {
  if (!token) return { error: 'step_up_required', reason: 'no_token' };
  const row = db.prepare('SELECT * FROM control_sessions WHERE token_hash = ?').get(sha(token));
  if (!row || row.user_id !== userId || row.revoked) return { error: 'step_up_required', reason: 'invalid' };
  const maxAge = row.method === 'passkey' ? cfg.passkeyTtlMs : cfg.totpTtlMs;
  if (row.expires_at <= now || now - row.created_at >= maxAge) return { error: 'step_up_required', reason: 'expired' };
  if (cfg.bindNet && row.net !== netOf(ip)) return { error: 'step_up_required', reason: 'network_changed' };
  return { ok: true, method: row.method, expiresAt: Math.min(row.expires_at, row.created_at + maxAge), createdAt: row.created_at, loginId: row.login_id, commandId: row.command_id };
}

export function factorSummary(db, userId) {
  const passkeys = db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId).n;
  const u = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId);
  return { passkeys, totp: Boolean(u?.totp_enabled) };
}

/**
 * Người thuộc nhóm điều khiển (config.canControl) phải bật vân tay/Authenticator trong CONTROL_ENROLL_GRACE_DAYS ngày
 * (mặc định 3, "off" = không ép). Hết hạn → khoá điều khiển (vẫn xem được) cho tới khi bật.
 */
export function enrollState(db, user, now = Date.now()) {
  const f = factorSummary(db, user.id);
  if (f.passkeys || f.totp || !getConfig().canControl(user)) return { needed: false, locked: false, deadline: null };
  const raw = String(env.CONTROL_ENROLL_GRACE_DAYS ?? '3').toLowerCase();
  if (raw === 'off' || Number(raw) < 0) return { needed: true, locked: false, deadline: null };
  let deadline = db.prepare('SELECT enroll_deadline FROM users WHERE id = ?').get(user.id)?.enroll_deadline;
  if (!deadline) {
    deadline = now + (Number(raw) || 0) * 86_400_000;
    db.prepare('UPDATE users SET enroll_deadline = ? WHERE id = ?').run(deadline, user.id);
  }
  return { needed: true, locked: now > deadline, deadline };
}

/* ---------------- PC trạm kiểu cũ (admin cấp khoá) ---------------- */
export function createStation(db, userId, name) {
  const id = `st_${crypto.randomBytes(6).toString('hex')}`;
  const key = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO stations (id, user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, String(name || id).slice(0, 60), sha(key), Date.now());
  return { id, key };
}

export function listStations(db) {
  return db.prepare('SELECT id, user_id, name, created_at, last_seen_at FROM stations ORDER BY created_at').all();
}

export function deleteStation(db, id) {
  return db.prepare('DELETE FROM stations WHERE id = ?').run(String(id)).changes > 0;
}

/** Trạm hợp lệ = IP trong dải xưởng + id/khoá khớp + trạm thuộc chính user đang đăng nhập. */
export function stationOk(db, userId, headers, ip, cfg = securityConfig()) {
  const id = String(headers['x-station-id'] || '');
  const key = String(headers['x-station-key'] || '');
  if (!id || !key || !cfg.lanCidrs.length || !ipInCidrs(ip, cfg.lanCidrs)) return false;
  const row = db.prepare('SELECT * FROM stations WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  const a = Buffer.from(row.key_hash);
  const b = Buffer.from(sha(key));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  db.prepare('UPDATE stations SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  return true;
}
