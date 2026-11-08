/**
 * Claim thiết bị phần cứng qua QR đã ký (Ed25519).
 * Payload sticker (base64url JSON): { v, site, device, claim, sig }
 * Chuỗi ký: `${v}|${site}|${device}|${claim}` — sig = base64url(Ed25519(sigBytes)).
 */
import crypto from 'node:crypto';
import { audit } from './audit.js';
import { getConfig, rawSecret } from './config.js';
import { sealSecret, openSecret } from './totp.js';

const SAFE = /^[a-zA-Z0-9_-]{1,48}$/;
const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (s) => Buffer.from(String(s), 'base64url'),
};

function claimRootKeys() {
  const pubPem = process.env.CLAIM_ROOT_PUBLIC_KEY || '';
  const privPem = process.env.CLAIM_ROOT_PRIVATE_KEY || '';
  return {
    publicKey: pubPem ? crypto.createPublicKey(pubPem) : null,
    privateKey: privPem ? crypto.createPrivateKey(privPem) : null,
  };
}

/** Sinh cặp khoá Ed25519 (PEM) dùng khi provision / test. */
export function generateClaimRootKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function claimMessage({ v = 1, site, device, claim }) {
  return `${Number(v) || 1}|${site}|${device}|${claim}`;
}

export function signClaimPayload({ site, device, claim, v = 1, privateKeyPem }) {
  const key = privateKeyPem
    ? crypto.createPrivateKey(privateKeyPem)
    : claimRootKeys().privateKey;
  if (!key) throw new Error('claim_root_private_key_missing');
  if (!SAFE.test(site) || !SAFE.test(device)) throw new Error('invalid_site_or_device');
  const msg = claimMessage({ v, site, device, claim });
  const sig = b64u.enc(crypto.sign(null, Buffer.from(msg, 'utf8'), key));
  return { v, site, device, claim, sig };
}

export function encodeClaimQr(payload) {
  return b64u.enc(Buffer.from(JSON.stringify(payload), 'utf8'));
}

export function decodeClaimQr(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const json = text.startsWith('{') ? text : b64u.dec(text).toString('utf8');
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

export function verifyClaimSignature(payload, publicKeyPem) {
  const key = publicKeyPem
    ? crypto.createPublicKey(publicKeyPem)
    : claimRootKeys().publicKey;
  if (!key) return { error: 'claim_root_public_key_missing', status: 503 };
  const { v = 1, site, device, claim, sig } = payload || {};
  if (!SAFE.test(String(site || '')) || !SAFE.test(String(device || ''))) return { error: 'invalid_site_or_device', status: 400 };
  if (!claim || !sig) return { error: 'invalid_claim_payload', status: 400 };
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(claimMessage({ v, site, device, claim }), 'utf8'), key, b64u.dec(sig));
  } catch {
    ok = false;
  }
  if (!ok) return { error: 'invalid_claim_signature', status: 401 };
  return { ok: true, v: Number(v) || 1, site: String(site), device: String(device), claim: String(claim) };
}

export function hashClaimSecret(claim) {
  return crypto.createHash('sha256').update(`plciot-claim:${claim}`).digest('hex');
}

function claimLoginUrl(qr) {
  const base = (getConfig().publicUrl?.() || process.env.WEBAPP_PUBLIC_URL || '').replace(/\/$/, '');
  return base ? `${base}/login.html?claim=${encodeURIComponent(qr)}` : `login.html?claim=${encodeURIComponent(qr)}`;
}

function buildQrBundle({ site, device, claim, privateKeyPem, label, note }) {
  const payload = signClaimPayload({ site, device, claim, privateKeyPem });
  const qr = encodeClaimQr(payload);
  return {
    site, device, label: label || null, note: note || null,
    payload, qr, loginUrl: claimLoginUrl(qr),
  };
}

/**
 * Đăng ký phần cứng (admin/script). Chỉ device đã đăng ký mới claim được.
 * Lưu claim_sealed để in lại QR; xoay secret khi reissue.
 */
export function provisionHardwareDevice(db, {
  site, device, claim, privateKeyPem, label = '', note = '', rotate = true,
  profile = '', uiMeta = null,
}) {
  const s = String(site || '').trim();
  const d = String(device || 'plc01').trim();
  const lab = String(label || '').trim().slice(0, 120);
  const nt = String(note || '').trim().slice(0, 500);
  const prof = String(profile || '').trim().slice(0, 64);
  let metaJson = null;
  if (uiMeta != null) {
    try { metaJson = typeof uiMeta === 'string' ? uiMeta : JSON.stringify(uiMeta); } catch { metaJson = null; }
    if (metaJson && metaJson.length > 8000) return { error: 'ui_meta_too_large', status: 400 };
  }
  if (!SAFE.test(s) || !SAFE.test(d)) return { error: 'invalid_site_or_device', status: 400 };
  if (!claimRootKeys().privateKey && !privateKeyPem) return { error: 'claim_root_private_key_missing', status: 503 };
  if (!claimRootKeys().publicKey && !process.env.CLAIM_ROOT_PUBLIC_KEY) {
    return { error: 'claim_root_public_key_missing', status: 503 };
  }

  const existing = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(s, d);
  if (existing?.claimed_by && !rotate) {
    return { error: 'device_already_claimed', status: 409 };
  }

  const secret = claim || crypto.randomBytes(24).toString('base64url');
  let payloadBundle;
  try {
    payloadBundle = buildQrBundle({ site: s, device: d, claim: secret, privateKeyPem, label: lab, note: nt });
  } catch (e) {
    return { error: e.message || 'claim_sign_failed', status: 503 };
  }
  const now = Date.now();
  const sealed = sealSecret(secret);
  db.prepare(`
    INSERT INTO hardware_devices (site, device, claim_hash, claim_sealed, label, note, profile, ui_meta, claimed_by, claimed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    ON CONFLICT(site, device) DO UPDATE SET
      claim_hash = excluded.claim_hash,
      claim_sealed = excluded.claim_sealed,
      label = excluded.label,
      note = excluded.note,
      profile = COALESCE(excluded.profile, hardware_devices.profile),
      ui_meta = COALESCE(excluded.ui_meta, hardware_devices.ui_meta),
      claimed_by = NULL,
      claimed_at = NULL,
      activated_hw = NULL,
      activated_at = NULL,
      activations = 0,
      created_at = excluded.created_at
  `).run(s, d, hashClaimSecret(secret), sealed, lab || null, nt || null, prof || null, metaJson, now);

  return {
    ok: true, ...payloadBundle, createdAt: now, claimed: false,
    profile: prof || null, uiMeta: metaJson ? JSON.parse(metaJson) : null,
  };
}

export function listHardwareDevices(db) {
  const rows = db.prepare(`
    SELECT h.site, h.device, h.label, h.note, h.profile, h.ui_meta, h.claimed_by, h.claimed_at, h.created_at,
           h.activated_hw, h.activated_at, h.activations,
           u.username AS claimed_username
    FROM hardware_devices h
    LEFT JOIN users u ON u.id = h.claimed_by
    ORDER BY h.created_at DESC
  `).all();
  return rows.map((r) => ({
    site: r.site,
    device: r.device,
    label: r.label || '',
    note: r.note || '',
    profile: r.profile || '',
    uiMeta: (() => { try { return r.ui_meta ? JSON.parse(r.ui_meta) : null; } catch { return null; } })(),
    claimed: Boolean(r.claimed_by),
    claimedBy: r.claimed_by || null,
    claimedUsername: r.claimed_username || null,
    claimedAt: r.claimed_at || null,
    activated: Boolean(r.activated_hw),
    activatedHw: r.activated_hw || null,
    activatedAt: r.activated_at || null,
    activations: r.activations || 0,
    createdAt: r.created_at,
  }));
}

/* ---------- Kích hoạt gateway offline bằng mã gõ tay (thử thách – đáp trả) ----------
 * Gateway có khoá riêng của máy K_dev (nạp lúc sản xuất, cất trong chip/eFuse).
 * K_dev = HMAC-SHA256(master, "plciot-act-key|" + HW) — server suy ra lại bất cứ lúc nào, không lưu.
 *  1. Gateway hiển thị YÊU CẦU = HW + NONCE (nonce 8 ký tự ngẫu nhiên mỗi lần).
 *  2. Admin dán yêu cầu → server trả MÃ 20 ký tự: EXP(3) + MAC(16) + CHECK(1), hiển thị nhóm 5.
 *     MAC = 80 bit đầu của HMAC-SHA256(K_dev, "act2|HW|NONCE|EXP").
 *  3. Gateway gõ mã, tự tính lại bằng K_dev → khớp là kích hoạt. Hoàn toàn offline.
 * Mã gắn với NONCE đang hiển thị nên không dùng lại được; chép sang máy khác thì phải xin admin mã mới
 * (mọi lần cấp đều qua admin → đếm được, phát hiện clone).
 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford, bỏ I L O U
const ACT_EPOCH_DAYS = 18262; // 2020-01-01 tính theo ngày kể từ 1970

function b32encode(buf) {
  let bits = 0; let acc = 0; let out = '';
  for (const byte of buf) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** Chuẩn hoá chuỗi gõ tay: hoa, bỏ khoảng trắng/gạch, O→0, I/L→1. */
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[\s\-_.]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

const b32check = (s) => {
  let sum = 0;
  for (let i = 0; i < s.length; i += 1) sum += B32.indexOf(s[i]) * (i + 1);
  return B32[sum % 32];
};

function activationMaster() {
  return process.env.ACTIVATION_MASTER_KEY || `fallback:${rawSecret()}`;
}

/** Khoá riêng của máy (hex). Dùng khi sản xuất để nạp vào gateway. */
export function deriveDeviceKey(hw) {
  return crypto.createHmac('sha256', activationMaster()).update(`plciot-act-key|${hw}`).digest('hex');
}

/** Tách yêu cầu từ gateway: 8 ký tự cuối là nonce, phần trước là ID máy (4–40 ký tự). */
export function parseActivationRequest(raw) {
  const s = normalizeCode(raw);
  if (!/^[0-9A-HJKMNP-TV-Z]{12,48}$/.test(s)) return null;
  return { hw: s.slice(0, -8), nonce: s.slice(-8) };
}

function activationMac(deviceKeyHex, hw, nonce, expChars) {
  return b32encode(
    crypto.createHmac('sha256', Buffer.from(deviceKeyHex, 'hex'))
      .update(`act2|${hw}|${nonce}|${expChars}`).digest().subarray(0, 10),
  );
}

const groupCode = (s) => s.match(/.{1,5}/g).join('-');

/** ID máy đứng một mình (chế độ khoá bản quyền): 4–40 ký tự Crockford. */
export function parseHardwareId(raw) {
  const s = normalizeCode(raw);
  return /^[0-9A-HJKMNP-TV-Z]{4,40}$/.test(s) ? s : null;
}

const licenseMac = (deviceKeyHex, hw, expChars) => b32encode(
  crypto.createHmac('sha256', Buffer.from(deviceKeyHex, 'hex'))
    .update(`lic1|${hw}|${expChars}`).digest().subarray(0, 10),
);

const expCharsOf = (days) => {
  const n = Math.max(0, Math.min(3650, Math.floor(Number(days) || 0)));
  const expDay = n ? Math.floor(Date.now() / 86400000) + n - ACT_EPOCH_DAYS : 0;
  return { expDay, expChars: B32[(expDay >> 10) & 31] + B32[(expDay >> 5) & 31] + B32[expDay & 31] };
};

/**
 * Cấp mã kích hoạt offline.
 *  mode 'license'   : khoá bản quyền như phần mềm thường — chỉ cần ID máy (in trên tem / hiện trên màn hình),
 *                     không cần máy hiện mã thử thách. Mã gắn ID máy + hạn dùng.
 *  mode 'challenge' : gateway hiện ID+nonce, mã chỉ dùng được một lần cho đúng nonce đó (chặt hơn).
 */
export function issueActivationCode(db, {
  site, device, request, days = 0, force = false, mode = 'challenge',
}) {
  const s = String(site || '').trim();
  const d = String(device || '').trim();
  const lic = mode === 'license';
  const hwOnly = lic ? parseHardwareId(request) : null;
  const req = lic ? (hwOnly && { hw: hwOnly, nonce: null }) : parseActivationRequest(request);
  if (!req) return { error: 'invalid_activation_request', status: 400 };
  const row = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(s, d);
  if (!row) return { error: 'not_found', status: 404 };
  const same = row.activated_hw === req.hw;
  if (row.activated_hw && !same && !force) return { error: 'device_already_activated', status: 409 };
  const { expDay, expChars } = expCharsOf(days);
  const key = deriveDeviceKey(req.hw);
  const mac = lic ? licenseMac(key, req.hw, expChars) : activationMac(key, req.hw, req.nonce, expChars);
  const body = expChars + mac;
  const code = groupCode(body + b32check(body));
  const count = same ? (row.activations || 0) + 1 : 1;
  db.prepare('UPDATE hardware_devices SET activated_hw = ?, activated_at = ?, activations = ? WHERE site = ? AND device = ?')
    .run(req.hw, Date.now(), count, s, d);
  return {
    ok: true, site: s, device: d, hw: req.hw, nonce: req.nonce, code, mode: lic ? 'license' : 'challenge',
    exp: expDay ? (expDay + ACT_EPOCH_DAYS + 1) * 86400 : 0,
    activations: count,
    rebound: Boolean(row.activated_hw && !same),
  };
}

/**
 * Gateway CÓ internet: gắn máy ngay lần enroll đầu (người đầu tiên thắng).
 * Cùng hw → ok; hw khác → 409 cho tới khi admin gỡ ràng buộc. Không gửi hw → không ràng buộc (tương thích cũ).
 */
export function bindGatewayHardware(db, { site, device, hw, required = false }) {
  const given = hw != null && hw !== '';
  const id = given ? parseHardwareId(hw) : null;
  if (given && !id) return { error: 'invalid_hw', status: 400 };
  if (!id) return required ? { error: 'hw_required', status: 400 } : { ok: true, bound: false };
  const row = db.prepare('SELECT activated_hw FROM hardware_devices WHERE site = ? AND device = ?').get(site, device);
  if (!row) return { error: 'unknown_device', status: 404 };
  if (row.activated_hw && row.activated_hw !== id) return { error: 'device_already_activated', status: 409 };
  if (!row.activated_hw) {
    db.prepare('UPDATE hardware_devices SET activated_hw = ?, activated_at = ?, activations = 1 WHERE site = ? AND device = ?')
      .run(id, Date.now(), site, device);
    return { ok: true, bound: true, first: true };
  }
  return { ok: true, bound: true, first: false };
}

/** Admin gỡ ràng buộc máy (chuyển sang máy khác), không đổi QR/MQTT. */
export function releaseGatewayHardware(db, { site, device }) {
  const r = db.prepare('UPDATE hardware_devices SET activated_hw = NULL, activated_at = NULL WHERE site = ? AND device = ?')
    .run(String(site || '').trim(), String(device || '').trim());
  return r.changes ? { ok: true } : { error: 'not_found', status: 404 };
}

/**
 * Phía gateway (tham chiếu / test): kiểm mã với hw, nonce đang hiển thị và khoá riêng của máy.
 * Trả error: activation_typo (gõ sai ký tự) | activation_wrong_device (sai mã/nonce/máy) | activation_expired.
 */
export function verifyActivationCode(code, { hw, nonce, deviceKey }, nowSec = Math.floor(Date.now() / 1000)) {
  const s = normalizeCode(code);
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(s)) return { error: 'activation_typo' };
  const body = s.slice(0, 19);
  if (b32check(body) !== s[19]) return { error: 'activation_typo' };
  const expChars = body.slice(0, 3);
  const want = activationMac(deviceKey, normalizeCode(hw), normalizeCode(nonce), expChars);
  const a = Buffer.from(want); const b = Buffer.from(body.slice(3));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'activation_wrong_device' };
  const v = B32.indexOf(expChars[0]) * 1024 + B32.indexOf(expChars[1]) * 32 + B32.indexOf(expChars[2]);
  const expDay = v;
  if (expDay && Math.floor(nowSec / 86400) > expDay + ACT_EPOCH_DAYS) return { error: 'activation_expired' };
  return { ok: true, expDay: expDay || 0 };
}

/** Phía gateway (tham chiếu): kiểm khoá bản quyền theo ID máy + khoá riêng, không cần nonce. */
export function verifyLicenseKey(code, { hw, deviceKey }, nowSec = Math.floor(Date.now() / 1000)) {
  const s = normalizeCode(code);
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(s)) return { error: 'activation_typo' };
  const body = s.slice(0, 19);
  if (b32check(body) !== s[19]) return { error: 'activation_typo' };
  const expChars = body.slice(0, 3);
  const a = Buffer.from(licenseMac(deviceKey, normalizeCode(hw), expChars));
  const b = Buffer.from(body.slice(3));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'activation_wrong_device' };
  const expDay = B32.indexOf(expChars[0]) * 1024 + B32.indexOf(expChars[1]) * 32 + B32.indexOf(expChars[2]);
  if (expDay && Math.floor(nowSec / 86400) > expDay + ACT_EPOCH_DAYS) return { error: 'activation_expired' };
  return { ok: true, expDay };
}

/** Lấy lại QR đã lưu (không xoay secret). */
export function getHardwareDeviceQr(db, { site, device, privateKeyPem }) {
  const s = String(site || '').trim();
  const d = String(device || '').trim();
  const row = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(s, d);
  if (!row) return { error: 'not_found', status: 404 };
  const secret = row.claim_sealed ? openSecret(row.claim_sealed) : null;
  if (!secret) return { error: 'claim_secret_unavailable', status: 409 };
  try {
    const bundle = buildQrBundle({
      site: s, device: d, claim: secret, privateKeyPem, label: row.label, note: row.note,
    });
    return {
      ok: true, ...bundle,
      claimed: Boolean(row.claimed_by),
      claimedBy: row.claimed_by || null,
      createdAt: row.created_at,
    };
  } catch (e) {
    return { error: e.message || 'claim_sign_failed', status: 503 };
  }
}

/** Xoay secret + QR mới (tem cũ hết hiệu lực). Huỷ liên kết claimed nếu admin buộc. */
export function reissueHardwareDeviceQr(db, { site, device, privateKeyPem, unclaim = false }) {
  const s = String(site || '').trim();
  const d = String(device || '').trim();
  const row = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(s, d);
  if (!row) return { error: 'not_found', status: 404 };
  if (row.claimed_by && !unclaim) return { error: 'device_already_claimed', status: 409 };
  return provisionHardwareDevice(db, {
    site: s, device: d, privateKeyPem,
    label: row.label || '', note: row.note || '', rotate: true,
  });
}

export function updateHardwareDeviceMeta(db, { site, device, label, note, profile, uiMeta }) {
  const s = String(site || '').trim();
  const d = String(device || '').trim();
  const row = db.prepare('SELECT 1 FROM hardware_devices WHERE site = ? AND device = ?').get(s, d);
  if (!row) return { error: 'not_found', status: 404 };
  const lab = label != null ? String(label).trim().slice(0, 120) : undefined;
  const nt = note != null ? String(note).trim().slice(0, 500) : undefined;
  const prof = profile != null ? String(profile).trim().slice(0, 64) : undefined;
  let metaJson;
  if (uiMeta !== undefined) {
    try { metaJson = uiMeta == null ? null : (typeof uiMeta === 'string' ? uiMeta : JSON.stringify(uiMeta)); } catch {
      return { error: 'invalid_ui_meta', status: 400 };
    }
  }
  if (lab !== undefined) db.prepare('UPDATE hardware_devices SET label = ? WHERE site = ? AND device = ?').run(lab || null, s, d);
  if (nt !== undefined) db.prepare('UPDATE hardware_devices SET note = ? WHERE site = ? AND device = ?').run(nt || null, s, d);
  if (prof !== undefined) db.prepare('UPDATE hardware_devices SET profile = ? WHERE site = ? AND device = ?').run(prof || null, s, d);
  if (metaJson !== undefined) db.prepare('UPDATE hardware_devices SET ui_meta = ? WHERE site = ? AND device = ?').run(metaJson, s, d);
  return { ok: true, site: s, device: d };
}

export function deleteHardwareDevice(db, { site, device, force = false }) {
  const s = String(site || '').trim();
  const d = String(device || '').trim();
  const row = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(s, d);
  if (!row) return { error: 'not_found', status: 404 };
  if (row.claimed_by && !force) return { error: 'device_already_claimed', status: 409 };
  db.prepare('DELETE FROM hardware_devices WHERE site = ? AND device = ?').run(s, d);
  return { ok: true };
}

/**
 * Quét QR tem → gắn site/device vào tài khoản ĐÃ đăng nhập (không tạo user mới).
 * Claim/đăng ký tài khoản tách nhau: chống spam tạo hàng loạt user từ QR trên trang login.
 */
export async function claimHardwareDevice(db, {
  qr, userId, ip, deviceId,
}) {
  if (!userId) return { error: 'unauthorized', status: 401 };
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!me || me.disabled) return { error: 'unauthorized', status: 401 };
  if (me.setup_complete === 0) return { error: 'setup_incomplete', status: 401 };

  const decoded = decodeClaimQr(qr);
  if (!decoded) return { error: 'invalid_claim_payload', status: 400 };
  const verified = verifyClaimSignature(decoded);
  if (verified.error) return verified;

  const row = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(verified.site, verified.device);
  if (!row) return { error: 'unknown_device', status: 404 };
  const claimHash = hashClaimSecret(verified.claim);
  if (row.claim_hash !== claimHash) return { error: 'invalid_claim_secret', status: 401 };

  if (row.claimed_by === me.id) {
    return { ok: true, already: true, user: me, site: verified.site, device: verified.device };
  }

  if (row.claimed_by) {
    const owner = db.prepare('SELECT id, setup_complete, disabled FROM users WHERE id = ?').get(row.claimed_by);
    if (owner && !owner.disabled && owner.setup_complete !== 0) {
      return { error: 'device_already_claimed', status: 409 };
    }
    // Chủ cũ bỏ dở đăng ký: giải phóng tem (không tạo user mới từ QR)
    if (owner && owner.setup_complete === 0) {
      db.prepare('DELETE FROM users WHERE id = ? AND setup_complete = 0').run(owner.id);
    }
    db.prepare('UPDATE hardware_devices SET claimed_by = NULL, claimed_at = NULL WHERE site = ? AND device = ?')
      .run(verified.site, verified.device);
  }

  const taken = db.prepare(
    'SELECT id FROM users WHERE notify_site = ? AND notify_device = ? AND disabled = 0 AND setup_complete = 1 AND id != ?',
  ).get(verified.site, verified.device, me.id);
  if (taken) return { error: 'site_taken', status: 409 };

  // Đang là chủ nhà máy khác còn thành viên → không chuyển lung tung
  const others = db.prepare(
    'SELECT COUNT(*) AS n FROM users WHERE notify_site = ? AND notify_device = ? AND id != ? AND disabled = 0',
  ).get(me.notify_site, me.notify_device, me.id).n;
  if (me.site_owner === 1 && others > 0
    && (me.notify_site !== verified.site || me.notify_device !== verified.device)) {
    return { error: 'owner_has_members', status: 409 };
  }

  db.prepare("UPDATE users SET notify_site = ?, notify_device = ?, site_owner = 1, role = COALESCE(NULLIF(role, ''), ?) WHERE id = ?")
    .run(verified.site, verified.device, 'operator', me.id);
  db.prepare('UPDATE hardware_devices SET claimed_by = ?, claimed_at = ? WHERE site = ? AND device = ?')
    .run(me.id, Date.now(), verified.site, verified.device);

  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
  const identity = getConfig().identity;
  if (typeof identity.onDeviceClaimed === 'function') {
    try {
      const hook = await identity.onDeviceClaimed(db, user, {
        site: verified.site, device: verified.device, ip, deviceId,
      });
      if (hook?.error) return hook;
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
    } catch (e) {
      console.error('claim.onDeviceClaimed', e?.message);
      return { error: 'provision_failed', status: 500 };
    }
  }

  audit(db, 'device_claimed', {
    userId: user.id, ip, detail: `${verified.site}/${verified.device}${deviceId ? ` dev=${deviceId}` : ''}`,
  });
  return {
    ok: true,
    user,
    site: verified.site,
    device: verified.device,
    browserDeviceId: deviceId || null,
  };
}

/** Chấp nhận mã mời (invite token) — tạo user ẩn danh gắn site, không phải chủ. */
export async function acceptInviteToken(db, {
  token, registrationContext = {}, ip,
}) {
  const code = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return { error: 'invalid_invite', status: 400 };
  const inv = db.prepare("SELECT * FROM site_invites WHERE id = ? AND status = 'pending'").get(code)
    || db.prepare("SELECT * FROM site_invites WHERE invite_token = ? AND status = 'pending'").get(code);
  if (!inv) return { error: 'not_found', status: 404 };
  if (Date.now() > inv.expires_at) {
    db.prepare("UPDATE site_invites SET status = 'expired' WHERE id = ?").run(inv.id);
    return { error: 'invite_expired', status: 410 };
  }

  const identity = getConfig().identity;
  let user;
  try {
    user = await identity.createAccount(db, {
      ...registrationContext,
      site: inv.site,
      device: inv.device,
      contact: null,
      role: inv.role,
      owner: false,
    });
  } catch (e) {
    console.error('invite.createAccount', e?.message);
    return { error: 'provision_failed', status: 500 };
  }
  if (user?.error) return user;

  db.prepare('UPDATE users SET setup_complete = 0, notify_site = ?, notify_device = ?, site_owner = 0, role = ? WHERE id = ?')
    .run(inv.site, inv.device, inv.role === 'viewer' ? 'viewer' : 'operator', user.id);
  db.prepare("UPDATE site_invites SET status = 'accepted' WHERE id = ?").run(inv.id);
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  audit(db, 'site_invite_accepted', { userId: user.id, ip, detail: `${inv.site}/${inv.device}` });
  return { ok: true, user, site: inv.site, device: inv.device, role: user.role };
}

/** Subject ổn định cho deviceProof (không dùng SĐT). */
export function identitySubject(user) {
  if (!user) return '';
  return String(user.username || user.id);
}

export function requireClaimRootConfigured() {
  if (!rawSecret() || String(rawSecret()).length < 16) return false;
  return Boolean(claimRootKeys().publicKey);
}
