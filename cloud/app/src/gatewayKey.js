/**
 * Khoá công khai của gateway (ECDSA P-256) — gateway sinh cặp khoá, giữ khoá riêng, GỬI KHOÁ CÔNG KHAI lên server lúc ghép cặp.
 *   - hw (ID máy) KHÔNG còn do gateway tự khai: hw = 20 ký tự Crockford đầu của SHA-256(SPKI DER của khoá công khai).
 *   - Ghép cặp: chữ ký chứng minh đang giữ khoá riêng:  "pair|<MÃ 8 ký tự chuẩn hoá>|<ts>"
 *   - enroll / config: chữ ký "<enroll|config>|<site>|<device>|<ts>" (site/device lấy từ QR). Chỉ ảnh QR mà không có khoá riêng thì vô dụng.
 * Chữ ký dạng IEEE P1363 (r||s, 64 byte) — .NET: ECDsa.SignData(..., DSASignatureFormat.IeeeP1363FixedFieldConcatenation).
 * Khoá công khai: SPKI DER, base64url (.NET: ECDsa.ExportSubjectPublicKeyInfo()).
 */
import crypto from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PROOF_WINDOW_MS = Number(process.env.GATEWAY_PROOF_WINDOW_SEC || 300) * 1000;
const seen = new Map();   // chống phát lại: sig đã dùng → hạn

function b32(buf, n) {
  let bits = 0; let acc = 0; let out = '';
  for (const byte of buf) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5 && out.length < n) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= n) break;
  }
  return out;
}

/** Khoá công khai hợp lệ (EC P-256, SPKI DER base64url) → { hw, key, spki } hoặc null. */
export function parsePubkey(b64u) {
  try {
    const der = Buffer.from(String(b64u || ''), 'base64url');
    if (der.length < 60 || der.length > 200) return null;
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return { hw: b32(crypto.createHash('sha256').update(der).digest(), 20), key, spki: der.toString('base64url') };
  } catch { return null; }
}

/** Chữ ký + thời điểm còn trong cửa sổ + chưa dùng lại. */
export function verifyProof(pubkeyB64u, message, sigB64u, ts, now = Date.now()) {
  const pk = parsePubkey(pubkeyB64u);
  const t = Number(ts);
  if (!pk || !Number.isFinite(t) || Math.abs(now - t) > PROOF_WINDOW_MS) return false;
  let sig;
  try { sig = Buffer.from(String(sigB64u), 'base64url'); } catch { return false; }
  if (sig.length !== 64) return false;
  let ok = false;
  try { ok = crypto.verify('sha256', Buffer.from(message, 'utf8'), { key: pk.key, dsaEncoding: 'ieee-p1363' }, sig); } catch { ok = false; }
  if (!ok) return false;
  const k = String(sigB64u);
  for (const [s, exp] of seen) if (exp < now) seen.delete(s);
  if (seen.has(k)) return false;   // phát lại
  seen.set(k, now + PROOF_WINDOW_MS * 2);
  if (seen.size > 20000) seen.clear();
  return true;
}
export const pairMessage = (code, ts) => `pair|${code}|${ts}`;
export const requestMessage = (kind, site, device, ts) => `${kind}|${site}|${device}|${ts}`;

/** Cột khoá công khai của tem (DB cũ chưa có). */
const done = new WeakSet();
export function ensureKeyColumns(db) {
  if (done.has(db)) return;
  const has = (t, c) => db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(c);
  try { if (!has('hardware_devices', 'gw_pubkey')) db.exec('ALTER TABLE hardware_devices ADD COLUMN gw_pubkey TEXT'); } catch { /* bảng chưa có */ }
  try { if (!has('gateway_pairings', 'pubkey')) db.exec('ALTER TABLE gateway_pairings ADD COLUMN pubkey TEXT'); } catch { /* bảng chưa có */ }
  done.add(db);
}
