import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { checkControlSession, revokeControlSessions } from './sessions.js';
import { noteLogin } from './loginAlerts.js';
import { getConfig } from './config.js';
import { canonicalDeviceKey, verifyDeviceProof } from './deviceProof.js';

const SALT_ROUNDS = 10;

export function hashPassword(password) {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

/** Hạn JWT (giờ): JWT_TTL_HOURS, mặc định 72. Đang dùng thì được gia hạn trượt (X-Renewed-Token), bỏ 3 ngày mới phải đăng nhập lại. */
export const jwtTtlSeconds = () => Math.max(1, Number(process.env.JWT_TTL_HOURS || 72)) * 3600;

export function signToken(payload, secret, expiresIn = jwtTtlSeconds()) {
  return jwt.sign({ scope: 'full', ...payload }, secret, { expiresIn });
}

export function loginScopeAllowed(payload, method, requestPath, deviceId) {
  if (payload.scope === 'full') return true;
  if (payload.scope !== 'login_pending' || !payload.did || payload.did !== deviceId) return false;
  if (method === 'GET') return requestPath === '/api/control/status';
  if (method !== 'POST') return false;
  return new Set([
    '/api/login/complete', '/api/login/complete-basic', '/api/account/password', '/api/account/email/request', '/api/account/email/verify', '/api/control/unlock',
    '/api/webauthn/auth/options', '/api/webauthn/auth/verify',
    '/api/webauthn/register/options', '/api/webauthn/register/verify',
    '/api/control/totp/setup', '/api/control/totp/enable', '/api/devices/request',
  ]).has(requestPath) || /^\/api\/devices\/requests\/[a-f0-9]+\/(poll|recovery|wait|email\/(start|confirm))$/.test(requestPath);
}

export function createLoginChallenge(db, user, deviceId, secret, device = {}, src = 'otp') {
  if (!deviceId || deviceId.length > 128) return { error: 'device_required', status: 400 };
  const now = Date.now();
  db.prepare('DELETE FROM login_attempts WHERE expires_at < ? OR consumed = 1').run(now);
  const id = crypto.randomBytes(24).toString('hex');
  let recoveryId;
  if (user.recovery_required) {
    const grant = db.prepare('SELECT * FROM recovery_enrollments WHERE user_id = ? AND device_id = ? AND used_at IS NULL AND expires_at > ?').get(user.id, deviceId, now);
    if (!grant || grant.public_key !== canonicalDeviceKey(device.publicKey)
      || !verifyDeviceProof(db, { subject: getConfig().identity.normalize(user.phone || user.username), deviceId, action: 'otp-verify', publicKey: grant.public_key, proof: device.deviceProof })) {
      return { error: 'recovery_device_required', status: 401 };
    }
    recoveryId = grant.change_id;
  }
  db.prepare('INSERT INTO login_attempts (id, user_id, device_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, user.id, deviceId, now + 600_000);
  return {
    pending: true, userId: user.id, expiresAt: now + 600_000,
    token: signToken({ uid: user.id, tv: user.token_version | 0, scope: 'login_pending', did: deviceId, jti: id, src: src === 'resume' ? 'resume' : 'otp', ...(recoveryId ? { rid: recoveryId } : {}) }, secret, 600),
  };
}

export function consumeLoginChallenge(db, payload, proof) {
  if (payload.scope !== 'login_pending' || !proof.ok || proof.loginId !== payload.jti) return false;
  return db.prepare('UPDATE login_attempts SET consumed = 1 WHERE id = ? AND user_id = ? AND device_id = ? AND consumed = 0 AND expires_at > ?')
    .run(payload.jti, payload.uid, payload.did, Date.now()).changes === 1;
}

export function createAppSession(db, userId, deviceId) {
  const id = crypto.randomBytes(24).toString('hex');
  db.prepare('DELETE FROM app_sessions WHERE last_seen < ?').run(Date.now() - jwtTtlSeconds() * 1000);
  db.prepare('INSERT INTO app_sessions (id, user_id, device_id, last_seen) VALUES (?, ?, ?, ?)')
    .run(id, userId, deviceId || '', Date.now());
  return id;
}

export function createSessionAuth(db, secret) {
  return (req, res, next) => {
    const payload = bearerUser(req, secret);
    if (!payload?.uid) return res.status(401).json({ error: 'unauthorized' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user || user.disabled) return res.status(user?.disabled ? 403 : 401).json({ error: user?.disabled ? 'account_disabled' : 'unauthorized' });
    if ((payload.tv | 0) !== (user.token_version | 0)) return res.status(401).json({ error: 'session_revoked' });
    if (!loginScopeAllowed(payload, req.method, req.path, String(req.headers['x-device-id'] || ''))) {
      return res.status(401).json({ error: 'login_step_up_required' });
    }
    const now = Date.now();
    if (payload.scope === 'login_pending') {
      const attempt = db.prepare('SELECT id FROM login_attempts WHERE id = ? AND user_id = ? AND consumed = 0 AND expires_at > ?')
        .get(payload.jti, user.id, now);
      if (!attempt) return res.status(401).json({ error: 'unauthorized' });
    } else {
      const session = db.prepare('SELECT * FROM app_sessions WHERE id = ? AND user_id = ?').get(payload.sid || '', user.id);
      if (!session) return res.status(401).json({ error: 'unauthorized' });
      const locked = session.locked || now - session.last_seen >= 300_000
        || (session.background_at && now - session.background_at >= 60_000);
      if (locked) {
        db.prepare('UPDATE app_sessions SET locked = 1 WHERE id = ?').run(session.id);
        if (!['/api/login/lock', '/api/login/resume', '/api/logout'].includes(req.path)) {
          return res.status(401).json({ error: 'app_locked' });
        }
      } else if (req.path === '/api/login/activity') {
        db.prepare('UPDATE app_sessions SET last_seen = ?, background_at = NULL WHERE id = ?').run(now, session.id);
      }
    }
    req.user = user;
    req.tokenPayload = payload;
    if (payload.scope === 'full' && payload.iat && now / 1000 - payload.iat > jwtTtlSeconds() / 2) {
      res.setHeader('X-Renewed-Token', signToken({ uid: user.id, u: user.username, tv: user.token_version | 0, sid: payload.sid }, secret));
    }
    next();
  };
}

export function mountLoginSessions(app, { db, requireAuth, sensitiveStrict, loginPayload, pendingLogin, clientIp }) {
  app.post('/api/login/complete', requireAuth, sensitiveStrict, (req, res) => {
    const proof = checkControlSession(db, req.user.id, String(req.headers['x-control-token'] || ''), clientIp(req));
    if (!consumeLoginChallenge(db, req.tokenPayload, proof)) return res.status(401).json({ error: 'login_step_up_required' });
    const payload = loginPayload(req.user, req);
    if (payload.error) return res.status(payload.status).json({ error: payload.error });
    noteLogin(db, req.user, { deviceId: req.headers['x-device-id'], ip: clientIp(req), method: `OTP + ${proof.method}` });
    res.json({ ...payload, controlToken: req.headers['x-control-token'], method: proof.method, expiresAt: proof.expiresAt });
  });
  app.post('/api/login/lock', requireAuth, (req, res) => {
    db.prepare('UPDATE app_sessions SET locked = 1 WHERE id = ? AND user_id = ?').run(req.tokenPayload.sid || '', req.user.id);
    const controlToken = String(req.headers['x-control-token'] || '');
    if (controlToken) revokeControlSessions(db, req.user.id, controlToken);
    res.json({ ok: true });
  });
  app.post('/api/login/resume', requireAuth, sensitiveStrict, (req, res) => {
    db.prepare('UPDATE app_sessions SET locked = 1 WHERE id = ? AND user_id = ?').run(req.tokenPayload.sid || '', req.user.id);
    const challenge = pendingLogin(req.user, req, 'resume');
    res.status(challenge.status || 200).json(challenge);
  });
  app.post('/api/login/activity', requireAuth, (_req, res) => res.json({ ok: true }));
  app.post('/api/login/background', requireAuth, (req, res) => {
    db.prepare('UPDATE app_sessions SET background_at = ? WHERE id = ? AND background_at IS NULL').run(Date.now(), req.tokenPayload.sid);
    res.json({ ok: true });
  });
  app.post('/api/logout', requireAuth, (req, res) => {
    db.prepare('DELETE FROM app_sessions WHERE id = ? AND user_id = ?').run(req.tokenPayload.sid || '', req.user.id);
    const controlToken = String(req.headers['x-control-token'] || '');
    if (controlToken) revokeControlSessions(db, req.user.id, controlToken);
    res.json({ ok: true });
  });
}

export function verifyToken(token, secret) {
  return jwt.verify(token, secret);
}

export function bearerUser(req, secret) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  try {
    return verifyToken(m[1], secret);
  } catch {
    return null;
  }
}
