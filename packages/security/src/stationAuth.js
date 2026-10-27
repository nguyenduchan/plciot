/**
 * PC nhà máy (trạm) ghép cặp bằng mã, xác thực bằng khoá thiết bị — không mật khẩu, không cần admin.
 *
 *   1. Chủ site bấm "Thêm PC" → mã ghép XXXX-XXXX sống 10 phút, dùng một lần.
 *   2. PC sinh cặp khoá ECDSA P-256 (khoá riêng nằm trong Windows DPAPI/TPM, không rời máy), gửi khoá công khai + mã.
 *   3. Mỗi request sau đó PC ký: ts \n METHOD \n path \n sha256(body) bằng khoá riêng (chữ ký IEEE-P1363, mặc định .NET).
 *   Đổi PC = ghép PC mới + thu hồi PC cũ. IP chỉ là tín hiệu phụ (CONTROL_LAN_CIDRS nếu admin muốn siết thêm).
 */
import crypto from 'crypto';
import { audit } from './audit.js';
import { normalizeCode } from './recoveryCodes.js';
import { keyFrom, notify } from './config.js';
import { securityConfig } from './sessions.js';
import { ipInCidrs, clientIp } from './net.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_TTL = 10 * 60_000;
const SKEW = 60_000;
const nonces = new Map(); // chữ ký -> hết hạn (chống phát lại trong cửa sổ lệch giờ)

const pepper = () => keyFrom('pair:');
const hashCode = (c) => crypto.createHmac('sha256', pepper()).update(normalizeCode(c)).digest('hex');
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Chuỗi được ký; client và server phải dựng giống hệt. */
export function stationMessage(ts, method, path, body) {
  return `${ts}\n${String(method).toUpperCase()}\n${path}\n${sha256hex(body || '')}`;
}

export function createPairCode(db, owner, { name, site, device }) {
  db.prepare('DELETE FROM pair_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(Date.now() - 3_600_000);
  db.prepare('DELETE FROM pair_codes WHERE user_id = ?').run(owner.id); // một mã hiệu lực mỗi lần
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(0, 32)];
  const code = `${s.slice(0, 4)}-${s.slice(4)}`;
  db.prepare('INSERT INTO pair_codes (code_hash, user_id, site, device, name, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hashCode(code), owner.id, site, device, String(name || 'PC nhà máy').slice(0, 60), Date.now() + CODE_TTL);
  audit(db, 'pair_code_created', { userId: owner.id, detail: `${site}/${device}` });
  return { code, expiresIn: CODE_TTL / 1000 };
}

function failures(db, ip) {
  return db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'pair_fail' AND ip = ? AND ts >= ?").get(ip, Date.now() - 10 * 60_000).n;
}

/** @returns {{ok:true, stationId, site, device, name}|{error}} */
export async function pairStation(db, { code, publicKey, hwid, name, ip }) {
  if (failures(db, ip) >= 10) return { error: 'rate_limited', status: 429 };
  const row = db.prepare('SELECT * FROM pair_codes WHERE code_hash = ?').get(hashCode(code));
  if (!row || row.used_at || row.expires_at < Date.now()) {
    audit(db, 'pair_fail', { ip });
    return { error: 'invalid_pair_code', status: 401 };
  }
  let key;
  try {
    key = crypto.createPublicKey({ key: Buffer.from(String(publicKey || ''), 'base64url'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('curve');
  } catch {
    return { error: 'invalid_public_key', status: 400 };
  }
  const used = db.prepare('UPDATE pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(Date.now(), row.code_hash);
  if (used.changes !== 1) return { error: 'invalid_pair_code', status: 401 };
  const id = `pc_${crypto.randomBytes(6).toString('hex')}`;
  const label = String(name || row.name).slice(0, 60);
  db.prepare(`
    INSERT INTO stations (id, user_id, name, key_hash, created_at, kind, public_key, hwid, site, device, last_ip)
    VALUES (?, ?, ?, '', ?, 'paired', ?, ?, ?, ?, ?)
  `).run(id, row.user_id, label, Date.now(), String(publicKey), String(hwid || '').slice(0, 128), row.site, row.device, ip || null);
  audit(db, 'station_paired', { userId: row.user_id, ip, detail: `${id} ${row.site}/${row.device}` });
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (owner) {
    notify(db, owner, {
      subject: 'Đã ghép PC nhà máy mới',
      html: `<b>🖥 PC mới "${label.replace(/[&<>]/g, '')}" đã được ghép</b> với ${row.site}/${row.device}.\nKhông phải bạn? Vào Cài đặt → Nhà máy → Thu hồi PC.`,
    });
  }
  return { ok: true, stationId: id, site: row.site, device: row.device, name: label };
}

export function revokeStation(db, owner, id, { site, device, ip }) {
  const n = db.prepare("DELETE FROM stations WHERE id = ? AND kind = 'paired' AND site = ? AND device = ?").run(String(id), site, device).changes;
  if (!n) return { error: 'not_found', status: 404 };
  audit(db, 'station_revoked', { userId: owner.id, ip, detail: String(id) });
  return { ok: true };
}

/** Middleware: xác thực request ký bởi PC đã ghép. Gắn req.station và req.stationOwner. Cần req.rawBody. */
export function stationAuth(db) {
  return (req, res, next) => {
    const id = String(req.headers['x-station-id'] || '');
    const ts = Number(req.headers['x-station-ts']);
    const sig = String(req.headers['x-station-sig'] || '');
    const deny = (error, status = 401) => res.status(status).json({ error });
    if (!id || !sig || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > SKEW) return deny('station_auth_failed');
    const st = db.prepare("SELECT * FROM stations WHERE id = ? AND kind = 'paired'").get(id);
    if (!st) return deny('station_auth_failed');
    const now = Date.now();
    for (const [k, v] of nonces) if (v < now) nonces.delete(k);
    if (nonces.has(sig)) return deny('station_replay');
    let ok = false;
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(st.public_key, 'base64url'), format: 'der', type: 'spki' });
      const msg = stationMessage(ts, req.method, req.originalUrl.split('?')[0], req.rawBody || Buffer.alloc(0));
      ok = crypto.verify('sha256', Buffer.from(msg), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    } catch { ok = false; }
    if (!ok) { audit(db, 'station_auth_fail', { ip: clientIp(req), detail: id }); return deny('station_auth_failed'); }
    const cfg = securityConfig();
    const ip = clientIp(req);
    if (cfg.lanCidrs.length && !ipInCidrs(ip, cfg.lanCidrs)) return deny('station_ip_not_allowed', 403);
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(st.user_id);
    if (!owner || owner.disabled) return deny('station_owner_disabled', 403);
    nonces.set(sig, now + 2 * SKEW);
    db.prepare('UPDATE stations SET last_seen_at = ?, last_ip = ? WHERE id = ?').run(now, ip || null, id);
    req.station = st;
    req.stationOwner = owner;
    next();
  };
}
