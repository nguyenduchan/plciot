import { getConfig, rawSecret, notify } from './config.js';
import { clientIp } from './net.js';
import { rateLimit } from './rateLimit.js';
import { findUserByPhone } from './accounts.js';
import crypto from 'node:crypto';
import { createSessionAuth, createAppSession, createLoginChallenge, signToken, mountLoginSessions, hashPassword, verifyPassword, consumeLoginChallenge } from './auth.js';
import jwt from 'jsonwebtoken';
import { audit, countAudit } from './audit.js';
import { authenticationOptions, verifyAuthentication } from './webauthn.js';
import { factorSummary } from './sessions.js';
import { noteLogin } from './loginAlerts.js';
import { mountSecurityRoutes } from './routes.js';
import { requestLoginOtp, requestRegisterOtp, verifyLoginOtp, verifyRegisterOtp, requestEmailRecoveryOtp } from './otp.js';
import * as Account from './accountSecurity.js';
import { canonicalDeviceKey, verifyDeviceProof, rememberAuthDevice } from './deviceProof.js';

export function mountAuthentication(app, { db, appPayload = () => ({}), registrationContext = {}, adminOnly = [], extraStatus, authConfig = () => ({}), presencePaths = {} } = {}) {
  const secret = rawSecret();
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('security_secret_required');
  app.use(['/api/login', '/api/register', '/api/account', '/api/recovery', '/api/webauthn', '/api/devices', '/api/device', '/api/control'],
    (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const requireAuth = createSessionAuth(db, secret);
  const authStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_AUTH || 10), keyFn: (req) => `${clientIp(req)}:auth` });
  const sensitiveStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_SENSITIVE || 8), keyFn: (req) => `${clientIp(req)}:sensitive:${req.user?.id || req.body?.oldPhone || req.body?.id || ''}` });
  const otpStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_OTP || 5), keyFn: (req) => `${clientIp(req)}:otp:${getConfig().identity.normalize(req.body?.phone)}` });
  const send = (res, result) => res.status(result.error ? result.status || 400 : 200).json(result);
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const registrationOpen = () => String(process.env.REGISTRATION_OPEN || 'true').toLowerCase() !== 'false';
  const pendingLogin = (user, req, src = 'otp') => {
    const challenge = createLoginChallenge(db, user, String(req.headers['x-device-id'] || ''), secret, req.body || {}, src);
    const factors = factorSummary(db, user.id);
    return { ...challenge, src, methods: { passkey: factors.passkeys > 0, totp: factors.totp, password: Boolean(user.login_password_hash), enrolled: factors.passkeys > 0 || factors.totp } };
  };
  const loginPayload = (user, req) => {
    const data = appPayload(user, req);
    if (data.error) return data;
    const sid = createAppSession(db, user.id, String(req.headers['x-device-id'] || ''));
    return { ...data, userId: user.id, username: user.username, role: user.role,
      token: signToken({ uid: user.id, tv: user.token_version | 0, sid }, secret) };
  };
  const security = mountSecurityRoutes(app, { db, requireAuth, adminOnly: [requireAuth, ...adminOnly], loginPayload, authStrict, extraStatus });
  mountLoginSessions(app, { db, requireAuth, sensitiveStrict, loginPayload, pendingLogin, clientIp });
  app.get('/api/auth/config', (_req, res) => res.json({ channel: 'otp', registrationOpen: registrationOpen(), presence: Boolean(getConfig().presence.enabled), ...authConfig() }));
  app.post('/api/register/request-otp', authStrict, otpStrict, asyncRoute(async (req, res) => {
    if (!registrationOpen()) return send(res, { error: 'registration_closed', status: 403 });
    send(res, await requestRegisterOtp(db, { phone: req.body?.phone }));
  }));
  app.post('/api/login/request-otp', authStrict, otpStrict, asyncRoute(async (req, res) => {
    const phone = getConfig().identity.normalize(req.body?.phone);
    const known = findUserByPhone(db, phone);
    if (!known && !registrationOpen()) return send(res, { error: 'registration_closed', status: 403 });
    const purpose = known ? 'login' : 'register';
    const result = known ? await requestLoginOtp(db, { phone }) : await requestRegisterOtp(db, { phone });
    send(res, { ...result, purpose });
  }));
  for (const [path, purpose] of [['/api/register/verify', 'register'], ['/api/login/verify-otp', 'login']]) {
    app.post(path, authStrict, otpStrict, asyncRoute(async (req, res) => {
      if (purpose === 'register' && !registrationOpen()) return send(res, { error: 'registration_closed', status: 403 });
      const input = { ...registrationContext, phone: req.body?.phone, otp: req.body?.otp };
      const result = purpose === 'register' ? await verifyRegisterOtp(db, input) : verifyLoginOtp(db, input);
      if (result.error) return send(res, result);
      const challenge = pendingLogin(result.user, req);
      if (!challenge.error) noteLogin(db, result.user, { deviceId: req.headers['x-device-id'], ip: clientIp(req), method: `OTP ${purpose}` });
      send(res, challenge);
    }));
  }
  /* ---------- Mật khẩu đăng nhập (tuỳ chọn): chỉ dùng trên máy đã tin cậy; OTP vẫn là lối vào máy mới ---------- */
  const PW_LOCK_FAILS = 5;
  const PW_LOCK_WINDOW = 15 * 60_000;
  const DUMMY_HASH = hashPassword('plciot-timing-equalizer');
  const passwordOk = (password) => typeof password === 'string' && password.length >= 8 && Buffer.byteLength(password) <= 72;
  const passwordLocked = (user) => countAudit(db, user.id, 'pw_fail', Date.now() - PW_LOCK_WINDOW) >= PW_LOCK_FAILS;
  const pwStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_PASSWORD || 8), keyFn: (req) => `${clientIp(req)}:pw:${getConfig().identity.normalize(req.body?.phone)}` });
  app.post('/api/account/password', requireAuth, sensitiveStrict, security.reauth, asyncRoute(async (req, res) => {
    const password = req.body?.password;
    const digits = String(req.user.phone || req.user.username).replace(/\D/g, '').slice(-9);
    if (!passwordOk(password) || String(password).replace(/\D/g, '').includes(digits)) return send(res, { error: 'password_weak', status: 400 });
    db.prepare('UPDATE users SET login_password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
    audit(db, 'password_set', { userId: req.user.id, ip: clientIp(req) });
    send(res, { ok: true });
  }));
  app.post('/api/login/password', authStrict, pwStrict, asyncRoute(async (req, res) => {
    const phone = getConfig().identity.normalize(req.body?.phone);
    const user = findUserByPhone(db, phone);
    const password = String(req.body?.password || '');
    const usable = Boolean(user?.login_password_hash) && !user.disabled && !user.recovery_required;
    const match = verifyPassword(password, usable ? user.login_password_hash : DUMMY_HASH);
    if (usable && passwordLocked(user)) return send(res, { error: 'password_locked', status: 429 });
    if (!usable || !match) {
      if (user) audit(db, 'pw_fail', { userId: user.id, ip: clientIp(req) });
      return send(res, { error: 'password_invalid', status: 401 });
    }
    const deviceId = String(req.headers['x-device-id'] || '');
    if (!verifyDeviceProof(db, { subject: phone, deviceId, action: 'password-login', publicKey: req.body?.publicKey, proof: req.body?.deviceProof })) {
      return send(res, { error: 'device_proof_required', status: 401 });
    }
    const known = deviceId && db.prepare('SELECT 1 FROM known_devices WHERE user_id = ? AND dev_hash = ?')
      .get(user.id, crypto.createHash('sha256').update(`${user.id}:${deviceId}`).digest('hex'));
    if (!known) {
      audit(db, 'pw_new_device', { userId: user.id, ip: clientIp(req) });
      return send(res, { error: 'password_new_device', status: 401 });
    }
    try { rememberAuthDevice(db, user.id, deviceId, req.body?.publicKey, 'Thiết bị'); } catch { return send(res, { error: 'device_revoked', status: 401 }); }
    const payload = loginPayload(user, req);
    if (payload.error) return send(res, { error: payload.error, status: payload.status });
    noteLogin(db, user, { deviceId, ip: clientIp(req), method: 'mật khẩu' });
    audit(db, 'login_ok', { userId: user.id, ip: clientIp(req), detail: 'password' });
    send(res, payload);
  }));
  /* ---------- Khôi phục bằng 2 yếu tố KHÁC NHÓM: kênh (OTP Telegram hoặc email, chỉ tính một) / mật khẩu / vân tay-Face ID ---------- */
  const recoverStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_RECOVER || 8), keyFn: (req) => `${clientIp(req)}:rec:${getConfig().identity.normalize(req.body?.phone)}` });
  const recoverWebauthnEnv = () => {
    const origins = String(process.env.WEBAUTHN_ORIGINS || getConfig().publicUrl() || 'http://localhost:3080').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
    return { origins, rpId: process.env.WEBAUTHN_RP_ID || new URL(origins[0]).hostname };
  };
  const REC_FAILS = 5;
  const REC_WINDOW = 15 * 60_000;
  app.post('/api/login/recover/otp', authStrict, recoverStrict, asyncRoute(async (req, res) => {
    const phone = getConfig().identity.normalize(req.body?.phone);
    send(res, req.body?.channel === 'email' ? await requestEmailRecoveryOtp(db, { phone }) : await requestLoginOtp(db, { phone }));
  }));
  app.post('/api/login/recover', authStrict, recoverStrict, asyncRoute(async (req, res) => {
    const phone = getConfig().identity.normalize(req.body?.phone);
    const user = findUserByPhone(db, phone);
    const { channel, otp, password, credential, cid } = req.body || {};
    const groups = new Set([otp && 'channel', password && 'knowledge', credential && 'device'].filter(Boolean));
    if (groups.size < 2) return send(res, { error: 'recover_need_two', status: 400 });
    if (!user || user.disabled) return send(res, { error: 'recover_invalid', status: 401 });
    if (countAudit(db, user.id, 'recover_fail', Date.now() - REC_WINDOW) >= REC_FAILS) return send(res, { error: 'recover_locked', status: 429 });
    const deviceId = String(req.headers['x-device-id'] || '');
    if (!verifyDeviceProof(db, { subject: phone, deviceId, action: 'recover', publicKey: req.body?.publicKey, proof: req.body?.deviceProof })) {
      return send(res, { error: 'device_proof_required', status: 401 });
    }
    const fail = (error, status = 401) => { audit(db, 'recover_fail', { userId: user.id, ip: clientIp(req), detail: error }); return send(res, { error, status }); };
    if (password) {
      if (!user.login_password_hash || !verifyPassword(String(password), user.login_password_hash)) return fail('password_invalid');
    }
    if (credential) {
      const stored = db.prepare('SELECT * FROM passkeys WHERE cred_id = ? AND user_id = ?').get(String(credential?.id || ''), user.id);
      if (!stored) return fail('unknown_credential');
      try { const r = verifyAuthentication(`login:${String(cid || '')}`, credential, stored, recoverWebauthnEnv()); db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(r.counter, Date.now(), stored.id); }
      catch { return fail('webauthn_failed'); }
    }
    if (otp) {
      const r = verifyLoginOtp(db, { phone, otp: String(otp), purpose: channel === 'email' ? 'recover_email' : 'login' });
      if (r.error) return fail(r.error, r.status);
    }
    try { rememberAuthDevice(db, user.id, deviceId, req.body?.publicKey, 'Thiết bị khôi phục'); } catch { return send(res, { error: 'device_revoked', status: 401 }); }
    const payload = loginPayload(user, req);
    if (payload.error) return send(res, { error: payload.error, status: payload.status });
    const sid = jwt.decode(payload.token)?.sid;
    const methods = [...groups].map((g) => ({ channel: channel === 'email' ? 'email' : 'Telegram', knowledge: 'mật khẩu', device: 'vân tay / Face ID' }[g])).join(' + ');
    noteLogin(db, user, { deviceId, ip: clientIp(req), method: `khôi phục: ${methods}` });
    audit(db, 'recover_ok', { userId: user.id, ip: clientIp(req), detail: methods });
    notify(db, user, {
      subject: 'Tài khoản vừa được khôi phục trên một máy mới',
      html: `<b>🔐 Tài khoản vừa được khôi phục</b> bằng ${methods}.\nNếu không phải bạn, hãy vào Cài đặt → Điều khiển → Đăng xuất mọi máy ngay và đổi mật khẩu. Điều khiển thiết bị trên máy này vẫn bị khoá cho tới khi xác nhận thêm.` + (clientIp(req) ? ` (IP ${clientIp(req)})` : ''),
    });
    send(res, { ...payload, token: signToken({ uid: user.id, tv: user.token_version | 0, sid, rec: Date.now() }, secret), recovered: true });
  }));
  // Xác nhận lại ngay trong app (không phải đăng xuất): mật khẩu hoặc OTP Telegram → token mới có iat mới,
  // đủ "vừa đăng nhập" để bật vân tay / Authenticator khi phiên đã quá 10 phút.
  app.post('/api/account/reauth', requireAuth, sensitiveStrict, asyncRoute(async (req, res) => {
    if (req.tokenPayload.scope !== 'full') return send(res, { error: 'unauthorized', status: 401 });
    const { password, otp } = req.body || {};
    if (password) {
      if (!req.user.login_password_hash) return send(res, { error: 'password_invalid', status: 401 });
      if (passwordLocked(req.user)) return send(res, { error: 'password_locked', status: 429 });
      if (!verifyPassword(String(password), req.user.login_password_hash)) {
        audit(db, 'pw_fail', { userId: req.user.id, ip: clientIp(req) });
        return send(res, { error: 'password_invalid', status: 401 });
      }
    } else if (otp) {
      const r = verifyLoginOtp(db, { phone: req.user.phone || req.user.username, otp: String(otp) });
      if (r.error) return send(res, r);
    } else return send(res, { error: 'missing_credentials', status: 400 });
    audit(db, 'reauth_ok', { userId: req.user.id, ip: clientIp(req), detail: password ? 'password' : 'otp' });
    send(res, { ok: true, token: signToken({ uid: req.user.id, tv: req.user.token_version | 0, sid: req.tokenPayload.sid }, secret) });
  }));
  // Tài khoản CHƯA có vân tay/Authenticator: không có yếu tố để chứng minh, nên OTP vừa xác minh (hoặc mật khẩu khi mở khoá lại) là đủ để vào.
  // Có yếu tố thì vẫn phải qua /api/login/complete như cũ. Điều khiển thiết bị vẫn cần step-up ở phía server.
  app.post('/api/login/complete-basic', requireAuth, sensitiveStrict, asyncRoute(async (req, res) => {
    const payload = req.tokenPayload;
    const f = factorSummary(db, req.user.id);
    if (payload.scope !== 'login_pending' || f.passkeys > 0 || f.totp) return send(res, { error: 'login_step_up_required', status: 401 });
    if (payload.src === 'resume') {
      if (!req.user.login_password_hash) return send(res, { error: 'login_step_up_required', status: 401 });
      if (passwordLocked(req.user)) return send(res, { error: 'password_locked', status: 429 });
      if (!verifyPassword(String(req.body?.password || ''), req.user.login_password_hash)) {
        audit(db, 'pw_fail', { userId: req.user.id, ip: clientIp(req) });
        return send(res, { error: 'password_invalid', status: 401 });
      }
    }
    if (!consumeLoginChallenge(db, payload, { ok: true, loginId: payload.jti })) return send(res, { error: 'login_step_up_required', status: 401 });
    const result = loginPayload(req.user, req);
    if (result.error) return send(res, { error: result.error, status: result.status });
    noteLogin(db, req.user, { deviceId: req.headers['x-device-id'], ip: clientIp(req), method: payload.src === 'resume' ? 'mở khoá mật khẩu' : 'OTP' });
    send(res, result);
  }));
  app.get('/api/account/security', requireAuth, (req, res) => res.json(Account.accountSecuritySummary(db, req.user)));
  const protectedPost = (path, handler, reauth = true) => app.post(path, requireAuth, sensitiveStrict, ...(reauth ? [security.reauth] : []), asyncRoute(async (req, res) => {
    send(res, await handler(req));
  }));
  protectedPost('/api/account/email/request', (req) => Account.requestEmailVerify(db, req.user, { email: req.body?.email, reauthed: req.reauthed, ip: clientIp(req) }));
  protectedPost('/api/account/email/verify', (req) => Account.verifyEmail(db, req.user, { otp: req.body?.otp, ip: clientIp(req) }));
  protectedPost('/api/account/recovery-codes', (req) => Account.regenerateRecoveryCodes(db, req.user, { reauthed: req.reauthed, ip: clientIp(req) }));
  protectedPost('/api/account/phone/start', (req) => Account.startSelfChange(db, req.user, { ...req.body, reauthed: req.reauthed, ip: clientIp(req), sessionId: req.tokenPayload.sid }));
  protectedPost('/api/account/phone/confirm', (req) => Account.confirmSelfChange(db, req.user, { ...req.body, ip: clientIp(req), sessionId: req.tokenPayload.sid }));
  protectedPost('/api/account/phone/cancel', (req) => Account.cancelChange(db, req.body?.id, { userId: req.user.id, ip: clientIp(req) }), false);
  app.get('/api/phone/cancel', authStrict, (req, res) => {
    const query = `id=${encodeURIComponent(String(req.query.id || ''))}&t=${encodeURIComponent(String(req.query.t || ''))}`;
    res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Huỷ yêu cầu</title><h1>Huỷ yêu cầu đổi số?</h1><p>Chỉ xác nhận nếu bạn muốn huỷ yêu cầu.</p>'
      + `<form method="post" action="/api/phone/cancel?${query}"><button>Xác nhận huỷ</button></form>`);
  });
  app.post('/api/phone/cancel', authStrict, asyncRoute(async (req, res) => {
    const result = await Account.cancelChange(db, String(req.query.id || ''), { token: String(req.query.t || ''), ip: clientIp(req) });
    res.status(result.error ? result.status || 400 : 200).type('html').send('<!doctype html><meta charset="utf-8"><title>Huỷ yêu cầu</title>'
        + `<h1>${result.ok ? 'Đã huỷ yêu cầu' : 'Không thể huỷ yêu cầu'}</h1><a href="/login.html">Đăng nhập</a>`);
      }));
      const publicPost = (path, handler) => app.post(path, authStrict, sensitiveStrict, asyncRoute(async (req, res) => {
    if (path !== '/api/recovery/start') {
      const request = db.prepare('SELECT * FROM phone_changes WHERE id = ? AND kind = ?').get(String(req.body?.id || ''), 'recovery');
      const deviceId = String(req.headers['x-device-id'] || '');
      if (!request || request.recovery_device !== deviceId || request.recovery_public_key !== canonicalDeviceKey(req.body?.publicKey)
        || !verifyDeviceProof(db, { subject: request.id, deviceId, action: req.path, publicKey: request.recovery_public_key, proof: req.body?.deviceProof })) {
        return send(res, { error: 'device_proof_required', status: 401 });
      }
    }
    send(res, await handler(req));
  }));
  const device = (req) => ({ deviceId: String(req.headers['x-device-id'] || ''), publicKey: req.body?.publicKey, deviceProof: req.body?.deviceProof, action: req.path });
  publicPost('/api/recovery/start', (req) => Account.startRecovery(db, { ...req.body, ...device(req), ip: clientIp(req) }));
  publicPost('/api/recovery/confirm', (req) => Account.confirmRecovery(db, { ...req.body, ...device(req), ip: clientIp(req) }));
  publicPost('/api/recovery/status', (req) => Account.recoveryStatus(db, req.body?.id, device(req)));
  for (const path of new Set(['/api/recovery/proof/start', presencePaths.start].filter(Boolean))) publicPost(path, (req) => Account.startPlcChallenge(db, req.body?.id, device(req)));
  for (const path of new Set(['/api/recovery/proof/check', presencePaths.check].filter(Boolean))) publicPost(path, (req) => Account.checkPlcChallenge(db, req.body?.id, device(req)));
  let runningJobs = false;
  const jobs = setInterval(async () => {
    if (runningJobs) return;
    runningJobs = true;
    try { await Account.processDueChanges(db); }
    catch (error) { console.error('security.jobs', error.message); }
    finally { runningJobs = false; }
  }, 60_000);
  jobs.unref?.();
  return { ...security, requireAuth, authStrict, sensitiveStrict, pendingLogin, loginPayload, close: () => clearInterval(jobs) };
}