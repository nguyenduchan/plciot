import crypto from 'node:crypto';

export function canonicalDeviceKey(value) {
  try {
    const key = typeof value === 'string' ? JSON.parse(value) : value;
    if (key?.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || key.d) return null;
    const normalized = { kty: 'EC', crv: 'P-256', x: key.x, y: key.y };
    crypto.createPublicKey({ key: normalized, format: 'jwk' });
    return JSON.stringify(normalized);
  } catch { return null; }
}

export function deviceFingerprint(value) {
  const key = canonicalDeviceKey(value);
  return key ? crypto.createHash('sha256').update(key).digest('hex') : null;
}

export function verifyDeviceProof(db, { subject, deviceId, action, publicKey, proof }) {
  const key = canonicalDeviceKey(publicKey);
  if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(String(deviceId || ''))
    || !/^[A-Za-z0-9_-]{20,128}$/.test(String(proof?.nonce || ''))
    || !Number.isSafeInteger(proof?.timestamp) || Math.abs(Date.now() - proof.timestamp) > 60_000) return false;
  try {
    const message = Buffer.from(JSON.stringify([String(subject), deviceId, action, proof.timestamp, proof.nonce]));
    const verified = crypto.verify('sha256', message,
      { key: crypto.createPublicKey({ key: JSON.parse(key), format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(String(proof.signature || ''), 'base64url'));
    if (!verified) return false;
    db.prepare('DELETE FROM device_proof_nonces WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO device_proof_nonces (nonce, expires_at) VALUES (?, ?)').run(proof.nonce, Date.now() + 120_000);
    return true;
  } catch { return false; }
}

export function rememberAuthDevice(db, userId, deviceId, publicKey, label = '') {
  const key = canonicalDeviceKey(publicKey);
  if (!key) throw new Error('device_proof_required');
  const existing = db.prepare('SELECT * FROM auth_devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
  if (existing && (existing.public_key !== key || existing.revoked)) throw new Error('device_revoked');
  db.prepare('INSERT OR IGNORE INTO auth_devices (user_id, device_id, public_key, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, deviceId, key, label, Date.now());
}

export function recoveryEnrollmentAllowed(db, payload, deviceId) {
  if (payload?.scope !== 'login_pending' || !payload.rid || payload.did !== deviceId) return false;
  return Boolean(db.prepare('SELECT 1 FROM recovery_enrollments WHERE user_id = ? AND change_id = ? AND device_id = ? AND used_at IS NULL AND expires_at > ?')
    .get(payload.uid, payload.rid, deviceId, Date.now()));
}