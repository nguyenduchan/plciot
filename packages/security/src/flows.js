import { getConfig, rawSecret } from './config.js';
import { clientIp } from './net.js';
import { rateLimit } from './rateLimit.js';
import { findUserByPhone } from './accounts.js';
import { createSessionAuth, createAppSession, createLoginChallenge, signToken, mountLoginSessions } from './auth.js';
import { factorSummary } from './sessions.js';
import { noteLogin } from './loginAlerts.js';
import { mountSecurityRoutes } from './routes.js';
import { requestLoginOtp, requestRegisterOtp, verifyLoginOtp, verifyRegisterOtp } from './otp.js';
import * as Account from './accountSecurity.js';
import { canonicalDeviceKey, verifyDeviceProof } from './deviceProof.js';

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
  const pendingLogin = (user, req) => {
    const challenge = createLoginChallenge(db, user, String(req.headers['x-device-id'] || ''), secret, req.body || {});
    const factors = factorSummary(db, user.id);
    return { ...challenge, methods: { passkey: factors.passkeys > 0, totp: factors.totp, enrolled: factors.passkeys > 0 || factors.totp } };
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