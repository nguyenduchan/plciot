/**
 * PC nhà = trình duyệt có khoá ECDSA trong IndexedDB.
 * Đánh dấu: Passkey (reauth) + chữ ký device proof → lưu public_key.
 * Dùng quyền: mỗi thao tác admin ghi phải ký lại bằng đúng khoá đó
 * (copy X-Device-Id sang máy khác không đủ để giả mạo).
 */
import { clientIp, canonicalDeviceKey, verifyDeviceProof } from '@plciot/security';

export function initHomePcTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_home_pcs (
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      label TEXT,
      public_key TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER,
      last_ip TEXT,
      PRIMARY KEY (user_id, device_id)
    );
  `);
  const cols = db.prepare('PRAGMA table_info(admin_home_pcs)').all().map((c) => c.name);
  if (!cols.includes('public_key')) {
    db.exec('ALTER TABLE admin_home_pcs ADD COLUMN public_key TEXT');
  }
}

export function deviceIdFromReq(req) {
  return String(req.headers['x-device-id'] || '').trim().slice(0, 80);
}

function rowFor(db, userId, deviceId) {
  if (!userId || !deviceId) return null;
  return db.prepare(
    'SELECT * FROM admin_home_pcs WHERE user_id = ? AND device_id = ?',
  ).get(userId, deviceId);
}

export function isHomeAdminPc(db, userId, deviceId) {
  const row = rowFor(db, userId, deviceId);
  return Boolean(row?.public_key);
}

/**
 * Xác minh máy đang gọi đúng là PC nhà (chữ ký, không chỉ UUID).
 * @param {string} action — path API, phải khớp lúc ký phía client
 */
export function verifyHomePcRequest(db, req, action) {
  const deviceId = deviceIdFromReq(req);
  const row = rowFor(db, req.user?.id, deviceId);
  if (!row?.public_key) return false;
  let stored;
  try { stored = JSON.parse(row.public_key); } catch { return false; }
  const proof = req.body?.deviceProof;
  if (!proof) return false;
  const ok = verifyDeviceProof(db, {
    subject: req.user.id,
    deviceId,
    action: action || req.path,
    publicKey: stored,
    proof,
  });
  if (ok) touchHomePc(db, req.user.id, deviceId, clientIp(req));
  return ok;
}

export function listHomePcs(db, userId) {
  return db.prepare(`
    SELECT device_id AS deviceId, label, created_at AS createdAt,
           last_seen AS lastSeen, last_ip AS lastIp,
           CASE WHEN public_key IS NOT NULL AND public_key != '' THEN 1 ELSE 0 END AS hasKey
    FROM admin_home_pcs WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
}

export function trustHomePc(db, userId, {
  deviceId, label, ip, publicKey, deviceProof, action,
}) {
  const id = String(deviceId || '').trim();
  if (!id || id.length < 8) return { error: 'device_id_required', status: 400 };
  const key = canonicalDeviceKey(publicKey);
  if (!key) return { error: 'device_proof_required', status: 400 };
  if (!verifyDeviceProof(db, {
    subject: userId,
    deviceId: id,
    action: action || '/api/admin/ops/home-pc/trust',
    publicKey,
    proof: deviceProof,
  })) {
    return { error: 'device_proof_invalid', status: 401 };
  }

  const now = Date.now();
  const existing = rowFor(db, userId, id);
  if (existing) {
    db.prepare(`
      UPDATE admin_home_pcs
      SET last_seen = ?, last_ip = ?, label = COALESCE(?, label), public_key = ?
      WHERE user_id = ? AND device_id = ?
    `).run(now, ip || null, label ? String(label).slice(0, 80) : null, key, userId, id);
  } else {
    const n = db.prepare('SELECT COUNT(*) AS n FROM admin_home_pcs WHERE user_id = ?').get(userId).n;
    const max = Number(process.env.ADMIN_HOME_PC_MAX || 3);
    if (n >= max) return { error: 'home_pc_limit', status: 409, max };
    db.prepare(`
      INSERT INTO admin_home_pcs (user_id, device_id, label, public_key, created_at, last_seen, last_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, id, String(label || 'PC nhà').slice(0, 80), key, now, now, ip || null);
  }
  return {
    ok: true,
    homePc: true,
    deviceId: id,
    pcs: listHomePcs(db, userId),
  };
}

export function revokeHomePc(db, userId, deviceId) {
  const info = db.prepare(
    'DELETE FROM admin_home_pcs WHERE user_id = ? AND device_id = ?',
  ).run(userId, deviceId);
  if (!info.changes) return { error: 'not_found', status: 404 };
  return { ok: true, pcs: listHomePcs(db, userId) };
}

export function touchHomePc(db, userId, deviceId, ip) {
  if (!rowFor(db, userId, deviceId)) return;
  db.prepare('UPDATE admin_home_pcs SET last_seen = ?, last_ip = ? WHERE user_id = ? AND device_id = ?')
    .run(Date.now(), ip || null, userId, deviceId);
}

export function homePcStatus(db, req) {
  const deviceId = deviceIdFromReq(req);
  const home = isHomeAdminPc(db, req.user.id, deviceId);
  return {
    deviceId: deviceId || null,
    isHomePc: home,
    pcs: listHomePcs(db, req.user.id),
    hint: home
      ? 'PC nhà (đã gắn khoá thiết bị). Thao tác admin ghi phải ký từ đúng trình duyệt này + Passkey.'
      : 'Chưa đánh dấu. Chỉ bấm trên đúng PC nhà của bạn; cần Passkey + chữ ký thiết bị (không giả bằng copy mã).',
  };
}
