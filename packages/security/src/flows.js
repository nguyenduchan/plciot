import { getConfig, rawSecret, notify } from './config.js';
import { clientIp } from './net.js';
import { rateLimit } from './rateLimit.js';
import { findUserByUsername } from './accounts.js';
import { createSessionAuth, createAppSession, createLoginChallenge, signToken, mountLoginSessions, hashPassword, verifyPassword, consumeLoginChallenge } from './auth.js';
import jwt from 'jsonwebtoken';
import { audit, countAudit } from './audit.js';
import { verifyAuthentication } from './webauthn.js';
import { factorSummary } from './sessions.js';
import { noteLogin, markDeviceTrusted, isDeviceTrusted } from './loginAlerts.js';
import { mountSecurityRoutes } from './routes.js';
import * as Account from './accountSecurity.js';
import { verifyDeviceProof, rememberAuthDevice } from './deviceProof.js';
import { claimHardwareDevice, acceptInviteToken, identitySubject } from './deviceClaim.js';
import {
  privacyPublicConfig, requirePrivacyConsent, recordPrivacyConsent, privacyConsentStatus,
} from './privacy.js';
import { tryRecoveryCode, generateRecoveryCodes, recoveryCodesRemaining } from './recoveryCodes.js';

export function mountAuthentication(app, { db, appPayload = () => ({}), registrationContext = {}, adminOnly = [], extraStatus, authConfig = () => ({}), presencePaths = {} } = {}) {
  const secret = rawSecret();
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('security_secret_required');
  app.use(['/api/login', '/api/register', '/api/account', '/api/recovery', '/api/webauthn', '/api/devices', '/api/device', '/api/control'],
    (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const requireAuth = createSessionAuth(db, secret);
  const authStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_AUTH || 10), keyFn: (req) => `${clientIp(req)}:auth` });
  const sensitiveStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_SENSITIVE || 8), keyFn: (req) => `${clientIp(req)}:sensitive:${req.user?.id || req.body?.id || ''}` });
  const claimStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_CLAIM || 8), keyFn: (req) => `${clientIp(req)}:claim` });
  const send = (res, result) => res.status(result.error ? result.status || 400 : 200).json(result);
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const registrationOpen = () => String(process.env.REGISTRATION_OPEN || 'true').toLowerCase() !== 'false';
  const pendingLogin = (user, req, src = 'claim') => {
    const challenge = createLoginChallenge(db, user, String(req.headers['x-device-id'] || ''), secret, req.body || {}, src);
    const factors = factorSummary(db, user.id);
    return {
      ...challenge, src, isNew: user.setup_complete === 0,
      username: user.username,
      methods: { passkey: factors.passkeys > 0, totp: factors.totp, password: Boolean(user.login_password_hash), enrolled: factors.passkeys > 0 || factors.totp },
    };
  };
  const loginPayload = (user, req) => {
    const data = appPayload(user, req);
    if (data.error) return data;
    const sid = createAppSession(db, user.id, String(req.headers['x-device-id'] || ''));
    return { ...data, userId: user.id, username: user.username, role: user.role,
      token: signToken({ uid: user.id, tv: user.token_version | 0, sid }, secret) };
  };
  const finalizeSetup = async (user, tokenPayload) => {
    if (!tokenPayload?.nw || user.setup_complete !== 0) return { user };
    try {
      const ready = await getConfig().identity.activateAccount?.(db, user, registrationContext);
      if (ready?.error) return ready;
    } catch { return { error: 'provision_failed', status: 500 }; }
    db.prepare('UPDATE users SET setup_complete = 1 WHERE id = ?').run(user.id);
    audit(db, 'account_activated', { userId: user.id });
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
  };
  const security = mountSecurityRoutes(app, { db, requireAuth, adminOnly: [requireAuth, ...adminOnly], loginPayload, pendingLogin, authStrict, extraStatus });
  mountLoginSessions(app, { db, requireAuth, sensitiveStrict, loginPayload, pendingLogin, clientIp, finalizeSetup });

  app.get('/api/auth/config', (_req, res) => res.json({
    channel: 'device',
    registrationOpen: registrationOpen(),
    deviceTrustDays: Number(process.env.DEVICE_TRUST_DAYS || process.env.OTP_TRUST_DAYS) > 0
      ? Number(process.env.DEVICE_TRUST_DAYS || process.env.OTP_TRUST_DAYS)
      : 30,
    presence: Boolean(getConfig().presence.enabled),
    ...privacyPublicConfig(),
    ...authConfig(),
  }));

  /* ---------- Claim QR phần cứng / mã mời → phiên chờ setup ---------- */
  app.post('/api/devices/claim', authStrict, claimStrict, asyncRoute(async (req, res) => {
    if (!registrationOpen()) return send(res, { error: 'registration_closed', status: 403 });
    const consent = requirePrivacyConsent(req.body);
    if (consent.error) return send(res, consent);
    const result = await claimHardwareDevice(db, {
      qr: req.body?.qr || req.body?.payload,
      registrationContext,
      ip: clientIp(req),
      deviceId: req.headers['x-device-id'],
    });
    if (result.error) return send(res, result);
    recordPrivacyConsent(db, result.user.id, { version: consent.version, ip: clientIp(req) });
    audit(db, 'privacy_consent', { userId: result.user.id, ip: clientIp(req), detail: consent.version });
    result.user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.user.id);
    const challenge = pendingLogin(result.user, req, 'claim');
    if (!challenge.error) {
      noteLogin(db, result.user, { deviceId: req.headers['x-device-id'], ip: clientIp(req), method: 'claim QR' });
      markDeviceTrusted(db, result.user.id, req.headers['x-device-id']);
    }
    send(res, { ...challenge, site: result.site, device: result.device });
  }));

  app.post('/api/invites/redeem', authStrict, claimStrict, asyncRoute(async (req, res) => {
    if (!registrationOpen()) return send(res, { error: 'registration_closed', status: 403 });
    const consent = requirePrivacyConsent(req.body);
    if (consent.error) return send(res, consent);
    const result = await acceptInviteToken(db, {
      token: req.body?.token || req.body?.code,
      registrationContext,
      ip: clientIp(req),
    });
    if (result.error) return send(res, result);
    recordPrivacyConsent(db, result.user.id, { version: consent.version, ip: clientIp(req) });
    audit(db, 'privacy_consent', { userId: result.user.id, ip: clientIp(req), detail: consent.version });
    result.user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.user.id);
    const challenge = pendingLogin(result.user, req, 'invite');
    if (!challenge.error) {
      noteLogin(db, result.user, { deviceId: req.headers['x-device-id'], ip: clientIp(req), method: 'invite' });
      markDeviceTrusted(db, result.user.id, req.headers['x-device-id']);
    }
    send(res, { ...challenge, site: result.site, device: result.device, role: result.role });
  }));

  app.post('/api/account/privacy/consent', requireAuth, sensitiveStrict, asyncRoute(async (req, res) => {
    const consent = requirePrivacyConsent({ ...req.body, consent: true });
    if (consent.error) return send(res, consent);
    recordPrivacyConsent(db, req.user.id, { version: consent.version, ip: clientIp(req) });
    audit(db, 'privacy_consent', { userId: req.user.id, ip: clientIp(req), detail: consent.version });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    send(res, { ok: true, ...privacyConsentStatus(user) });
  }));

  const PW_LOCK_FAILS = 5;
  const PW_LOCK_WINDOW = 15 * 60_000;
  const DUMMY_HASH = hashPassword('plciot-timing-equalizer');
  const passwordOk = (password) => typeof password === 'string' && password.length >= 8 && Buffer.byteLength(password) <= 72;
  const passwordLocked = (user) => countAudit(db, user.id, 'pw_fail', Date.now() - PW_LOCK_WINDOW) >= PW_LOCK_FAILS;
  const pwStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_PASSWORD || 8), keyFn: (req) => `${clientIp(req)}:pw:${String(req.body?.username || req.user?.id || '')}` });

  app.post('/api/account/password', requireAuth, sensitiveStrict, security.reauth, asyncRoute(async (req, res) => {
    const password = req.body?.password;
    const uname = String(req.user.username || '');
    if (!passwordOk(password) || (uname.length >= 4 && String(password).toLowerCase().includes(uname.toLowerCase()))) {
      return send(res, { error: 'password_weak', status: 400 });
    }
    db.prepare('UPDATE users SET login_password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
    audit(db, 'password_set', { userId: req.user.id, ip: clientIp(req) });
    send(res, { ok: true });
  }));

  /** Kế hoạch đăng nhập theo username (không PII). Không username → chỉ passkey discoverable. */
  app.post('/api/login/start', authStrict, asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    if (!username) return send(res, { passkeyOnly: true });
    const user = findUserByUsername(db, username);
    if (user && !user.disabled && user.setup_complete !== 0 && isDeviceTrusted(db, user.id, req.headers['x-device-id'])) {
      const f = factorSummary(db, user.id);
      return send(res, { hasPasskey: f.passkeys > 0, hasPassword: Boolean(user.login_password_hash), username: user.username });
    }
    // Không lộ tồn tại tài khoản
    send(res, { hasPasskey: false, hasPassword: Boolean(user?.login_password_hash && isDeviceTrusted(db, user.id, req.headers['x-device-id'])) });
  }));

  app.post('/api/login/password', authStrict, pwStrict, asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const user = findUserByUsername(db, username);
    const password = String(req.body?.password || '');
    const usable = Boolean(user?.login_password_hash) && !user.disabled && !user.recovery_required;
    const match = verifyPassword(password, usable ? user.login_password_hash : DUMMY_HASH);
    if (usable && passwordLocked(user)) return send(res, { error: 'password_locked', status: 429 });
    if (!usable || !match) {
      if (user) audit(db, 'pw_fail', { userId: user.id, ip: clientIp(req) });
      return send(res, { error: 'password_invalid', status: 401 });
    }
    const deviceId = String(req.headers['x-device-id'] || '');
    if (!verifyDeviceProof(db, { subject: identitySubject(user), deviceId, action: 'password-login', publicKey: req.body?.publicKey, proof: req.body?.deviceProof })) {
      return send(res, { error: 'device_proof_required', status: 401 });
    }
    if (!isDeviceTrusted(db, user.id, deviceId)) {
      const { cid, credential } = req.body || {};
      if (!credential) {
        audit(db, 'pw_new_device', { userId: user.id, ip: clientIp(req) });
        return send(res, { error: 'password_new_device', status: 401 });
      }
      const stored = db.prepare('SELECT * FROM passkeys WHERE cred_id = ? AND user_id = ?').get(String(credential?.id || ''), user.id);
      let okBio = false;
      if (stored) {
        try {
          const rr = verifyAuthentication(`login:${String(cid || '')}`, credential, stored, recoverWebauthnEnv());
          db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(rr.counter, Date.now(), stored.id);
          okBio = true;
        } catch { okBio = false; }
      }
      if (!okBio) return send(res, { error: 'webauthn_failed', status: 401 });
    }
    try { rememberAuthDevice(db, user.id, deviceId, req.body?.publicKey, 'Thiết bị'); } catch { return send(res, { error: 'device_revoked', status: 401 }); }
    const payload = loginPayload(user, req);
    if (payload.error) return send(res, { error: payload.error, status: payload.status });
    noteLogin(db, user, { deviceId, ip: clientIp(req), method: 'mật khẩu' });
    markDeviceTrusted(db, user.id, deviceId);
    audit(db, 'login_ok', { userId: user.id, ip: clientIp(req), detail: 'password' });
    send(res, payload);
  }));

  /* Khôi phục: mật khẩu + passkey, hoặc mã khôi phục + passkey/password */
  const recoverStrict = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_RECOVER || 8), keyFn: (req) => `${clientIp(req)}:rec:${String(req.body?.username || '')}` });
  const recoverWebauthnEnv = () => {
    const origins = String(process.env.WEBAUTHN_ORIGINS || getConfig().publicUrl() || 'http://localhost:3080').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
    return { origins, rpId: process.env.WEBAUTHN_RP_ID || new URL(origins[0]).hostname };
  };
  const REC_FAILS = 5;
  const REC_WINDOW = 15 * 60_000;

  app.post('/api/login/recover', authStrict, recoverStrict, asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const user = findUserByUsername(db, username);
    const { password, credential, cid, recoveryCode } = req.body || {};
    const groups = new Set([recoveryCode && 'recovery', password && 'knowledge', credential && 'device'].filter(Boolean));
    if (groups.size < 2) return send(res, { error: 'recover_need_two', status: 400 });
    if (!user || user.disabled) return send(res, { error: 'recover_invalid', status: 401 });
    if (countAudit(db, user.id, 'recover_fail', Date.now() - REC_WINDOW) >= REC_FAILS) return send(res, { error: 'recover_locked', status: 429 });
    const deviceId = String(req.headers['x-device-id'] || '');
    if (!verifyDeviceProof(db, { subject: identitySubject(user), deviceId, action: 'recover', publicKey: req.body?.publicKey, proof: req.body?.deviceProof })) {
      return send(res, { error: 'device_proof_required', status: 401 });
    }
    const fail = (error, status = 401) => { audit(db, 'recover_fail', { userId: user.id, ip: clientIp(req), detail: error }); return send(res, { error, status }); };
    if (password) {
      if (!user.login_password_hash || !verifyPassword(String(password), user.login_password_hash)) return fail('password_invalid');
    }
    if (credential) {
      const stored = db.prepare('SELECT * FROM passkeys WHERE cred_id = ? AND user_id = ?').get(String(credential?.id || ''), user.id);
      if (!stored) return fail('unknown_credential');
      try {
        const r = verifyAuthentication(`login:${String(cid || '')}`, credential, stored, recoverWebauthnEnv());
        db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(r.counter, Date.now(), stored.id);
      } catch { return fail('webauthn_failed'); }
    }
    if (recoveryCode) {
      const rc = tryRecoveryCode(db, user, String(recoveryCode), clientIp(req));
      if (rc === 'locked') return fail('recover_locked', 429);
      if (rc !== 'ok') return fail('recovery_invalid');
    }
    try { rememberAuthDevice(db, user.id, deviceId, req.body?.publicKey, 'Thiết bị khôi phục'); } catch { return send(res, { error: 'device_revoked', status: 401 }); }
    const payload = loginPayload(user, req);
    if (payload.error) return send(res, { error: payload.error, status: payload.status });
    const sid = jwt.decode(payload.token)?.sid;
    const methods = [...groups].map((g) => ({ recovery: 'mã khôi phục', knowledge: 'mật khẩu', device: 'vân tay / Face ID' }[g])).join(' + ');
    noteLogin(db, user, { deviceId, ip: clientIp(req), method: `khôi phục: ${methods}` });
    markDeviceTrusted(db, user.id, deviceId);
    audit(db, 'recover_ok', { userId: user.id, ip: clientIp(req), detail: methods });
    notify(db, user, {
      subject: 'Tài khoản vừa được khôi phục trên một máy mới',
      html: `<b>🔐 Tài khoản vừa được khôi phục</b> bằng ${methods}.\nNếu không phải bạn, hãy vào Cài đặt → Đăng xuất mọi máy và đổi mật khẩu.`,
    });
    send(res, { ...payload, token: signToken({ uid: user.id, tv: user.token_version | 0, sid, rec: Date.now() }, secret), recovered: true });
  }));

  app.post('/api/account/reauth', requireAuth, sensitiveStrict, asyncRoute(async (req, res) => {
    if (req.tokenPayload.scope !== 'full') return send(res, { error: 'unauthorized', status: 401 });
    const { password } = req.body || {};
    if (!password) return send(res, { error: 'missing_credentials', status: 400 });
    if (!req.user.login_password_hash) return send(res, { error: 'password_invalid', status: 401 });
    if (passwordLocked(req.user)) return send(res, { error: 'password_locked', status: 429 });
    if (!verifyPassword(String(password), req.user.login_password_hash)) {
      audit(db, 'pw_fail', { userId: req.user.id, ip: clientIp(req) });
      return send(res, { error: 'password_invalid', status: 401 });
    }
    audit(db, 'reauth_ok', { userId: req.user.id, ip: clientIp(req), detail: 'password' });
    send(res, { ok: true, token: signToken({ uid: req.user.id, tv: req.user.token_version | 0, sid: req.tokenPayload.sid }, secret) });
  }));

  app.post('/api/login/complete-basic', requireAuth, sensitiveStrict, asyncRoute(async (req, res) => {
    const payload = req.tokenPayload;
    if (payload.scope !== 'login_pending') return send(res, { error: 'login_step_up_required', status: 401 });
    if (!req.body?.password) return send(res, { error: 'login_step_up_required', status: 401 });
    if (!req.user.login_password_hash) return send(res, { error: 'password_invalid', status: 401 });
    if (req.body?.bioCapable && !req.body?.bioOptOut) return send(res, { error: 'biometric_required', status: 400 });
    if (payload.nw && req.body?.bioCapable) return send(res, { error: 'biometric_required', status: 400 });
    if (req.body?.bioCapable && req.body?.bioOptOut) audit(db, 'bio_optout', { userId: req.user.id, ip: clientIp(req) });
    if (passwordLocked(req.user)) return send(res, { error: 'password_locked', status: 429 });
    if (!verifyPassword(String(req.body.password), req.user.login_password_hash)) {
      audit(db, 'pw_fail', { userId: req.user.id, ip: clientIp(req) });
      return send(res, { error: 'password_invalid', status: 401 });
    }
    if (!consumeLoginChallenge(db, payload, { ok: true, loginId: payload.jti })) return send(res, { error: 'login_step_up_required', status: 401 });
    const fin = await finalizeSetup(req.user, payload);
    if (fin.error) return send(res, fin);
    const result = loginPayload(fin.user, req);
    if (result.error) return send(res, { error: result.error, status: result.status });
    noteLogin(db, fin.user, { deviceId: req.headers['x-device-id'], ip: clientIp(req), method: payload.src === 'resume' ? 'mở khoá mật khẩu' : 'mật khẩu' });
    markDeviceTrusted(db, req.user.id, req.headers['x-device-id']);
    const extras = {};
    if (payload.nw && recoveryCodesRemaining(db, fin.user.id) === 0) {
      extras.recoveryCodes = generateRecoveryCodes(db, fin.user.id);
    }
    send(res, { ...result, ...extras });
  }));

  app.get('/api/account/security', requireAuth, (req, res) => res.json(Account.accountSecuritySummary(db, req.user)));
  app.post('/api/account/recovery-codes', requireAuth, sensitiveStrict, security.reauth, asyncRoute(async (req, res) => {
    send(res, await Account.regenerateRecoveryCodes(db, req.user, { reauthed: req.reauthed, ip: clientIp(req) }));
  }));

  return { ...security, requireAuth, authStrict, sensitiveStrict, pendingLogin, loginPayload, close: () => {} };
}
