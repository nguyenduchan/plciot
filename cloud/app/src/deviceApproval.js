/**
 * Thêm máy điện thoại mới (cùng tài khoản) mà không cần admin và không cần mật khẩu.
 *
 * Máy mới đăng nhập bằng OTP Telegram chỉ được xem. Để điều khiển, nó phải xin "vé đăng ký" (enroll ticket):
 *   A. Duyệt từ máy cũ   — máy đang có vân tay/Authenticator bấm "Cho phép"            → vé ngay lập tức
 *   B. Mã khôi phục      — dùng 1 mã khôi phục                                       → chờ DEVICE_ADD_COOLING_HOURS (24 h)
 *   C. Email đã xác minh — nhập OTP gửi vào email (email phải qua kỳ cách ly 72 h)   → chờ 24 h
 * Trong thời gian chờ, chủ tài khoản được báo (Telegram + email) kèm link huỷ 1 chạm, và mọi máy cũ thấy yêu cầu để từ chối.
 * Vé sống 15 phút, dùng một lần, chỉ có tác dụng đăng ký yếu tố điều khiển (không dùng cho thao tác nhạy cảm khác).
 */
import crypto from 'crypto';
import { audit, countAudit } from './audit.js';
import { notifyOwner, tryRecoveryCode, emailQuarantineMs } from './accountSecurity.js';
import { recoveryCodesRemaining } from './recoveryCodes.js';
import { sendEmail, emailConfigured } from './mailer.js';
import { factorSummary } from './controlAuth.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const PENDING_TTL = 30 * MIN;
const APPROVED_TTL = 60 * MIN;
const TICKET_TTL = 15 * MIN;
const OTP_TTL = 5 * MIN;
const MAX_OTP_FAILS = 5;
const ACTIVE = ['pending', 'cooling', 'approved'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const coolingMs = () => {
  const v = Number(process.env.DEVICE_ADD_COOLING_HOURS);
  return (Number.isFinite(v) && v >= 0 ? v : 24) * HOUR;
};
const publicUrl = () => (process.env.WEBAPP_PUBLIC_URL || '').replace(/\/$/, '');

export function deviceCancelToken(id) {
  return crypto.createHmac('sha256', process.env.APP_JWT_SECRET || '').update(`devcancel:${id}`).digest('base64url').slice(0, 32);
}
const cancelLink = (id) => `${publicUrl()}/api/device/cancel?id=${id}&t=${deviceCancelToken(id)}`;

const getRow = (db, id, userId) => db.prepare('SELECT * FROM device_requests WHERE id = ? AND user_id = ?').get(String(id || ''), userId);
const setRow = (db, id, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE device_requests SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), Date.now(), id);
};

export function emailAvailable(user) {
  return Boolean(emailConfigured() && user.email && user.email_verified
    && Date.now() >= (user.email_verified_at || 0) + emailQuarantineMs());
}

/** Dọn hạn và chuyển các yêu cầu hết thời gian chờ sang "approved". */
export function sweepRequests(db, now = Date.now()) {
  db.prepare("UPDATE device_requests SET status = 'expired', updated_at = ? WHERE status = 'pending' AND created_at < ?").run(now, now - PENDING_TTL);
  db.prepare("UPDATE device_requests SET status = 'expired', updated_at = ? WHERE status = 'approved' AND updated_at < ?").run(now, now - APPROVED_TTL);
  db.prepare("UPDATE device_requests SET status = 'approved', updated_at = ? WHERE status = 'cooling' AND execute_at <= ?").run(now, now);
}

export async function startDeviceRequest(db, user, { ip, label }) {
  const f = factorSummary(db, user.id);
  const hasFactor = f.passkeys > 0 || f.totp;
  if (countAudit(db, user.id, 'device_request', Date.now() - HOUR) >= 5) return { error: 'rate_limited', status: 429 };
  sweepRequests(db);
  db.prepare("UPDATE device_requests SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status IN ('pending','cooling','approved')")
    .run(Date.now(), user.id);
  const id = crypto.randomBytes(8).toString('hex');
  const pollToken = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare(`
    INSERT INTO device_requests (id, user_id, status, poll_hash, label, created_ip, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(id, user.id, sha(pollToken), String(label || 'Thiết bị mới').slice(0, 80), ip || null, now, now);
  audit(db, 'device_request', { userId: user.id, ip, detail: id });
  notifyOwner(db, user, {
    subject: 'Có thiết bị mới xin quyền điều khiển',
    html: `<b>📱 Một thiết bị mới đang xin quyền điều khiển tài khoản của bạn</b> (${esc(String(label || '').slice(0, 80))}).\n`
      + 'Mở ứng dụng trên máy cũ để <b>Cho phép</b> hoặc <b>Từ chối</b>.\n'
      + `Không phải bạn? <a href="${cancelLink(id)}">Huỷ yêu cầu</a>.`,
  });
  return {
    ok: true,
    id,
    pollToken,
    expiresIn: PENDING_TTL / 1000,
    coolingHours: coolingMs() / HOUR,
    // chưa có yếu tố nào (thiết bị không phải thiết bị đầu tiên): chỉ có email hoặc chờ, không có "máy cũ" để duyệt
    options: { device: hasFactor, wait: !hasFactor, recoveryCode: recoveryCodesRemaining(db, user.id) > 0, email: emailAvailable(user) },
  };
}

export function listDeviceRequests(db, user) {
  sweepRequests(db);
  return db.prepare("SELECT id, label, status, execute_at, created_at, created_ip FROM device_requests WHERE user_id = ? AND status IN ('pending','cooling') ORDER BY created_at DESC")
    .all(user.id).map((r) => ({
      id: r.id, label: r.label, status: r.status, executeAt: r.execute_at, createdAt: r.created_at, ip: r.created_ip,
    }));
}

export function pendingDeviceCount(db, userId) {
  sweepRequests(db);
  return db.prepare("SELECT COUNT(*) AS n FROM device_requests WHERE user_id = ? AND status IN ('pending','cooling')").get(userId).n;
}

/** Máy cũ (đã mở khoá bằng yếu tố) cho phép hoặc từ chối. */
export function decideDeviceRequest(db, user, id, action, { ip }) {
  sweepRequests(db);
  const row = getRow(db, id, user.id);
  if (!row || !['pending', 'cooling'].includes(row.status)) return { error: 'request_not_found', status: 404 };
  if (action === 'approve') {
    setRow(db, id, { status: 'approved' });
    audit(db, 'device_approved', { userId: user.id, ip, detail: id });
    notifyOwner(db, user, { subject: 'Đã cho phép thiết bị mới', html: '<b>✅ Một thiết bị mới đã được cho phép từ máy cũ.</b>' });
  } else {
    setRow(db, id, { status: 'denied' });
    audit(db, 'device_denied', { userId: user.id, ip, detail: id });
  }
  return { ok: true };
}

function toCooling(db, user, row, method, ip) {
  const wait = coolingMs();
  const executeAt = Date.now() + wait;
  setRow(db, row.id, { status: wait === 0 ? 'approved' : 'cooling', method, execute_at: executeAt });
  audit(db, 'device_cooling', { userId: user.id, ip, detail: `${row.id} ${method}` });
  notifyOwner(db, user, {
    subject: 'Thiết bị mới sẽ được cấp quyền sau thời gian chờ',
    html: `<b>⏳ Thiết bị mới xin quyền điều khiển bằng ${method === 'email' ? 'email' : method === 'wait' ? 'thời gian chờ' : 'mã khôi phục'}.</b>\n`
      + `Quyền sẽ được cấp lúc ${new Date(executeAt).toLocaleString('vi-VN')} nếu không bị huỷ.\n`
      + `Không phải bạn? <a href="${cancelLink(row.id)}">Huỷ ngay</a> (hoặc Từ chối trên máy cũ).`,
  });
  return { ok: true, status: wait === 0 ? 'approved' : 'cooling', executeAt, coolingHours: wait / HOUR };
}

export function deviceViaRecoveryCode(db, user, id, { code, ip }) {
  sweepRequests(db);
  const row = getRow(db, id, user.id);
  if (!row || row.status !== 'pending') return { error: 'request_not_pending', status: 409 };
  const r = tryRecoveryCode(db, user, code, ip);
  if (r === 'locked') return { error: 'recovery_locked', status: 429 };
  if (r !== 'ok') return { error: 'recovery_code_invalid', status: 401 };
  return toCooling(db, user, row, 'recovery_code', ip);
}

/** Chưa có yếu tố nào và không phải thiết bị đầu tiên: chỉ có thể chờ (kèm cảnh báo cho chủ). */
export function deviceViaWait(db, user, id, { ip }) {
  sweepRequests(db);
  const row = getRow(db, id, user.id);
  if (!row || row.status !== 'pending') return { error: 'request_not_pending', status: 409 };
  const f = factorSummary(db, user.id);
  if (f.passkeys || f.totp) return { error: 'use_existing_device', status: 409 };
  return toCooling(db, user, row, 'wait', ip);
}

export async function deviceEmailStart(db, user, id, { ip }) {
  sweepRequests(db);
  const row = getRow(db, id, user.id);
  if (!row || row.status !== 'pending') return { error: 'request_not_pending', status: 409 };
  if (!emailAvailable(user)) return { error: 'old_channel_unavailable', status: 400 };
  if (countAudit(db, user.id, 'device_email_otp', Date.now() - HOUR) >= 5) return { error: 'rate_limited', status: 429 };
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  setRow(db, id, { email_otp_hash: sha(`devotp:${code}`), email_otp_expires: Date.now() + OTP_TTL, email_fails: 0 });
  try {
    await sendEmail(user.email, 'Mã xác nhận thêm thiết bị — Giám sát PLC', `Mã xác nhận thêm thiết bị điều khiển: ${code}\nHiệu lực 5 phút. Nếu không phải bạn, hãy bỏ qua email này.`);
  } catch (e) {
    return { error: 'email_send_failed', detail: e.message, status: 502 };
  }
  audit(db, 'device_email_otp', { userId: user.id, ip, detail: id });
  return { ok: true, expiresIn: OTP_TTL / 1000 };
}

export function deviceEmailConfirm(db, user, id, { otp, ip }) {
  const row = getRow(db, id, user.id);
  if (!row || row.status !== 'pending') return { error: 'request_not_pending', status: 409 };
  if (!row.email_otp_hash || Date.now() > (row.email_otp_expires || 0)) return { error: 'otp_expired', status: 400 };
  if (row.email_fails >= MAX_OTP_FAILS) return { error: 'otp_locked', status: 429 };
  if (!safeEq(sha(`devotp:${String(otp || '').trim()}`), row.email_otp_hash)) {
    setRow(db, id, { email_fails: row.email_fails + 1 });
    return { error: 'otp_invalid', status: 401 };
  }
  setRow(db, id, { email_otp_hash: null });
  return toCooling(db, user, row, 'email', ip);
}

/** Máy mới hỏi trạng thái; khi được duyệt sẽ nhận vé đăng ký (mỗi lần hỏi cấp lại vé mới trong cửa sổ cho phép). */
export function pollDeviceRequest(db, user, id, pollToken) {
  sweepRequests(db);
  const row = getRow(db, id, user.id);
  if (!row || !safeEq(sha(pollToken), row.poll_hash)) return { error: 'request_not_found', status: 404 };
  if (row.status !== 'approved') return { ok: true, status: row.status, executeAt: row.execute_at || null };
  const ticket = crypto.randomBytes(24).toString('base64url');
  // giữ nguyên updated_at: hạn APPROVED_TTL tính từ lúc được duyệt, không bị kéo dài bởi mỗi lần hỏi
  db.prepare('UPDATE device_requests SET ticket_hash = ?, ticket_expires = ? WHERE id = ?').run(sha(ticket), Date.now() + TICKET_TTL, id);
  return { ok: true, status: 'approved', ticket, ticketExpiresIn: TICKET_TTL / 1000 };
}

/** Vé còn hiệu lực cho user này? (không tiêu thụ) */
export function peekTicket(db, userId, ticket) {
  if (!ticket) return false;
  const row = db.prepare("SELECT 1 FROM device_requests WHERE user_id = ? AND status = 'approved' AND ticket_hash = ? AND ticket_expires > ?")
    .get(userId, sha(ticket), Date.now());
  return Boolean(row);
}

/** Đăng ký xong yếu tố → huỷ vé. */
export function consumeTicket(db, userId, ticket) {
  if (!peekTicket(db, userId, ticket)) return false;
  db.prepare("UPDATE device_requests SET status = 'done', ticket_hash = NULL, updated_at = ? WHERE user_id = ? AND ticket_hash = ?")
    .run(Date.now(), userId, sha(ticket));
  return true;
}

/** Link huỷ trong tin nhắn cảnh báo (không cần đăng nhập). */
export function cancelDeviceByLink(db, id, token, ip) {
  const row = db.prepare('SELECT * FROM device_requests WHERE id = ?').get(String(id || ''));
  if (!row || !safeEq(token, deviceCancelToken(row.id))) return { error: 'forbidden', status: 403 };
  if (!ACTIVE.includes(row.status)) return { error: 'request_not_pending', status: 409 };
  setRow(db, row.id, { status: 'cancelled', ticket_hash: null });
  audit(db, 'device_cancelled', { userId: row.user_id, ip, detail: 'link' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (user) notifyOwner(db, user, { subject: 'Đã huỷ yêu cầu thêm thiết bị', html: '<b>🛑 Yêu cầu thêm thiết bị đã bị huỷ.</b>' });
  return { ok: true };
}
