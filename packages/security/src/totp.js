/**
 * TOTP (RFC 6238, SHA-1, 6 chữ số, 30 s) cho Google/Microsoft Authenticator — không cần thư viện ngoài.
 * Bí mật được mã hoá AES-256-GCM trong DB bằng khoá dẫn xuất từ secret của app (config.secret).
 */
import crypto from 'crypto';
import { keyFrom } from './config.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad_base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const stepOf = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/**
 * Trả step khớp (số nguyên) hoặc null. Cho lệch ±1 bước (đồng hồ điện thoại).
 * `lastStep`: step đã dùng gần nhất — mã ở step ≤ lastStep bị từ chối (chống phát lại).
 */
export function verifyTotp(secretB32, code, { now = Date.now(), lastStep = 0, window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepOf(now);
  for (let d = -window; d <= window; d++) {
    const step = cur + d;
    if (step <= lastStep) continue;
    const exp = Buffer.from(hotp(secretB32, step));
    if (crypto.timingSafeEqual(exp, Buffer.from(c))) return step;
  }
  return null;
}

export function otpauthUri(secretB32, account, issuer = 'Giám sát PLC') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

/* ---- bí mật khi lưu ---- */
function kek() {
  return keyFrom('plciot-totp|');
}

export function sealSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kek(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}

export function openSecret(sealed) {
  if (!sealed?.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', kek(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}
