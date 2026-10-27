import crypto from 'crypto';
import {
  createOtpChallenge, getOtpChallenge, bumpOtpFail, deleteOtpChallenge,
  findUserByPhone, upsertUser,
} from './db.js';
import { hashPassword } from './auth.js';
import { normalizePhone, isValidVnPhone } from './phone.js';
import { otpMessage, sendTelegramMessage } from './telegram.js';
import { copyDir, resolveBundleRoot } from './bundle.js';
import { resolveTelegramUser } from './sharedTg.js';
import { provisionUserMqtt } from './mqttProvision.js';
import fs from 'fs';

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

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function genCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function requestRegisterOtp(db, { phone, dataDir, webappSrc }) {
  const p = normalizePhone(phone);
  if (!isValidVnPhone(p)) return { error: 'invalid_phone', status: 400 };

  // username === canonical VN phone (84…)
  if (findUserByPhone(db, p)) return { error: 'user_exists', status: 409 };
  if (!takeRequestBudget(p)) return { error: 'rate_limited', status: 429 };

  // Must already have shared phone with Telegram bot (mqtt_server / local)
  const tg = await resolveTelegramUser(db, p);
  if (!tg) return { error: 'telegram_not_linked', status: 400 };

  const code = genCode();
  createOtpChallenge(db, {
    phone: p,
    purpose: 'register',
    codeHash: hashCode(code),
    passwordHash: hashPassword(crypto.randomBytes(24).toString('hex')), // cột NOT NULL cũ: không ai biết, không dùng để xác thực
  });

  try {
    await sendTelegramMessage(tg.chat_id, otpMessage(code));
  } catch (e) {
    return { error: 'telegram_send_failed', detail: e.message, status: 502 };
  }
  return { ok: true, phone: p, expiresIn: 300 };
}

export async function verifyRegisterOtp(db, { phone, otp, dataDir, webappSrc }) {
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

  const tg = await resolveTelegramUser(db, p);
  const folder = `u${p}`;
  if (!fs.existsSync(webappSrc)) return { error: 'webapp_src_missing', status: 500 };
  const dest = resolveBundleRoot(dataDir, folder);
  copyDir(webappSrc, dest);

  // Unique MQTT namespace per phone so ACL cannot overlap another customer
  const notifySite = `s${p}`;
  const notifyDevice = 'plc01';
  let user = upsertUser(db, {
    username: p,
    passwordHash: ch.password_hash,
    folderPath: folder,
    version: '1',
    phone: p,
    chatId: tg?.chat_id || null,
    notifySite,
    notifyDevice,
  });
  try {
    user = provisionUserMqtt(db, user, { site: notifySite, device: notifyDevice }).user;
  } catch (e) {
    console.error('mqtt provision on register', e.message);
  }
  deleteOtpChallenge(db, ch.id);
  return { ok: true, user };
}

export async function requestLoginOtp(db, { phone }) {
  const p = normalizePhone(phone);
  if (!isValidVnPhone(p)) return { error: 'invalid_phone', status: 400 };
  const user = findUserByPhone(db, p);
  if (!user) return { error: 'user_not_found', status: 404 };
  if (!takeRequestBudget(p)) return { error: 'rate_limited', status: 429 };

  // Refresh Telegram link from shared DB (mqtt_server) on each OTP login
  const tg = await resolveTelegramUser(db, p)
    || (user.chat_id ? { chat_id: user.chat_id, phone: p } : null);
  if (!tg?.chat_id) return { error: 'telegram_not_linked', status: 400 };
  if (tg.chat_id && user.chat_id !== tg.chat_id) {
    db.prepare('UPDATE users SET chat_id = ?, phone = ? WHERE id = ?')
      .run(tg.chat_id, p, user.id);
  }

  const code = genCode();
  createOtpChallenge(db, {
    phone: p,
    purpose: 'login',
    codeHash: hashCode(code),
  });
  try {
    await sendTelegramMessage(tg.chat_id, otpMessage(code));
  } catch (e) {
    return { error: 'telegram_send_failed', detail: e.message, status: 502 };
  }
  return { ok: true, phone: p, expiresIn: 300 };
}

export function verifyLoginOtp(db, { phone, otp }) {
  const p = normalizePhone(phone);
  if (failLocked(p)) return { error: 'otp_locked', status: 429 };
  const ch = getOtpChallenge(db, p, 'login');
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
  deleteOtpChallenge(db, ch.id);
  return { ok: true, user };
}
