import crypto from 'crypto';
import {
  createOtpChallenge, getOtpChallenge, bumpOtpFail, deleteOtpChallenge,
  findUserByPhone,
} from './accounts.js';
import { getConfig } from './config.js';

const normalizePhone = (phone) => getConfig().identity.normalize(phone);
const isValidVnPhone = (phone) => getConfig().identity.valid(phone);

/* Ngân sách theo SỐ ĐIỆN THOẠI (bất kể IP): chặn đoán OTP phân tán và spam Telegram nạn nhân. */
const HOUR = 3_600_000;
const reqLog = new Map(); // phone -> mốc thời gian xin OTP
const failLog = new Map(); // phone -> mốc thời gian nhập sai
const recent = (map, key, windowMs, now = Date.now()) => { const a = (map.get(key) || []).filter((t) => now - t < windowMs); map.set(key, a); return a; };
const OTP_REQ_PER_HOUR = () => Number(process.env.OTP_REQ_PER_PHONE_HOUR || 6);
const OTP_FAIL_PER_15MIN = () => Number(process.env.OTP_FAIL_PER_PHONE_15MIN || 10);
function takeRequestBudget(phone) {
  const a = recent(reqLog, phone, HOUR);
  if (a.length >= OTP_REQ_PER_HOUR()) return false;
  a.push(Date.now());
  return true;
}
const failLocked = (phone) => recent(failLog, phone, 15 * 60_000).length >= OTP_FAIL_PER_15MIN();
const noteFail = (phone) => recent(failLog, phone, 15 * 60_000).push(Date.now());

/** Hạn của mã OTP (giây). Mặc định 180: Telegram gửi gần như tức thì, 3 phút đủ để chuyển app mà cửa sổ bị đoán còn ngắn. */
const otpTtlSec = () => Math.max(60, Math.min(600, Number(process.env.OTP_CODE_TTL_SEC || 180)));
const isCompleteUser = (user) => Boolean(user) && user.setup_complete !== 0;

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function genCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function requestRegisterOtp(db, { phone }) {
  const p = normalizePhone(phone);
  if (!isValidVnPhone(p)) return { error: 'invalid_phone', status: 400 };

  // username === canonical VN phone (84…). Tài khoản chưa hoàn tất (setup_complete = 0) được phép đăng ký lại để làm tiếp.
  if (isCompleteUser(findUserByPhone(db, p))) return { error: 'user_exists', status: 409 };
  if (!takeRequestBudget(p)) return { error: 'rate_limited', status: 429 };

  // Must already have shared phone with Telegram bot (mqtt_server / local)
  const contact = await getConfig().identity.resolveContact(db, p);
  if (!contact) return { error: getConfig().identity.unavailableError, status: 400 };

  const code = genCode();
  const challenge = createOtpChallenge(db, {
    ttlSec: otpTtlSec(),
    phone: p,
    purpose: 'register',
    codeHash: hashCode(code),
    contact,
  });

  try {
    await getConfig().identity.sendCode(contact, code, 'Đăng ký tài khoản');
  } catch (e) {
    deleteOtpChallenge(db, challenge.id);
    return { error: getConfig().identity.sendError, status: 502 };
  }
  return { ok: true, phone: p, expiresIn: otpTtlSec() };
}

export async function verifyRegisterOtp(db, { phone, otp, ...context }) {
  const p = normalizePhone(phone);
  if (failLocked(p)) return { error: 'otp_locked', status: 429 };
  const ch = getOtpChallenge(db, p, 'register');
  if (!ch) return { error: 'otp_missing', status: 400 };
  if (Date.now() > ch.expires_at) {
    deleteOtpChallenge(db, ch.id);
    return { error: 'otp_expired', status: 400 };
  }
  if (ch.fails >= 5) return { error: 'otp_locked', status: 429 };
  if (hashCode(otp) !== ch.code_hash) {
    bumpOtpFail(db, ch.id);
    noteFail(p);
    return { error: 'otp_invalid', status: 401 };
  }

  if (isCompleteUser(findUserByPhone(db, p))) return { error: 'user_exists', status: 409 };
  if (deleteOtpChallenge(db, ch.id).changes !== 1) return { error: 'otp_missing', status: 400 };
  const contact = await getConfig().identity.resolveContact(db, p);
  if (!contact) return { error: getConfig().identity.unavailableError, status: 400 };
  if (ch.contact_id && String(contact) !== ch.contact_id) return { error: 'contact_changed', status: 409 };
  const user = await getConfig().identity.createAccount(db, { phone: p, contact, ...context });
  if (user.error) return user;
  // Chỉ hoàn tất khi đặt mật khẩu hoặc đăng ký sinh trắc thành công (quá 24 giờ chưa hoàn tất thì bị xoá).
  db.prepare('UPDATE users SET setup_complete = 0 WHERE id = ? AND login_password_hash IS NULL').run(user.id);
  return { ok: true, user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
}

export async function requestLoginOtp(db, { phone }) {
  const p = normalizePhone(phone);
  if (!isValidVnPhone(p)) return { error: 'invalid_phone', status: 400 };
  const user = findUserByPhone(db, p);
  if (!user) return { error: 'user_not_found', status: 404 };
  if (user.disabled) return { error: 'account_disabled', status: 403 };
  if (!takeRequestBudget(p)) return { error: 'rate_limited', status: 429 };

  // Refresh Telegram link from shared DB (mqtt_server) on each OTP login
  const contact = getConfig().identity.contact(user) || await getConfig().identity.resolveContact(db, p);
  if (!contact) return { error: getConfig().identity.unavailableError, status: 400 };

  const code = genCode();
  const challenge = createOtpChallenge(db, {
    ttlSec: otpTtlSec(),
    phone: p,
    purpose: 'login',
    codeHash: hashCode(code),
    contact,
  });
  try {
    await getConfig().identity.sendCode(contact, code, 'Đăng nhập', { user }); // user: để app gửi thêm qua email nếu có
  } catch (e) {
    deleteOtpChallenge(db, challenge.id);
    return { error: getConfig().identity.sendError, status: 502 };
  }
  return { ok: true, phone: p, expiresIn: otpTtlSec() };
}

/** OTP qua email cho khôi phục 2 yếu tố: chỉ email đã xác minh và qua thời gian chờ; cùng ngân sách gửi/đoán theo số điện thoại. */
export async function requestEmailRecoveryOtp(db, { phone }) {
  const p = normalizePhone(phone);
  if (!isValidVnPhone(p)) return { error: 'invalid_phone', status: 400 };
  const user = findUserByPhone(db, p);
  if (!user) return { error: 'user_not_found', status: 404 };
  if (user.disabled) return { error: 'account_disabled', status: 403 };
  const waited = Date.now() >= (user.email_verified_at || 0) + Number(process.env.EMAIL_QUARANTINE_HOURS || 72) * HOUR;
  if (!user.email || !user.email_verified || !waited || !getConfig().email.available(user)) return { error: 'email_unavailable', status: 400 };
  if (!takeRequestBudget(p)) return { error: 'rate_limited', status: 429 };
  const code = genCode();
  const challenge = createOtpChallenge(db, { ttlSec: otpTtlSec(), phone: p, purpose: 'recover_email', codeHash: hashCode(code), contact: user.email });
  try {
    await getConfig().email.send(user, 'Mã khôi phục tài khoản — Giám sát PLC', `Mã khôi phục tài khoản: ${code}\nHiệu lực 5 phút. Nếu không phải bạn, hãy bỏ qua email này.`);
  } catch {
    deleteOtpChallenge(db, challenge.id);
    return { error: 'email_send_failed', status: 502 };
  }
  return { ok: true, phone: p, expiresIn: otpTtlSec() };
}

export function verifyLoginOtp(db, { phone, otp, purpose = 'login' }) {
  const p = normalizePhone(phone);
  if (failLocked(p)) return { error: 'otp_locked', status: 429 };
  const ch = getOtpChallenge(db, p, purpose);
  if (!ch) return { error: 'otp_missing', status: 400 };
  if (Date.now() > ch.expires_at) {
    deleteOtpChallenge(db, ch.id);
    return { error: 'otp_expired', status: 400 };
  }
  if (ch.fails >= 5) return { error: 'otp_locked', status: 429 };
  if (hashCode(otp) !== ch.code_hash) {
    bumpOtpFail(db, ch.id);
    noteFail(p);
    return { error: 'otp_invalid', status: 401 };
  }
  const user = findUserByPhone(db, p);
  if (!user) return { error: 'user_not_found', status: 404 };
  if (user.disabled) return { error: 'account_disabled', status: 403 };
  deleteOtpChallenge(db, ch.id);
  return { ok: true, user };
}
