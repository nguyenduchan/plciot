import { getConfig } from './config.js';

export function canBindVerifiedContact({ actorId, contactOwnerId, isPrivate, currentContact, newContact }) {
  return isPrivate === true && actorId != null && contactOwnerId != null
    && String(actorId) === String(contactOwnerId) && newContact != null
    && (currentContact == null || String(currentContact) === String(newContact));
}

export const findUserById = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export function findUserByPhone(db, phone) {
  const normalized = getConfig().identity.normalize(phone);
  return db.prepare('SELECT * FROM users WHERE phone = ? OR username = ? COLLATE NOCASE').get(normalized, normalized);
}
export function createOtpChallenge(db, { phone, purpose, codeHash, ttlSec = 300, contact = null }) {
  phone = getConfig().identity.normalize(phone);
  db.prepare('DELETE FROM otp_challenges WHERE phone = ? AND purpose = ?').run(phone, purpose);
  const expiresAt = Date.now() + ttlSec * 1000;
  const created = db.prepare('INSERT INTO otp_challenges (phone, purpose, code_hash, expires_at, contact_id) VALUES (?, ?, ?, ?, ?)')
    .run(phone, purpose, codeHash, expiresAt, contact == null ? null : String(contact));
  return { id: created.lastInsertRowid, expiresAt };
}
export const getOtpChallenge = (db, phone, purpose) => db.prepare('SELECT * FROM otp_challenges WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1').get(getConfig().identity.normalize(phone), purpose);
export const bumpOtpFail = (db, id) => db.prepare('UPDATE otp_challenges SET fails = fails + 1 WHERE id = ?').run(id);
export const deleteOtpChallenge = (db, id) => db.prepare('DELETE FROM otp_challenges WHERE id = ?').run(id);