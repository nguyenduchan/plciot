/**
 * Passkeys / WebAuthn tối giản (không phụ thuộc thư viện): attestation "none", chữ ký ES256 / RS256,
 * bắt buộc User Verification (vân tay / Face ID / PIN máy). Khoá công khai lưu SPKI DER (base64url).
 * Thử thách (challenge) lưu trong bộ nhớ, dùng một lần, sống 2 phút.
 */
import crypto from 'crypto';

const CHALLENGE_TTL = 120_000;
const challenges = new Map(); // key -> { challenge, expires }

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function sweep(now) {
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
}

export function newChallenge(key, now = Date.now()) {
  sweep(now);
  const challenge = b64u(crypto.randomBytes(32));
  challenges.set(key, { challenge, expires: now + CHALLENGE_TTL });
  return challenge;
}

function takeChallenge(key, now = Date.now()) {
  const v = challenges.get(key);
  challenges.delete(key); // dùng một lần dù đúng hay sai
  return v && v.expires >= now ? v.challenge : null;
}

/* ---- CBOR tối thiểu (đủ cho attestationObject + COSE key) ---- */
function cborDecode(buf, off = 0) {
  const ib = buf[off++];
  const major = ib >> 5;
  let info = ib & 31;
  const readLen = () => {
    if (info < 24) return info;
    if (info === 24) return buf[off++];
    if (info === 25) { const v = buf.readUInt16BE(off); off += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(off); off += 4; return v; }
    throw new Error('cbor_unsupported_length');
  };
  if (major === 7) {
    if (info === 20) return [false, off];
    if (info === 21) return [true, off];
    if (info === 22 || info === 23) return [null, off];
    throw new Error('cbor_unsupported_simple');
  }
  const len = readLen();
  switch (major) {
    case 0: return [len, off];
    case 1: return [-1 - len, off];
    case 2: return [buf.subarray(off, off + len), off + len];
    case 3: return [buf.subarray(off, off + len).toString('utf8'), off + len];
    case 4: {
      const arr = [];
      for (let i = 0; i < len; i++) { const [v, o] = cborDecode(buf, off); arr.push(v); off = o; }
      return [arr, off];
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < len; i++) {
        const [k, o1] = cborDecode(buf, off);
        const [v, o2] = cborDecode(buf, o1);
        map.set(k, v); off = o2;
      }
      return [map, off];
    }
    default: throw new Error('cbor_unsupported_major');
  }
}

function parseAuthData(ad) {
  if (ad.length < 37) throw new Error('bad_authdata');
  const out = {
    rpIdHash: ad.subarray(0, 32), flags: ad[32], counter: ad.readUInt32BE(33), rest: ad.subarray(37),
  };
  out.up = Boolean(out.flags & 0x01);
  out.uv = Boolean(out.flags & 0x04);
  out.at = Boolean(out.flags & 0x40);
  return out;
}

function coseToSpki(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    jwk = { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
  } else if (kty === 3 && alg === -257) {
    jwk = { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) };
  } else {
    throw new Error('unsupported_key_type');
  }
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return { spki: b64u(key.export({ type: 'spki', format: 'der' })), alg };
}

function checkClientData(clientDataJSON, type, expectedChallenge, origins) {
  let cd;
  try { cd = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')); } catch { throw new Error('bad_client_data'); }
  if (cd.type !== type) throw new Error('bad_type');
  if (cd.challenge !== expectedChallenge) throw new Error('bad_challenge');
  if (!origins.includes(cd.origin)) throw new Error('bad_origin');
  if (cd.crossOrigin === true) throw new Error('cross_origin');
}

/* ---- Đăng ký ---- */
export function registrationOptions({ userId, username, rpId, rpName = 'Giám sát PLC', exclude = [] }) {
  const challenge = newChallenge(`reg:${userId}`);
  return {
    challenge,
    rp: { id: rpId, name: rpName },
    user: { id: b64u(`u${userId}`), name: username, displayName: username },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    // attachment 'platform': chỉ hỏi vân tay/Face ID của chính máy (như app ngân hàng), không đưa ra khoá ngoài hay mã QR
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required', requireResidentKey: true },
    attestation: 'none',
    excludeCredentials: exclude.map((id) => ({ type: 'public-key', id })),
    timeout: 60_000,
  };
}

/** @returns {{credId:string, publicKey:string, alg:number, counter:number}} */
export function verifyRegistration(userId, cred, { rpId, origins }) {
  const expected = takeChallenge(`reg:${userId}`);
  if (!expected) throw new Error('challenge_expired');
  const r = cred?.response;
  if (!r?.clientDataJSON || !r?.attestationObject || !cred.id) throw new Error('bad_request');
  checkClientData(r.clientDataJSON, 'webauthn.create', expected, origins);
  const [att] = cborDecode(Buffer.from(r.attestationObject, 'base64url'));
  if (!(att instanceof Map) || att.get('fmt') !== 'none') throw new Error('attestation_not_none');
  const ad = parseAuthData(att.get('authData'));
  if (!ad.rpIdHash.equals(sha256(rpId))) throw new Error('bad_rp');
  if (!ad.up || !ad.uv || !ad.at) throw new Error('user_verification_required');
  const credLen = ad.rest.readUInt16BE(16);
  const credId = ad.rest.subarray(18, 18 + credLen);
  const [cose] = cborDecode(ad.rest, 18 + credLen);
  if (b64u(credId) !== cred.id) throw new Error('cred_id_mismatch');
  const { spki, alg } = coseToSpki(cose);
  return { credId: cred.id, publicKey: spki, alg, counter: ad.counter };
}

/* ---- Xác thực (mỗi lần mở khoá điều khiển) ---- */
/** `key` = `auth:<userId>` (mở khoá điều khiển) hoặc `login:<cid>` (đăng nhập không cần biết ai). */
export function authenticationOptions({ key: chKey, rpId, allow = [] }) {
  const challenge = newChallenge(chKey);
  return {
    challenge,
    rpId,
    userVerification: 'required',
    allowCredentials: allow.map((id) => ({ type: 'public-key', id })),
    timeout: 60_000,
  };
}

/** @returns {{counter:number}} ném lỗi nếu không hợp lệ. `stored` = hàng passkeys của credential. */
export function verifyAuthentication(chKey, cred, stored, { rpId, origins }) {
  const expected = takeChallenge(chKey);
  if (!expected) throw new Error('challenge_expired');
  const r = cred?.response;
  if (!r?.clientDataJSON || !r?.authenticatorData || !r?.signature) throw new Error('bad_request');
  checkClientData(r.clientDataJSON, 'webauthn.get', expected, origins);
  const authData = Buffer.from(r.authenticatorData, 'base64url');
  const ad = parseAuthData(authData);
  if (!ad.rpIdHash.equals(sha256(rpId))) throw new Error('bad_rp');
  if (!ad.up || !ad.uv) throw new Error('user_verification_required');
  const signed = Buffer.concat([authData, sha256(Buffer.from(r.clientDataJSON, 'base64url'))]);
  const key = crypto.createPublicKey({ key: Buffer.from(stored.public_key, 'base64url'), format: 'der', type: 'spki' });
  if (!crypto.verify('sha256', signed, key, Buffer.from(r.signature, 'base64url'))) throw new Error('bad_signature');
  // Bộ đếm phải tăng (nếu thiết bị có hỗ trợ) — phát hiện khoá bị sao chép.
  if ((ad.counter || stored.counter) && ad.counter <= stored.counter) throw new Error('counter_regressed');
  return { counter: ad.counter };
}
