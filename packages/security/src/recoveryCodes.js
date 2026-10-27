import crypto from 'crypto';
import { audit, countAudit } from './audit.js';
import { keyFrom } from './config.js';

// Crockford base32 (no I L O U): 12 chars = 60 bits, shown as XXXX-XXXX-XXXX.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const COUNT = 10;

function pepper() {
  return keyFrom('recovery:');
}

export function normalizeCode(input) {
  return String(input || '').toUpperCase()
    .replace(/O/g, '0').replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '');
}

function hashCode(code) {
  return crypto.createHmac('sha256', pepper()).update(normalizeCode(code)).digest('hex');
}

function genOne() {
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[crypto.randomInt(0, 32)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Replace all codes. Plain codes are returned once and never stored. */
export function generateRecoveryCodes(db, userId) {
  const codes = Array.from({ length: COUNT }, genOne);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const c of codes) ins.run(userId, hashCode(c));
  });
  tx();
  return codes;
}

export function recoveryCodesRemaining(db, userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .get(userId).n;
}

/** Single-use: returns true and burns the code when valid. */
export function consumeRecoveryCode(db, userId, code) {
  const norm = normalizeCode(code);
  if (norm.length !== 12) return false;
  const want = Buffer.from(hashCode(norm), 'hex');
  const rows = db.prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .all(userId);
  let hit = null;
  for (const r of rows) {
    const have = Buffer.from(r.code_hash, 'hex');
    if (have.length === want.length && crypto.timingSafeEqual(have, want)) hit = r;
  }
  if (!hit) return false;
  const info = db.prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
    .run(hit.id);
  return info.changes === 1;
}

/** Tối đa 10 lần sai/24 giờ/tài khoản bất kể IP. @returns {'ok'|'locked'|'invalid'} */
export function tryRecoveryCode(db, user, code, ip) {
  if (countAudit(db, user.id, 'recovery_code_fail', Date.now() - 24 * 3_600_000) >= 10) return 'locked';
  if (consumeRecoveryCode(db, user.id, code)) return 'ok';
  audit(db, 'recovery_code_fail', { userId: user.id, ip });
  return 'invalid';
}
