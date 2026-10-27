/**
 * Các route bảo mật dùng chung: yếu tố (Passkey / TOTP), phiên điều khiển, đăng nhập bằng passkey, thêm thiết bị mới,
 * đăng xuất mọi máy, ghép PC bằng mã. KHÔNG biết app điều khiển cái gì (PLC, MQTT…): app tự thêm route lệnh và dùng
 * `authorize(req)` / `reauth` trả về từ mountSecurityRoutes.
 */
import crypto from 'crypto';
import { rateLimit } from './rateLimit.js';
import { clientIp } from './net.js';
import { audit, countAudit } from './audit.js';
import { getConfig, notify } from './config.js';
import { stationAuth, pairStation } from './stationAuth.js';
import { generateRecoveryCodes, recoveryCodesRemaining } from './recoveryCodes.js';
import {
  startDeviceRequest, listDeviceRequests, pendingDeviceCount, decideDeviceRequest, deviceViaRecoveryCode,
  deviceEmailStart, deviceEmailConfirm, deviceViaWait, pollDeviceRequest, peekTicket, consumeTicket, cancelDeviceByLink,
} from './deviceApproval.js';
import {
  generateSecret, otpauthUri, verifyTotp, sealSecret, openSecret,
} from './totp.js';
import {
  registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication,
} from './webauthn.js';
import {
  securityConfig, createControlSession, revokeControlSessions, checkControlSession, factorSummary,
  createStation, listStations, deleteStation, stationOk, enrollState,
} from './sessions.js';
import { noteLogin, isFirstDevice } from './loginAlerts.js';

const FRESH_LOGIN_MS = 10 * 60_000; // đăng ký yếu tố đầu tiên: phải vừa đăng nhập bằng OTP Telegram
const TOTP_LOCK_FAILS = 5;
const TOTP_LOCK_WINDOW = 15 * 60_000;

function webauthnEnv() {
  const origins = String(process.env.WEBAUTHN_ORIGINS || getConfig().publicUrl() || 'http://localhost:3080')
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const rpId = process.env.WEBAUTHN_RP_ID || new URL(origins[0]).hostname;
  return { origins, rpId };
}

/**
 * @param app Express app
 * @param ctx.db better-sqlite3 (đã migrateSecurity)
 * @param ctx.requireAuth middleware: đặt req.user (có id, username, role…) và req.tokenPayload (có iat)
 * @param ctx.adminOnly mảng middleware cho route quản trị trạm kiểu cũ
 * @param ctx.loginPayload (user) => payload đăng nhập của app (JWT…) hoặc { error, status }
 * @param ctx.authStrict middleware giới hạn tần suất cho route chưa đăng nhập
 * @param ctx.extraStatus (req) => object trộn vào GET /api/control/status
 */
export function mountSecurityRoutes(app, { db, requireAuth, adminOnly = [], loginPayload, authStrict, extraStatus }) {
  const strict = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_CONTROL_AUTH || 8),
    keyFn: (req) => `${clientIp(req)}:ctlauth:${req.user?.id || 'na'}`,
  });

  const out = (res, status, body) => res.status(status).json(body);
  const tokenOf = (req) => String(req.headers['x-control-token'] || '');
  const reload = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  /** Có được thêm/đổi yếu tố không: yếu tố đầu tiên cần vừa đăng nhập; từ lần sau cần phiên điều khiển còn hạn. */
  const ticketOf = (req) => String(req.headers['x-enroll-ticket'] || '');
  function enrollGate(req, { allowTicket = false } = {}) {
    const f = factorSummary(db, req.user.id);
    if (!f.passkeys && !f.totp) {
      const iatMs = (req.tokenPayload?.iat || 0) * 1000;
      if (Date.now() - iatMs > FRESH_LOGIN_MS) return { error: 'reauth_required', status: 401 };
      // Chống chiếm Telegram tự bật yếu tố: chỉ thiết bị đầu tiên của tài khoản được bật ngay; máy khác phải qua vé (email / chờ 24 giờ)
      if (isFirstDevice(db, req.user.id, req.headers['x-device-id'])) return null;
      if (allowTicket && peekTicket(db, req.user.id, ticketOf(req))) return null;
      return { error: 'first_device_required', status: 401 };
    }
    const c = checkControlSession(db, req.user.id, tokenOf(req), clientIp(req));
    if (c.ok) return null;
    if (allowTicket && peekTicket(db, req.user.id, ticketOf(req))) return null;
    return { error: 'step_up_required', reason: c.reason, status: 401 };
  }

  /** Yếu tố đầu tiên → tự tạo 10 mã khôi phục (hiện một lần) để người dùng không phải nhờ admin khi mất máy. */
  function firstFactorExtras(userId, ip) {
    notify(db, db.prepare('SELECT * FROM users WHERE id = ?').get(userId), {
      subject: 'Đã bật xác thực điều khiển',
      html: '<b>🔐 Đã bật vân tay/Authenticator để điều khiển.</b>\nNếu không phải bạn, hãy vào Cài đặt → Điều khiển → Đăng xuất mọi máy ngay.' + (ip ? ` (IP ${ip})` : ''),
    });
    return recoveryCodesRemaining(db, userId) === 0 ? { recoveryCodes: generateRecoveryCodes(db, userId) } : {};
  }

  /** Thay cho "nhập mật khẩu hiện tại": có phiên điều khiển còn hạn, hoặc (chưa có yếu tố) vừa đăng nhập ≤ 10 phút. */
  function reauth(req, res, next) {
    const gate = enrollGate(req);
    if (gate) return out(res, gate.status, { ...gate, methods: methodsFor(req.user) });
    req.reauthed = true;
    next();
  }

  function issue(req, res, method, extra = {}) {
    const s = createControlSession(db, req.user.id, method, clientIp(req));
    audit(db, 'control_unlock', { userId: req.user.id, ip: clientIp(req), detail: method });
    res.json({ ok: true, controlToken: s.token, method, expiresAt: s.expiresAt, ...extra });
  }

  function methodsFor(u) {
    const f = factorSummary(db, u.id);
    return { passkey: f.passkeys > 0, totp: f.totp, enrolled: f.passkeys > 0 || f.totp };
  }

  /* ---------- trạng thái ---------- */
  app.get('/api/control/status', requireAuth, (req, res) => {
    const cfg = securityConfig();
    const c = checkControlSession(db, req.user.id, tokenOf(req), clientIp(req), cfg);
    res.json({
      stepUp: cfg.stepUp,
      unlocked: !cfg.stepUp || Boolean(c.ok) || stationOk(db, req.user.id, req.headers, clientIp(req), cfg),
      session: c.ok ? { method: c.method, expiresAt: c.expiresAt } : { reason: c.reason },
      methods: methodsFor(req.user),
      ...(extraStatus ? extraStatus(req) : {}), // app thêm trường riêng (vd. nút vật lý)
      enroll: enrollState(db, req.user),
      pendingDevices: c.ok ? pendingDeviceCount(db, req.user.id) : 0,
      recoveryCodesLeft: recoveryCodesRemaining(db, req.user.id),
    });
  });

  /* ---------- TOTP ---------- */
  app.post('/api/control/totp/setup', requireAuth, strict, (req, res) => {
    const gate = enrollGate(req, { allowTicket: true });
    if (gate) return out(res, gate.status, gate);
    const secret = generateSecret();
    // Lưu ở totp_pending: bí mật đang dùng (nếu có) chỉ bị thay khi nhập đúng mã đầu tiên.
    db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(sealSecret(secret), req.user.id);
    res.json({ secret, uri: otpauthUri(secret, req.user.username) });
  });

  /** Kiểm tra mã + chống dò: khoá 15 phút sau 5 lần sai. Trả { ok, step } hoặc { error }. */
  function checkTotpCode(u, code, ip, sealed = u.totp_secret) {
    if (countAudit(db, u.id, 'totp_fail', Date.now() - TOTP_LOCK_WINDOW) >= TOTP_LOCK_FAILS) {
      return { error: 'totp_locked', status: 429 };
    }
    const secret = openSecret(sealed);
    const step = secret ? verifyTotp(secret, code, { lastStep: u.totp_last_step | 0 }) : null;
    if (!step) {
      audit(db, 'totp_fail', { userId: u.id, ip });
      return { error: 'totp_invalid', status: 401 };
    }
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id);
    return { ok: true, step };
  }

  app.post('/api/control/totp/enable', requireAuth, strict, (req, res) => {
    const u = reload(req.user.id);
    if (!u.totp_pending) return out(res, 400, { error: 'totp_not_pending' });
    const gate = enrollGate(req, { allowTicket: true }); // đã có yếu tố khác: cần phiên hoặc vé, kể cả khi đã gọi setup
    if (gate) return out(res, gate.status, gate);
    const r = checkTotpCode(u, req.body?.code, clientIp(req), u.totp_pending);
    if (r.error) return out(res, r.status, r);
    const first = !factorSummary(db, u.id).passkeys && !u.totp_enabled;
    db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(r.step, u.id);
    consumeTicket(db, u.id, ticketOf(req));
    audit(db, 'totp_enabled', { userId: u.id, ip: clientIp(req) });
    issue(req, res, 'totp', first ? firstFactorExtras(u.id, clientIp(req)) : {});
  });

  app.post('/api/control/totp/disable', requireAuth, strict, (req, res) => {
    const c = checkControlSession(db, req.user.id, tokenOf(req), clientIp(req));
    if (!c.ok) return out(res, 401, { error: c.error, reason: c.reason });
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?').run(req.user.id);
    revokeControlSessions(db, req.user.id);
    audit(db, 'totp_disabled', { userId: req.user.id, ip: clientIp(req) });
    res.json({ ok: true });
  });

  /* ---------- mở khoá điều khiển ---------- */
  app.post('/api/control/unlock', requireAuth, strict, (req, res) => {
    const u = reload(req.user.id);
    if (!u.totp_enabled) return out(res, 400, { error: 'totp_not_enabled' });
    const r = checkTotpCode(u, req.body?.code, clientIp(req));
    if (r.error) return out(res, r.status, r);
    issue(req, res, 'totp');
  });

  app.post('/api/control/lock', requireAuth, (req, res) => {
    revokeControlSessions(db, req.user.id, tokenOf(req));
    res.json({ ok: true });
  });

  /* ---------- Passkeys ---------- */
  const credList = (uid) => db.prepare('SELECT cred_id FROM passkeys WHERE user_id = ?').all(uid).map((r) => r.cred_id);

  app.get('/api/webauthn/credentials', requireAuth, (req, res) => {
    res.json({
      credentials: db.prepare('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id').all(req.user.id),
    });
  });

  app.post('/api/webauthn/register/options', requireAuth, strict, (req, res) => {
    const gate = enrollGate(req, { allowTicket: true });
    if (gate) return out(res, gate.status, gate);
    const { rpId } = webauthnEnv();
    res.json(registrationOptions({ userId: req.user.id, username: req.user.username, rpId, rpName: getConfig().brand.rpName, exclude: credList(req.user.id) }));
  });

  app.post('/api/webauthn/register/verify', requireAuth, strict, (req, res) => {
    const gate = enrollGate(req, { allowTicket: true });
    if (gate) return out(res, gate.status, gate);
    let r;
    try {
      r = verifyRegistration(req.user.id, req.body?.credential, webauthnEnv());
    } catch (e) {
      audit(db, 'passkey_register_fail', { userId: req.user.id, ip: clientIp(req), detail: e.message });
      return out(res, 400, { error: 'webauthn_failed', detail: e.message });
    }
    try {
      db.prepare(`
        INSERT INTO passkeys (user_id, cred_id, public_key, alg, counter, name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, r.credId, r.publicKey, r.alg, r.counter, String(req.body?.name || 'Thiết bị').slice(0, 40), Date.now());
    } catch {
      return out(res, 409, { error: 'credential_exists' });
    }
    const first = factorSummary(db, req.user.id).passkeys === 1 && !req.user.totp_enabled;
    consumeTicket(db, req.user.id, ticketOf(req));
    audit(db, 'passkey_registered', { userId: req.user.id, ip: clientIp(req) });
    issue(req, res, 'passkey', first ? firstFactorExtras(req.user.id, clientIp(req)) : {});
  });

  app.post('/api/webauthn/auth/options', requireAuth, strict, (req, res) => {
    const allow = credList(req.user.id);
    if (!allow.length) return out(res, 400, { error: 'no_passkey' });
    res.json(authenticationOptions({ key: `auth:${req.user.id}`, rpId: webauthnEnv().rpId, allow }));
  });

  app.post('/api/webauthn/auth/verify', requireAuth, strict, (req, res) => {
    const cred = req.body?.credential;
    const stored = db.prepare('SELECT * FROM passkeys WHERE cred_id = ? AND user_id = ?').get(String(cred?.id || ''), req.user.id);
    if (!stored) return out(res, 400, { error: 'unknown_credential' });
    let r;
    try {
      r = verifyAuthentication(`auth:${req.user.id}`, cred, stored, webauthnEnv());
    } catch (e) {
      audit(db, 'passkey_fail', { userId: req.user.id, ip: clientIp(req), detail: e.message });
      return out(res, 401, { error: 'webauthn_failed', detail: e.message });
    }
    db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(r.counter, Date.now(), stored.id);
    issue(req, res, 'passkey');
  });

  app.delete('/api/webauthn/credentials/:id', requireAuth, strict, (req, res) => {
    const c = checkControlSession(db, req.user.id, tokenOf(req), clientIp(req));
    if (!c.ok) return out(res, 401, { error: c.error, reason: c.reason });
    const n = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id).changes;
    if (!n) return out(res, 404, { error: 'not_found' });
    revokeControlSessions(db, req.user.id);
    audit(db, 'passkey_removed', { userId: req.user.id, ip: clientIp(req) });
    res.json({ ok: true });
  });

  /** Người dùng tự đăng xuất mọi máy (nghi bị lộ): token_version + 1 và thu hồi mọi phiên điều khiển. */
  app.post('/api/account/logout-all', requireAuth, strict, reauth, (req, res) => {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
    revokeControlSessions(db, req.user.id);
    audit(db, 'logout_all', { userId: req.user.id, ip: clientIp(req) });
    res.json({ ok: true });
  });

  /* ---------- Thêm máy điện thoại mới ---------- */
  const needSession = (req, res) => {
    const c = checkControlSession(db, req.user.id, tokenOf(req), clientIp(req));
    if (c.ok) return true;
    out(res, 401, { error: 'step_up_required', reason: c.reason, methods: methodsFor(req.user) });
    return false;
  };
  const sendR = (res, r) => (r.error ? res.status(r.status || 400).json(r) : res.json(r));

  app.post('/api/devices/request', requireAuth, strict, async (req, res) => {
    sendR(res, await startDeviceRequest(db, req.user, { ip: clientIp(req), label: req.body?.label }));
  });
  // Máy mới hỏi trạng thái mỗi ~3 giây: hạn mức riêng, KHÔNG dùng chung với mở khoá/duyệt (strict)
  const pollLimit = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_DEVICE_POLL || 40),
    keyFn: (req) => `${clientIp(req)}:devpoll:${req.user?.id || 'na'}`,
  });
  app.post('/api/devices/requests/:id/poll', requireAuth, pollLimit, (req, res) => {
    sendR(res, pollDeviceRequest(db, req.user, req.params.id, String(req.body?.pollToken || '')));
  });
  app.post('/api/devices/requests/:id/recovery', requireAuth, strict, (req, res) => {
    sendR(res, deviceViaRecoveryCode(db, req.user, req.params.id, { code: req.body?.code, ip: clientIp(req) }));
  });
  app.post('/api/devices/requests/:id/wait', requireAuth, strict, (req, res) => {
    sendR(res, deviceViaWait(db, req.user, req.params.id, { ip: clientIp(req) }));
  });
  app.post('/api/devices/requests/:id/email/start', requireAuth, strict, async (req, res) => {
    sendR(res, await deviceEmailStart(db, req.user, req.params.id, { ip: clientIp(req) }));
  });
  app.post('/api/devices/requests/:id/email/confirm', requireAuth, strict, (req, res) => {
    sendR(res, deviceEmailConfirm(db, req.user, req.params.id, { otp: req.body?.otp, ip: clientIp(req) }));
  });
  // Từ máy cũ (đã mở khoá): xem / cho phép / từ chối
  app.get('/api/devices/requests', requireAuth, (req, res) => {
    if (!needSession(req, res)) return;
    res.json({ requests: listDeviceRequests(db, req.user) });
  });
  app.post('/api/devices/requests/:id/:action(approve|deny)', requireAuth, strict, (req, res) => {
    if (!needSession(req, res)) return;
    sendR(res, decideDeviceRequest(db, req.user, req.params.id, req.params.action, { ip: clientIp(req) }));
  });
  // GET chỉ hiện trang xác nhận: bộ xem trước link của Telegram/trình quét mail tự mở mọi URL, nếu GET huỷ luôn
  // thì yêu cầu bị huỷ sau ~1 giây mà chủ không hề bấm (đã xảy ra thật). Huỷ chỉ xảy ra ở POST khi bấm nút.
  app.get('/api/device/cancel', authStrict, (req, res) => {
    const q = `id=${encodeURIComponent(String(req.query.id || ''))}&t=${encodeURIComponent(String(req.query.t || ''))}`;
    res.type('html').send(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Huỷ yêu cầu</title><body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px">'
      + '<h2>Huỷ yêu cầu thêm thiết bị?</h2><p>Chỉ huỷ nếu <b>không phải bạn</b> vừa yêu cầu thêm thiết bị mới.</p>'
      + `<form method="post" action="/api/device/cancel?${q}"><button style="font-size:18px;padding:12px 24px">Huỷ yêu cầu</button></form>`,
    );
  });
  app.post('/api/device/cancel', authStrict, (req, res) => {
    const r = cancelDeviceByLink(db, String(req.query.id || ''), String(req.query.t || ''), clientIp(req));
    const msg = r.ok ? 'Đã huỷ yêu cầu thêm thiết bị. Tài khoản của bạn không thay đổi.'
      : r.error === 'request_not_pending' ? 'Yêu cầu này đã được xử lý hoặc đã bị huỷ trước đó.' : 'Liên kết không hợp lệ.';
    res.status(r.ok ? 200 : (r.status || 400)).type('html').send(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + `<title>Huỷ yêu cầu</title><body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px"><h2>${r.ok ? '✅' : '⚠️'} ${msg}</h2>`,
    );
  });

  /* ---------- Đăng nhập bằng Passkey (không mật khẩu, không cần gõ SĐT) ---------- */
  app.post('/api/login/passkey/options', authStrict, (_req, res) => {
    const cid = crypto.randomBytes(12).toString('base64url');
    // allowCredentials rỗng → trình duyệt tự gợi ý passkey đã lưu cho tên miền này
    res.json({ cid, ...authenticationOptions({ key: `login:${cid}`, rpId: webauthnEnv().rpId, allow: [] }) });
  });

  app.post('/api/login/passkey/verify', authStrict, (req, res) => {
    const cred = req.body?.credential;
    const cid = String(req.body?.cid || '');
    const stored = db.prepare('SELECT * FROM passkeys WHERE cred_id = ?').get(String(cred?.id || ''));
    if (!stored) return out(res, 401, { error: 'unknown_credential' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id);
    const handle = cred?.response?.userHandle ? Buffer.from(cred.response.userHandle, 'base64url').toString() : `u${stored.user_id}`;
    let r;
    try {
      if (!user || handle !== `u${user.id}`) throw new Error('user_mismatch');
      r = verifyAuthentication(`login:${cid}`, cred, stored, webauthnEnv());
    } catch (e) {
      audit(db, 'passkey_login_fail', { userId: user?.id ?? null, ip: clientIp(req), detail: e.message });
      return out(res, 401, { error: 'webauthn_failed', detail: e.message });
    }
    if (user.disabled) return out(res, 403, { error: 'account_disabled' });
    db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(r.counter, Date.now(), stored.id);
    audit(db, 'login_ok', { userId: user.id, ip: clientIp(req), detail: 'passkey' });
    const payload = loginPayload(user);
    if (payload.error) return out(res, payload.status, { error: payload.error });
    // Vân tay đã chứng minh người dùng: cấp luôn phiên điều khiển để không hỏi lại ngay.
    noteLogin(db, user, { deviceId: req.headers['x-device-id'], ip: clientIp(req), method: 'vân tay / Face ID' });
    const s = createControlSession(db, user.id, 'passkey', clientIp(req));
    res.json({ ...payload, controlToken: s.token, method: 'passkey', expiresAt: s.expiresAt });
  });


  /** Đã qua step-up chưa? (PC trạm kiểu cũ hoặc phiên điều khiển). App điều khiển gọi hàm này trước khi thi hành lệnh nhạy cảm. */
  function authorize(req, cfg = securityConfig()) {
    if (!cfg.stepUp) return { ok: true, via: 'off' };
    const ip = clientIp(req);
    if (stationOk(db, req.user.id, req.headers, ip, cfg)) return { ok: true, via: 'station' };
    const c = checkControlSession(db, req.user.id, tokenOf(req), ip, cfg);
    if (c.ok) return { ok: true, via: c.method };
    return {
      error: 'step_up_required',
      reason: methodsFor(req.user).enrolled ? c.reason : 'no_factor',
      methods: methodsFor(req.user),
      status: 401,
    };
  }


  /* ---------- PC nhà máy đã ghép cặp (khoá thiết bị, không cần đăng nhập người dùng) ---------- */
  const stationLimit = rateLimit({
    windowMs: 10_000,
    max: Number(process.env.RATE_LIMIT_STATION_CMD || 40),
    keyFn: (req) => `station:${req.station?.id || clientIp(req)}`,
  });
  const pairLimit = rateLimit({ windowMs: 60_000, max: 5, keyFn: (req) => `${clientIp(req)}:pair` });
  const sAuth = stationAuth(db);

  app.post('/api/station/pair', authStrict, pairLimit, async (req, res) => {
    const r = await pairStation(db, {
      code: req.body?.code, publicKey: req.body?.publicKey, hwid: req.body?.hwid, name: req.body?.name, ip: clientIp(req),
    });
    sendR(res, r);
  });

  app.get('/api/station/ping', sAuth, stationLimit, (req, res) => {
    res.json({ ok: true, station: req.station.id, name: req.station.name, site: req.station.site, device: req.station.device });
  });

  /* ---------- Admin: PC trạm (cấp tay, kiểu cũ) ---------- */
  app.get('/api/admin/stations', ...adminOnly, (_req, res) => {
    res.json({ lanConfigured: securityConfig().lanCidrs.length > 0, stations: listStations(db) });
  });

  app.post('/api/admin/stations', ...adminOnly, reauth, (req, res) => {
    const uid = Number(req.body?.userId);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return out(res, 404, { error: 'user_not_found' });
    const s = createStation(db, uid, req.body?.name);
    audit(db, 'station_created', { userId: req.user.id, ip: clientIp(req), detail: `${s.id} user=${uid}` });
    res.json({ ok: true, ...s, note: 'Khoá chỉ hiện một lần. PC gửi header X-Station-Id và X-Station-Key.' });
  });

  app.delete('/api/admin/stations/:id', ...adminOnly, reauth, (req, res) => {
    if (!deleteStation(db, req.params.id)) return out(res, 404, { error: 'not_found' });
    audit(db, 'station_deleted', { userId: req.user.id, ip: clientIp(req), detail: req.params.id });
    res.json({ ok: true });
  });


  return {
    reauth, authorize, enrollGate, methodsFor, issue, tokenOf, strict, stationAuth: sAuth, stationLimit,
  };
}
