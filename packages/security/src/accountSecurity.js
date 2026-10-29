/**
 * Account security: verified email, recovery codes, and phone-number change
 * (self-service + recovery tickets reviewed by an admin).
 *
 * Strength model for changing the phone (= the identity):
 *   strong  session + re-auth (passkey/TOTP) + OTP on OLD channel (Telegram/verified email) + OTP on NEW number → immediate
 *   weak    session/ticket + recovery code + OTP on NEW number               → cooling-off, owner notified
 *   lost    no session/code: ticket + OTP on NEW number + admin review       → cooling-off, owner notified
 * Every path notifies the old owner channels and is written to audit_log.
 */
import crypto from 'crypto';
import {
  findUserByPhone, findUserById,
} from './accounts.js';
import { getConfig, notify, rawSecret } from './config.js';
import { generateRecoveryCodes, recoveryCodesRemaining, tryRecoveryCode } from './recoveryCodes.js';
import { audit, countAudit } from './audit.js';
import { canonicalDeviceKey, verifyDeviceProof } from './deviceProof.js';
import { retryDeviceNotifications } from './deviceApproval.js';

const normalizePhone = (phone) => getConfig().identity.normalize(phone);
const isValidVnPhone = (phone) => getConfig().identity.valid(phone);
const formatVnLocal = (phone) => getConfig().identity.format(phone);
const emailConfigured = () => getConfig().email.configured();
const isValidEmail = (email) => getConfig().email.validate(email);
const sendEmail = (address, subject, text) => getConfig().email.sendAddress(address, subject, text);

const MIN = 60_000;
const HOUR = 3_600_000;
const OTP_TTL_MS = 5 * MIN;
const PENDING_TTL_MS = 30 * MIN;
const REVIEW_TTL_MS = 14 * 24 * HOUR;
const PLC_WINDOW_MS = 2 * MIN;
const MAX_OTP_FAILS = 5;
const ACTIVE = ['pending_otp', 'pending_review', 'cooling'];

const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
/** Cooling-off after a weak proof (recovery code). */
const coolingMs = () => num('PHONE_CHANGE_COOLING_HOURS', 24) * HOUR;
/** Cooling-off after admin approval of a recovery ticket. */
const reviewCoolingMs = () => num('RECOVERY_COOLING_HOURS', 48) * HOUR;
/** A freshly added email cannot act as "old channel" until this has passed. */
export const emailQuarantineMs = () => num('EMAIL_QUARANTINE_HOURS', 72) * HOUR;

function hashOtp(code) {
  return crypto.createHash('sha256').update(`otp:${code}`).digest('hex');
}
const genOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const maskPhone = (p) => {
  const l = formatVnLocal(p);
  return l.length > 6 ? `${l.slice(0, 3)}****${l.slice(-3)}` : l;
};

function publicUrl() {
  return getConfig().publicUrl();
}

/** Stateless owner-cancel token: HMAC(secret, id). */
export function cancelToken(id) {
  return crypto.createHmac('sha256', rawSecret())
    .update(`cancel:${id}`).digest('base64url').slice(0, 32);
}
const cancelLink = (id) => `${publicUrl()}/api/phone/cancel?id=${id}&t=${cancelToken(id)}`;

const getChange = (db, id) => db.prepare('SELECT * FROM phone_changes WHERE id = ?').get(String(id || ''));
const touch = (db, id, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE phone_changes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), Date.now(), id);
};

/** Kênh email dùng làm "kênh cũ" độc lập: đã cấu hình, đã xác minh và qua kỳ cách ly. (cắm vào @plciot/security) */
export function emailChannelAvailable(user) {
  return Boolean(emailConfigured() && user.email && user.email_verified
    && Date.now() >= (user.email_verified_at || 0) + emailQuarantineMs());
}

/* ---------------------------------------------------------------- notify */

/** HTML của tin Telegram → văn bản cho email. Giữ địa chỉ của liên kết (link huỷ 1 chạm): gỡ thẻ thô sẽ làm mất nó. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${label.replace(/<[^>]+>/g, '')}:\n${href}\n`) // link riêng một dòng: dấu câu liền sau không dính vào địa chỉ
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

/** Tell the account owner (current Telegram + verified email). Never throws. */
export async function notifyOwner(db, user, { subject, html, text }) {
  return notify(db, user, { subject, html, text });
}

async function sendOtpContact(contact, code, what) {
  return getConfig().identity.sendCode(contact, code, what);
}

/* ----------------------------------------------------------------- email */

export function accountSecuritySummary(db, user) {
  const pending = db.prepare(
    `SELECT id, kind, new_phone, status, execute_at, created_at FROM phone_changes
     WHERE user_id = ? AND status IN ('pending_otp','pending_review','cooling') ORDER BY created_at DESC`,
  ).all(user.id).map((r) => ({
    id: r.id, kind: r.kind, newPhone: formatVnLocal(r.new_phone), status: r.status,
    executeAt: r.execute_at, createdAt: r.created_at,
  }));
  const quarantineEnds = user.email_verified_at ? user.email_verified_at + emailQuarantineMs() : null;
  return {
    phone: user.phone || user.username,
    phoneLocal: formatVnLocal(user.phone || user.username),
    contactLinked: Boolean(getConfig().identity.contact(user)),
    telegramLinked: Boolean(getConfig().identity.contact(user)),
    email: user.email || null,
    emailVerified: Boolean(user.email_verified),
    emailUsableAt: user.email_verified && quarantineEnds && quarantineEnds > Date.now() ? quarantineEnds : null,
    emailEnabled: emailConfigured(),
    hasPassword: Boolean(user.login_password_hash),
    recoveryCodesRemaining: recoveryCodesRemaining(db, user.id),
    coolingHours: coolingMs() / HOUR,
    ...getConfig().accountExtra(user),
    pending,
  };
}

/** Xác nhận lại danh tính: phải đã qua step-up (vân tay/Authenticator) hoặc vừa đăng nhập — middleware reauth đặt cờ này. */
function requireReauth(reauthed) {
  return reauthed === true;
}

export async function requestEmailVerify(db, user, { email, reauthed, ip }) {
  if (!emailConfigured()) return { error: 'email_disabled', status: 501 };
  if (!requireReauth(reauthed)) return { error: 'invalid_credentials', status: 401 };
  const addr = String(email || '').trim().toLowerCase();
  if (!isValidEmail(addr)) return { error: 'invalid_email', status: 400 };
  if (countAudit(db, user.id, 'email_verify_request', Date.now() - HOUR) >= 5) {
    return { error: 'rate_limited', status: 429 };
  }
  const code = genOtp();
  db.prepare(`
    INSERT INTO email_challenges (user_id, email, code_hash, expires_at, fails) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash,
      expires_at = excluded.expires_at, fails = 0
  `).run(user.id, addr, hashOtp(code), Date.now() + OTP_TTL_MS);
  try {
    await sendEmail(addr, 'Mã xác minh email — Giám sát PLC', `Mã xác minh email của bạn: ${code}\nHiệu lực 5 phút.`);
  } catch (e) {
    return { error: 'email_send_failed', status: 502 };
  }
  audit(db, 'email_verify_request', { userId: user.id, ip, detail: addr });
  return { ok: true, expiresIn: OTP_TTL_MS / 1000 };
}

export async function verifyEmail(db, user, { otp, ip }) {
  const ch = db.prepare('SELECT * FROM email_challenges WHERE user_id = ?').get(user.id);
  if (!ch) return { error: 'otp_missing', status: 400 };
  if (Date.now() > ch.expires_at) {
    db.prepare('DELETE FROM email_challenges WHERE user_id = ?').run(user.id);
    return { error: 'otp_expired', status: 400 };
  }
  if (ch.fails >= MAX_OTP_FAILS) return { error: 'otp_locked', status: 429 };
  if (!safeEq(hashOtp(String(otp || '').trim()), ch.code_hash)) {
    db.prepare('UPDATE email_challenges SET fails = fails + 1 WHERE user_id = ?').run(user.id);
    return { error: 'otp_invalid', status: 401 };
  }
  const prev = findUserById(db, user.id);
  db.prepare('UPDATE users SET email = ?, email_verified = 1, email_verified_at = ? WHERE id = ?')
    .run(ch.email, Date.now(), user.id);
  db.prepare('DELETE FROM email_challenges WHERE user_id = ?').run(user.id);
  audit(db, 'email_verified', { userId: user.id, ip, detail: ch.email });
  // Warn through the *previous* channels: an attacker adding an email must not be silent.
  notifyOwner(db, prev, {
    subject: 'Đã thêm email khôi phục',
    html: `<b>📧 Email khôi phục mới đã được thêm</b> (${esc(ch.email)}).\n`
      + `Email chỉ dùng được để xác minh đổi số sau ${emailQuarantineMs() / HOUR} giờ.\n`
      + 'Nếu không phải bạn, hãy đổi mật khẩu ngay.',
  });
  return { ok: true, email: ch.email, usableAt: Date.now() + emailQuarantineMs() };
}

/* -------------------------------------------------------- recovery codes */

export async function regenerateRecoveryCodes(db, user, { reauthed, ip }) {
  if (!requireReauth(reauthed)) return { error: 'invalid_credentials', status: 401 };
  const codes = generateRecoveryCodes(db, user.id);
  audit(db, 'recovery_codes_regenerated', { userId: user.id, ip });
  notifyOwner(db, user, {
    subject: 'Mã khôi phục đã được tạo lại',
    html: '<b>🔑 Bộ mã khôi phục mới đã được tạo</b>; bộ cũ không còn hiệu lực.\nNếu không phải bạn, hãy đổi mật khẩu ngay.',
  });
  return { ok: true, codes };
}

/* --------------------------------------------------- phone change (self) */

async function prepareNewPhone(db, user, newPhoneRaw) {
  const newPhone = normalizePhone(newPhoneRaw);
  if (!isValidVnPhone(newPhone)) return { error: 'invalid_phone', status: 400 };
  if (newPhone === (user.phone || user.username)) return { error: 'same_phone', status: 400 };
  const taken = findUserByPhone(db, newPhone);
  if (taken && taken.id !== user.id) return { error: 'phone_in_use', status: 409 };
  const contact = await getConfig().identity.resolveContact(db, newPhone);
  if (!contact) return { error: `new_phone_${getConfig().identity.unavailableError}`, status: 400 };
  if (getConfig().identity.findContactOwner(db, contact, user.id)) return { error: 'contact_in_use', status: 409 };
  return { newPhone, contact };
}

function newChangeId() {
  return crypto.randomBytes(16).toString('hex');
}

export async function startSelfChange(db, user, { newPhone, reauthed, oldChannel, ip, sessionId }) {
  if (!requireReauth(reauthed)) {
    audit(db, 'phone_change_unauthorised', { userId: user.id, ip });
    return { error: 'invalid_credentials', status: 401 };
  }
  if (db.prepare("SELECT 1 FROM phone_changes WHERE user_id = ? AND status IN ('pending_review','cooling')").get(user.id)) {
    return { error: 'change_already_pending', status: 409 };
  }
  if (countAudit(db, user.id, 'phone_change_start', Date.now() - 24 * HOUR) >= 5) {
    return { error: 'rate_limited', status: 429 };
  }
  const prep = await prepareNewPhone(db, user, newPhone);
  if (prep.error) return prep;

  const channel = ['email', 'recovery_code'].includes(oldChannel) ? oldChannel : 'primary';
  if (channel === 'primary' && !getConfig().identity.contact(user)) return { error: 'old_channel_unavailable', status: 400 };
  if (channel === 'email') {
    if (!user.email || !user.email_verified) return { error: 'old_channel_unavailable', status: 400 };
    if (Date.now() < (user.email_verified_at || 0) + emailQuarantineMs()) {
      return { error: 'email_quarantine', usableAt: (user.email_verified_at || 0) + emailQuarantineMs(), status: 403 };
    }
  }
  if (channel === 'recovery_code' && recoveryCodesRemaining(db, user.id) === 0) {
    return { error: 'no_recovery_codes', status: 400 };
  }

  db.prepare("UPDATE phone_changes SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status = 'pending_otp'")
    .run(Date.now(), user.id);

  const id = newChangeId();
  const newCode = genOtp();
  const oldCode = channel === 'recovery_code' ? null : genOtp();
  const now = Date.now();
  db.prepare(`
    INSERT INTO phone_changes (id, user_id, kind, old_phone, new_phone, new_contact, status,
      new_otp_hash, old_otp_hash, old_channel, otp_expires_at, created_ip, created_at, updated_at)
    VALUES (?, ?, 'self', ?, ?, ?, 'pending_otp', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user.id, user.phone || user.username, prep.newPhone, prep.contact,
    hashOtp(newCode), oldCode ? hashOtp(oldCode) : null, channel, now + OTP_TTL_MS, ip || null, now, now);
  if (sessionId) touch(db, id, { session_id: sessionId });

  try {
    await sendOtpContact(prep.contact, newCode, `Mã xác nhận SỐ MỚI ${formatVnLocal(prep.newPhone)}`);
    if (channel === 'primary') await sendOtpContact(getConfig().identity.contact(user), oldCode, 'Mã xác nhận ĐỔI SỐ ĐIỆN THOẠI tài khoản');
    if (channel === 'email') {
      await sendEmail(user.email, 'Mã xác nhận đổi số điện thoại — Giám sát PLC',
        `Mã xác nhận đổi số điện thoại sang ${formatVnLocal(prep.newPhone)}: ${oldCode}\nHiệu lực 5 phút.`);
    }
  } catch (e) {
    touch(db, id, { status: 'cancelled' });
    return { error: 'otp_send_failed', status: 502 };
  }
  audit(db, 'phone_change_start', { userId: user.id, ip, detail: `${channel} → ${prep.newPhone}` });
  return { ok: true, id, oldChannel: channel, newPhoneMasked: maskPhone(prep.newPhone), expiresIn: OTP_TTL_MS / 1000 };
}

function otpGate(db, row, id) {
  if (!row) return { error: 'request_not_found', status: 404 };
  if (row.status !== 'pending_otp') return { error: 'request_not_pending', status: 409 };
  if (Date.now() > row.otp_expires_at) {
    touch(db, id, { status: 'expired' });
    return { error: 'otp_expired', status: 400 };
  }
  if (row.new_fails + row.old_fails >= MAX_OTP_FAILS) return { error: 'otp_locked', status: 429 };
  return null;
}

export async function confirmSelfChange(db, user, { id, newOtp, oldOtp, recoveryCode, ip, sessionId }) {
  const row = getChange(db, id);
  if (row && (row.user_id !== user.id || row.kind !== 'self')) return { error: 'request_not_found', status: 404 };
  const gate = otpGate(db, row, id);
  if (gate) return gate;
  if (row.session_id && row.session_id !== sessionId) return { error: 'reauth_required', status: 401 };

  const fail = (field) => {
    db.prepare(`UPDATE phone_changes SET ${field} = ${field} + 1 WHERE id = ?`).run(id);
    audit(db, 'phone_change_otp_fail', { userId: user.id, ip, detail: field });
  };
  if (!safeEq(hashOtp(String(newOtp || '').trim()), row.new_otp_hash)) { fail('new_fails'); return { error: 'otp_invalid', which: 'new', status: 401 }; }

  let strong = false;
  if (row.old_channel === 'recovery_code') {
    const r = tryRecoveryCode(db, user, recoveryCode, ip);
    if (r === 'locked') return { error: 'recovery_locked', status: 429 };
    if (r !== 'ok') { fail('old_fails'); return { error: 'recovery_code_invalid', status: 401 }; }
  } else {
    if (!safeEq(hashOtp(String(oldOtp || '').trim()), row.old_otp_hash)) { fail('old_fails'); return { error: 'otp_invalid', which: 'old', status: 401 }; }
    strong = true;
  }

  touch(db, id, { new_verified: 1, old_verified: strong ? 1 : 0, recovery_code_ok: strong ? 0 : 1 });
  if (strong) {
    const delivery = await notifyOwner(db, user, {
      subject: 'Xác nhận thay đổi số điện thoại',
      html: `<b>Yêu cầu đổi số tài khoản</b>: ${esc(formatVnLocal(row.old_phone))} → ${esc(formatVnLocal(row.new_phone))}.`,
    });
    if (!delivery?.delivered) return { error: 'notification_required', status: 503 };
    touch(db, id, { notification_state: 'delivered' });
    const res = await applyChange(db, id, { by: 'self-strong', ip });
    return res.error ? res : { ok: true, status: 'applied', phone: res.user.phone };
  }
  const executeAt = Date.now() + coolingMs();
  touch(db, id, { status: 'cooling', execute_at: executeAt });
  audit(db, 'phone_change_cooling', { userId: user.id, ip, detail: `until ${new Date(executeAt).toISOString()}` });
  await notifyCooling(db, user, row, executeAt);
  return { ok: true, status: 'cooling', executeAt };
}

async function notifyCooling(db, user, row, executeAt) {
  const when = new Date(executeAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const delivery = await notifyOwner(db, user, {
    subject: 'Yêu cầu đổi số điện thoại đang chờ',
    html: `<b>⚠️ Yêu cầu đổi SĐT tài khoản</b>\n${esc(formatVnLocal(row.old_phone))} → ${esc(formatVnLocal(row.new_phone))}\n`
      + `Sẽ có hiệu lực lúc <b>${esc(when)}</b>.\n\n`
      + `Nếu KHÔNG phải bạn, bấm huỷ: ${cancelLink(row.id)}`,
  });
  touch(db, row.id, { notification_state: delivery?.delivered ? 'delivered' : 'failed' });
  return Boolean(delivery?.delivered);
}

/* -------------------------------------------------------------- apply */

/** Move the account to the new phone. Idempotent on status; revokes every old session. */
export async function applyChange(db, id, { by, ip } = {}) {
  const row = getChange(db, id);
  if (!row || !['pending_otp', 'cooling'].includes(row.status)) return { error: 'request_not_pending', status: 409 };
  const user = findUserById(db, row.user_id);
  if (!user) { touch(db, id, { status: 'rejected', note: 'user_gone' }); return { error: 'user_not_found', status: 404 }; }
  if (!row.new_verified || (row.status === 'cooling' && row.execute_at > Date.now())) return { error: 'request_not_ready', status: 409 };
  if (row.notification_state !== 'delivered') return { error: 'notification_required', status: 503 };
  if (row.kind === 'recovery' && (!row.recovery_device || !canonicalDeviceKey(row.recovery_public_key))) return { error: 'recovery_device_required', status: 409 };
  try { await getConfig().identity.beforePhoneApplied(db, user); }
  catch { return { error: 'credential_rotation_failed', status: 503 }; }

  const tx = db.transaction(() => {
    const current = getChange(db, id);
    if (!current || !['pending_otp', 'cooling'].includes(current.status)) throw new Error('request_not_pending');
    const currentUser = findUserById(db, user.id);
    if ((currentUser.phone || currentUser.username) !== row.old_phone) throw new Error('identity_changed');
    const other = findUserByPhone(db, row.new_phone);
    if (other && other.id !== user.id) throw new Error('phone_in_use');
    db.prepare(`
      UPDATE users SET username = ?, phone = ?, token_version = token_version + 1 WHERE id = ?
    `).run(row.new_phone, row.new_phone, user.id);
    getConfig().identity.applyContact(db, user, row.new_contact, row.new_phone);
    db.prepare('DELETE FROM app_sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM login_attempts WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE control_sessions SET revoked = 1 WHERE user_id = ?').run(user.id);
    db.prepare("UPDATE device_requests SET status = 'cancelled', ticket_hash = NULL WHERE user_id = ? AND status IN ('pending','cooling','approved')").run(user.id);
    if (row.kind === 'recovery') {
      db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(user.id);
      db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = 0, recovery_required = 1 WHERE id = ?').run(user.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
      db.prepare('UPDATE auth_devices SET revoked = 1 WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM auth_devices WHERE user_id = ? AND device_id = ?').run(user.id, row.recovery_device);
      db.prepare('INSERT OR REPLACE INTO recovery_enrollments (user_id, change_id, device_id, public_key, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, row.id, row.recovery_device, row.recovery_public_key, Date.now() + 7 * 86400_000);
    }
    db.prepare("UPDATE phone_changes SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND id != ? AND status IN ('pending_otp','pending_review','cooling')")
      .run(Date.now(), user.id, id);
    touch(db, id, { status: 'applied', reviewed_by: by || row.reviewed_by || null });
  });
  try {
    tx();
  } catch (e) {
    const current = getChange(db, id);
    if (!current || !['pending_otp', 'cooling'].includes(current.status)) return { error: 'request_not_pending', status: 409 };
    touch(db, id, { status: 'rejected', note: e.message });
    audit(db, 'phone_change_rejected', { userId: user.id, ip, detail: e.message });
    return { error: e.message === 'phone_in_use' ? 'phone_in_use' : 'apply_failed', status: 409 };
  }
  audit(db, 'phone_change_applied', { userId: user.id, ip, detail: `${row.old_phone} → ${row.new_phone} (${by || 'auto'})` });

  // Old sessions are dead (token_version); rotate broker credentials so cached MQTT creds die too.

  const fresh = findUserById(db, user.id);
  // Tell the old owner channels (old chat_id may differ from the new one).
  const old = { ...user };
  notifyOwner(db, old, {
    subject: 'Số điện thoại tài khoản đã được đổi',
    html: `<b>📱 SĐT tài khoản đã đổi</b>: ${esc(formatVnLocal(row.old_phone))} → ${esc(formatVnLocal(row.new_phone))}.\n`
      + 'Mọi phiên đăng nhập cũ đã bị đăng xuất. Nếu không phải bạn, liên hệ quản trị ngay.',
  });
  return { ok: true, user: fresh };
}

/* ------------------------------------------------------------- cancel */

export async function cancelChange(db, id, { userId = null, token = null, ip = null }) {
  const row = getChange(db, id);
  if (!row) return { error: 'request_not_found', status: 404 };
  const byOwner = userId != null && row.user_id === userId;
  const byToken = token && safeEq(token, cancelToken(row.id));
  if (!byOwner && !byToken) return { error: 'forbidden', status: 403 };
  if (!ACTIVE.includes(row.status)) return { error: 'request_not_pending', status: 409 };
  touch(db, id, { status: 'cancelled', note: byToken ? 'cancelled_by_owner_link' : 'cancelled_by_session' });
  audit(db, 'phone_change_cancelled', { userId: row.user_id, ip, detail: byToken ? 'link' : 'session' });
  const user = findUserById(db, row.user_id);
  if (user) {
    notifyOwner(db, user, {
      subject: 'Đã huỷ yêu cầu đổi số',
      html: '<b>🛑 Yêu cầu đổi/khôi phục SĐT đã bị huỷ.</b> Nếu không phải bạn thực hiện, hãy đổi mật khẩu.',
    });
  }
  return { ok: true };
}

/* ------------------------------------------------- recovery (no session) */

export async function startRecovery(db, { oldPhone, newPhone, note, ip, deviceId, publicKey, deviceProof }) {
  const op = normalizePhone(oldPhone);
  if (!isValidVnPhone(op)) return { error: 'invalid_phone', status: 400 };
  const user = findUserByPhone(db, op);
  if (!user) return { error: 'user_not_found', status: 404 };
  if (db.prepare("SELECT 1 FROM phone_changes WHERE user_id = ? AND status IN ('pending_review','cooling')").get(user.id)) {
    return { error: 'change_already_pending', status: 409 };
  }
  if (countAudit(db, user.id, 'recovery_start', Date.now() - 24 * HOUR) >= 3) {
    return { error: 'rate_limited', status: 429 };
  }
  const prep = await prepareNewPhone(db, user, newPhone);
  if (prep.error) return prep;
  const key = canonicalDeviceKey(publicKey);
  if (!verifyDeviceProof(db, { subject: prep.newPhone, deviceId, action: '/api/recovery/start', publicKey: key, proof: deviceProof })) {
    return { error: 'device_proof_required', status: 401 };
  }

  db.prepare("UPDATE phone_changes SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status = 'pending_otp'")
    .run(Date.now(), user.id);

  const id = newChangeId();
  const code = genOtp();
  const now = Date.now();
  db.prepare(`
    INSERT INTO phone_changes (id, user_id, kind, old_phone, new_phone, new_contact, status,
      new_otp_hash, otp_expires_at, note, created_ip, created_at, updated_at)
    VALUES (?, ?, 'recovery', ?, ?, ?, 'pending_otp', ?, ?, ?, ?, ?, ?)
  `).run(id, user.id, user.phone || user.username, prep.newPhone, prep.contact,
    hashOtp(code), now + OTP_TTL_MS, String(note || '').slice(0, 500), ip || null, now, now);
  touch(db, id, { recovery_device: deviceId, recovery_public_key: key });
  try {
    await sendOtpContact(prep.contact, code, `Mã xác nhận SỐ MỚI ${formatVnLocal(prep.newPhone)} (khôi phục tài khoản)`);
  } catch (e) {
    touch(db, id, { status: 'cancelled' });
    return { error: 'otp_send_failed', status: 502 };
  }
  audit(db, 'recovery_start', { userId: user.id, ip, detail: prep.newPhone });
  // The real owner learns immediately, with a one-click veto.
  notifyOwner(db, user, {
    subject: 'Có yêu cầu khôi phục tài khoản',
    html: `<b>⚠️ Có người yêu cầu khôi phục tài khoản</b> và chuyển sang số ${esc(formatVnLocal(prep.newPhone))}.\n`
      + `Nếu KHÔNG phải bạn, bấm huỷ: ${cancelLink(id)}`,
  });
  return { ok: true, id, newPhoneMasked: maskPhone(prep.newPhone), expiresIn: OTP_TTL_MS / 1000 };
}

export async function confirmRecovery(db, { id, newOtp, recoveryCode, ip }) {
  const row = getChange(db, id);
  if (row && row.kind !== 'recovery') return { error: 'request_not_found', status: 404 };
  const gate = otpGate(db, row, id);
  if (gate) return gate;
  const user = findUserById(db, row.user_id);
  if (!safeEq(hashOtp(String(newOtp || '').trim()), row.new_otp_hash)) {
    db.prepare('UPDATE phone_changes SET new_fails = new_fails + 1 WHERE id = ?').run(id);
    audit(db, 'phone_change_otp_fail', { userId: row.user_id, ip, detail: 'recovery' });
    return { error: 'otp_invalid', status: 401 };
  }
  touch(db, id, { new_verified: 1 });

  if (recoveryCode) {
    const r = tryRecoveryCode(db, user, recoveryCode, ip);
    if (r === 'locked') return { error: 'recovery_locked', status: 429 };
    if (r === 'ok') {
      const executeAt = Date.now() + coolingMs();
      touch(db, id, { status: 'cooling', recovery_code_ok: 1, execute_at: executeAt });
      audit(db, 'recovery_cooling', { userId: user.id, ip, detail: 'recovery code' });
      await notifyCooling(db, user, row, executeAt);
      return { ok: true, status: 'cooling', executeAt };
    }
    // Wrong code: do not fall through silently; the ticket still goes to admin but is flagged.
    touch(db, id, { note: `${row.note || ''} [recovery code sai]`.trim() });
  }
  touch(db, id, { status: 'pending_review' });
  return { ok: true, status: 'pending_review' };
}

export function recoveryStatus(db, id) {
  const row = getChange(db, id);
  if (!row || row.kind !== 'recovery') return { error: 'request_not_found', status: 404 };
  return {
    ok: true,
    status: row.status,
    executeAt: row.execute_at,
    newPhone: formatVnLocal(row.new_phone),
    plcOk: Boolean(row.plc_ok),
    plcBit: row.plc_expires_at && Date.now() < row.plc_expires_at && !row.plc_ok ? row.plc_bit : null,
    plcExpiresAt: row.plc_expires_at && Date.now() < row.plc_expires_at ? row.plc_expires_at : null,
  };
}

/** Challenge: flip PLC input X<bit> at the site within 2 minutes. */
export function startPlcChallenge(db, id) {
  const row = getChange(db, id);
  if (!row || row.kind !== 'recovery') return { error: 'request_not_found', status: 404 };
  if (!row.new_verified || !['pending_review', 'cooling'].includes(row.status)) return { error: 'request_not_pending', status: 409 };
  const user = findUserById(db, row.user_id);
  const presence = getConfig().presence.start(db, user);
  if (presence.error) return presence;
  const bit = presence.bit;
  const startedAt = Date.now();
  touch(db, id, { plc_bit: bit, plc_base: startedAt, plc_expires_at: startedAt + PLC_WINDOW_MS, plc_ok: 0 });
  audit(db, 'plc_challenge_start', { userId: user.id, detail: `X${bit}` });
  return { ok: true, bit, expiresIn: PLC_WINDOW_MS / 1000 };
}

export function checkPlcChallenge(db, id) {
  const row = getChange(db, id);
  if (!row || row.kind !== 'recovery') return { error: 'request_not_found', status: 404 };
  if (row.plc_ok) return { ok: true, plcOk: true };
  if (row.plc_bit == null || !row.plc_expires_at) return { error: 'no_challenge', status: 409 };
  const user = findUserById(db, row.user_id);
  if (Date.now() > row.plc_expires_at) return { error: 'plc_challenge_expired', status: 410 };
  if (getConfig().presence.check(db, user, row).ok) {
    touch(db, id, { plc_ok: 1 });
    audit(db, 'plc_challenge_ok', { userId: user.id, detail: `X${row.plc_bit}` });
    return { ok: true, plcOk: true };
  }
  if (Date.now() > row.plc_expires_at) return { error: 'plc_challenge_expired', status: 410 };
  return { ok: true, plcOk: false };
}

/* ------------------------------------------------------- admin (CLI) */

export function listChanges(db, status) {
  const rows = status
    ? db.prepare('SELECT * FROM phone_changes WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(status)
    : db.prepare('SELECT * FROM phone_changes ORDER BY created_at DESC LIMIT 100').all();
  return rows;
}

export function getChangeRow(db, id) { return getChange(db, id); }

export async function approveRecovery(db, id, { hours, admin = 'admin', evidence } = {}) {
  const row = getChange(db, id);
  if (!row) return { error: 'request_not_found' };
  if (row.status !== 'pending_review') return { error: 'request_not_pending_review' };
  if (!row.new_verified) return { error: 'new_phone_not_verified' };
  const ms = hours != null ? Number(hours) * HOUR : reviewCoolingMs();
  if (!Number.isFinite(ms) || ms < reviewCoolingMs()) return { error: 'cooling_period_too_short', status: 400 };
  if (typeof evidence !== 'string' || evidence.trim().length < 12) return { error: 'review_evidence_required', status: 400 };
  const executeAt = Date.now() + ms;
  touch(db, id, { status: 'cooling', execute_at: executeAt, reviewed_by: admin, review_evidence: evidence.trim().slice(0, 500) });
  audit(db, 'recovery_approved', { userId: row.user_id, detail: `by ${admin}, until ${new Date(executeAt).toISOString()}` });
  const user = findUserById(db, row.user_id);
  await notifyCooling(db, user, row, executeAt);
  return { ok: true, executeAt };
}

export async function rejectChange(db, id, { reason = '', admin = 'admin' } = {}) {
  const row = getChange(db, id);
  if (!row) return { error: 'request_not_found' };
  if (!ACTIVE.includes(row.status)) return { error: 'request_not_active' };
  touch(db, id, { status: 'rejected', note: `${row.note || ''} [rejected: ${reason}]`.trim(), reviewed_by: admin });
  audit(db, 'recovery_rejected', { userId: row.user_id, detail: `by ${admin}: ${reason}` });
  return { ok: true };
}

/** Run every minute: expire stale rows, apply cooled-off ones. */
export async function processDueChanges(db) {
  await retryDeviceNotifications(db);
  const now = Date.now();
  db.prepare("UPDATE phone_changes SET status = 'expired', updated_at = ? WHERE status = 'pending_otp' AND created_at < ?")
    .run(now, now - PENDING_TTL_MS);
  db.prepare("UPDATE phone_changes SET status = 'expired', updated_at = ? WHERE status = 'pending_review' AND created_at < ?")
    .run(now, now - REVIEW_TTL_MS);
  const due = db.prepare("SELECT id FROM phone_changes WHERE status = 'cooling' AND execute_at <= ?").all(now);
  for (const { id } of due) {
    const row = getChange(db, id);
    if (row.notification_state !== 'delivered') {
      const delay = row.recovery_code_ok ? coolingMs() : reviewCoolingMs();
      if (await notifyCooling(db, findUserById(db, row.user_id), row, now + delay)) touch(db, id, { execute_at: now + delay });
      continue;
    }
    const r = await applyChange(db, id, { by: 'cooling-elapsed' });
    if (r.error) console.error('processDueChanges', id, r.error);
  }
  return due.length;
}
