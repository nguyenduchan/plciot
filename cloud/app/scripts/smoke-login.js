import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { signedDevice } from '../../../packages/security/test/device-fixture.js';
import express from 'express';
import { loginScopeAllowed, signToken, verifyToken, createLoginChallenge, createAppSession, createSessionAuth, mountLoginSessions } from '../src/auth.js';
import { openDb, upsertTelegramUser } from '../src/db.js';
import { configure, mountSecurityRoutes, factorSummary, createControlSession, checkControlSession, sealSecret, hotp, stepOf, generateSecret, clientIp, noteLogin } from '@plciot/security';
import * as SecurityCore from '@plciot/security';

assert.equal(createLoginChallenge, SecurityCore.createLoginChallenge, 'Host compatibility exports must share the core implementation');
assert.equal(createSessionAuth, SecurityCore.createSessionAuth, 'Host must not retain a second session guard');
assert.equal(mountLoginSessions, SecurityCore.mountLoginSessions, 'Host must not retain a second login flow');

const pending = { uid: 7, scope: 'login_pending', did: 'device-a' };
const allowed = (method, path, device = 'device-a', payload = pending) => loginScopeAllowed(payload, method, path, device);
assert.ok(allowed('POST', '/api/control/unlock'));
assert.ok(allowed('POST', '/api/webauthn/auth/verify'));
assert.ok(allowed('POST', '/api/login/complete'));
assert.ok(allowed('POST', '/api/devices/requests/abc123/poll'));
assert.ok(allowed('POST', '/api/devices/requests/abc123/email/confirm'));
for (const path of ['/api/me', '/api/bundle/app.js', '/api/account/security', '/api/admin/users', '/api/devices/requests']) {
  assert.equal(allowed('GET', path), false, path);
}
for (const path of ['/api/control/cmd', '/api/devices/requests/abc123/approve', '/api/control/totp/disable', '/api/logout']) {
  assert.equal(allowed('POST', path), false, path);
}
assert.equal(allowed('DELETE', '/api/webauthn/credentials/1'), false);
assert.equal(allowed('POST', '/api/login/complete', 'device-b'), false);
assert.equal(allowed('GET', '/api/me', 'device-a', { uid: 7 }), false);
assert.ok(allowed('GET', '/api/me', 'device-a', { uid: 7, scope: 'full' }));
const secret = 'login-test-secret-at-least-32-chars';
assert.equal(verifyToken(signToken({ uid: 7 }, secret), secret).scope, 'full');
assert.equal(verifyToken(signToken(pending, secret, 600), secret).scope, 'login_pending');
process.env.RATE_LIMIT_CONTROL_AUTH = '1000';
configure({ secret: () => secret, publicUrl: () => 'https://login.test', notify: async () => {} });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-login-'));
const db = openDb(tmp);
const userId = Number(db.prepare("INSERT INTO users (username, password_hash, folder_path) VALUES ('login-user', 'x', 'test')").run().lastInsertRowid);
const otherId = Number(db.prepare("INSERT INTO users (username, password_hash, folder_path) VALUES ('other-user', 'x', 'test')").run().lastInsertRowid);
const totpSecret = generateSecret();
db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?').run(sealSecret(totpSecret), userId);
const user = () => db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
const deviceId = 'login-device-aaaaaaaaaaaa';
const pendingLogin = (account, req) => {
  const challenge = createLoginChallenge(db, account, String(req.headers['x-device-id'] || ''), secret);
  const factors = factorSummary(db, account.id);
  return { ...challenge, methods: { passkey: factors.passkeys > 0, totp: factors.totp, enrolled: factors.passkeys > 0 || factors.totp } };
};
const loginPayload = (account, req) => ({
  userId: account.id, mqtt: { user: 'private-mqtt-user' },
  token: signToken({ uid: account.id, tv: account.token_version | 0, sid: createAppSession(db, account.id, req.headers['x-device-id']) }, secret),
});
const app = express();
app.use(express.json());
const requireAuth = createSessionAuth(db, secret);
const passthrough = (_req, _res, next) => next();
mountLoginSessions(app, { db, requireAuth, sensitiveStrict: passthrough, loginPayload, pendingLogin, clientIp });
mountSecurityRoutes(app, { db, requireAuth, loginPayload, authStrict: passthrough });
for (const route of ['/api/me', '/api/bundle/app.js', '/api/account/security']) app.get(route, requireAuth, (_req, res) => res.json({ private: true }));
const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, route, token, body = {}, extra = {}) => {
  const identity = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const signed = signedDevice(identity.uid, route, extra['X-Device-Id'] || deviceId);
  const response = await fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Device-Id': deviceId, ...extra },
    body: method === 'GET' ? undefined : JSON.stringify({ ...body, publicKey: signed.publicKey, deviceProof: signed.deviceProof }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
};
try {
  const challenge = pendingLogin(user(), { headers: { 'x-device-id': deviceId } });
  assert.equal(challenge.mqtt, undefined);
  assert.equal(challenge.files, undefined);
  assert.equal(verifyToken(challenge.token, secret).exp - verifyToken(challenge.token, secret).iat, 600);
  for (const route of ['/api/me', '/api/bundle/app.js', '/api/account/security']) {
    const result = await call('GET', route, challenge.token);
    assert.equal(result.status, 401, route);
    assert.equal(result.headers.get('X-Renewed-Token'), null);
  }
  assert.equal((await call('POST', '/api/login/complete', challenge.token)).status, 401);
  const wrongAccount = createControlSession(db, otherId, 'totp', '127.0.0.1', undefined, verifyToken(challenge.token, secret).jti);
  assert.equal((await call('POST', '/api/login/complete', challenge.token, {}, { 'X-Control-Token': wrongAccount.token })).status, 401);
  const previousProof = createControlSession(db, userId, 'totp', '127.0.0.1');
  assert.equal((await call('POST', '/api/login/complete', challenge.token, {}, { 'X-Control-Token': previousProof.token })).status, 401);
  assert.equal((await call('POST', '/api/control/unlock', challenge.token, { code: 'wrong' })).status, 401);
  const proof = await call('POST', '/api/control/unlock', challenge.token, { code: hotp(totpSecret, stepOf()) });
  assert.equal(proof.status, 200);
  assert.ok(proof.body.expiresAt - Date.now() <= 300_000);
  const headers = { 'X-Control-Token': proof.body.controlToken };
  assert.equal((await call('POST', '/api/login/complete', challenge.token, {}, { ...headers, 'X-Device-Id': 'other-device' })).status, 401);
  const complete = await call('POST', '/api/login/complete', challenge.token, {}, headers);
  assert.equal(complete.status, 200);
  assert.ok(complete.body.mqtt);
  assert.equal((await call('POST', '/api/login/complete', challenge.token, {}, headers)).status, 401);
  assert.equal((await call('GET', '/api/me', complete.body.token)).status, 200);

  await call('POST', '/api/login/lock', complete.body.token, {}, headers);
  assert.equal((await call('GET', '/api/me', complete.body.token)).body.error, 'app_locked');
  assert.equal((await call('POST', '/api/login/activity', complete.body.token)).status, 401);
  const resume = await call('POST', '/api/login/resume', complete.body.token);
  assert.equal(resume.body.pending, true);
  assert.equal(resume.body.mqtt, undefined);
  assert.equal((await call('POST', '/api/login/complete', resume.body.token, {}, headers)).status, 401);
  db.prepare('UPDATE users SET totp_last_step = 0 WHERE id = ?').run(userId);
  const resumedProof = await call('POST', '/api/control/unlock', resume.body.token, { code: hotp(totpSecret, stepOf()) });
  const resumed = await call('POST', '/api/login/complete', resume.body.token, {}, { 'X-Control-Token': resumedProof.body.controlToken });
  assert.equal(resumed.status, 200);
  assert.equal((await call('GET', '/api/me', complete.body.token)).status, 401, 'Old session stays locked after resume');

  const sid = verifyToken(resumed.body.token, secret).sid;
  await call('POST', '/api/login/background', resumed.body.token);
  db.prepare('UPDATE app_sessions SET background_at = ? WHERE id = ?').run(Date.now() - 60_001, sid);
  assert.equal((await call('GET', '/api/me', resumed.body.token)).body.error, 'app_locked');
  const idleToken = loginPayload(user(), { headers: { 'x-device-id': deviceId } }).token;
  db.prepare('UPDATE app_sessions SET last_seen = ? WHERE id = ?').run(Date.now() - 300_001, verifyToken(idleToken, secret).sid);
  assert.equal((await call('GET', '/api/me', idleToken)).body.error, 'app_locked');

  const freshToken = loginPayload(user(), { headers: { 'x-device-id': deviceId } }).token;
  const freshSid = verifyToken(freshToken, secret).sid;
  const oldJwt = signToken({ uid: userId, sid: freshSid, iat: Math.floor(Date.now() / 1000) - 37 * 3600 }, secret);
  const renewed = await call('GET', '/api/me', oldJwt);
  assert.equal(renewed.status, 200);
  assert.equal(verifyToken(renewed.headers.get('X-Renewed-Token'), secret).sid, freshSid);
  await call('POST', '/api/logout', freshToken);
  assert.equal((await call('GET', '/api/me', freshToken)).status, 401);

  const expired = pendingLogin(user(), { headers: { 'x-device-id': deviceId } });
  db.prepare('UPDATE login_attempts SET expires_at = 1 WHERE id = ?').run(verifyToken(expired.token, secret).jti);
  assert.equal((await call('GET', '/api/control/status', expired.token)).status, 401);
  db.prepare('UPDATE control_sessions SET created_at = ?, expires_at = ? WHERE user_id = ?').run(Date.now() - 301_000, Date.now() + 7 * 86400_000, userId);
  assert.equal(checkControlSession(db, userId, previousProof.token, '127.0.0.1').reason, 'expired');
  assert.equal((await call('GET', '/api/me', signToken({ uid: userId }, secret))).status, 401, 'Legacy tokens without a server session cannot bypass login');

  const identity = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = crypto.randomBytes(20).toString('base64url');
  db.prepare('INSERT INTO passkeys (user_id, cred_id, public_key, alg, counter, created_at) VALUES (?, ?, ?, -7, 0, ?)')
    .run(userId, credentialId, identity.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), Date.now());
  let counter = 0;
  const assertion = (options, { flags = 5, origin = 'https://login.test', privateKey = identity.privateKey, id = credentialId } = {}) => {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
    const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
    const authData = Buffer.concat([crypto.createHash('sha256').update('login.test').digest(), Buffer.from([flags]), count]);
    const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), privateKey);
    return { id, response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') } };
  };
  const passkeyChallenge = pendingLogin(user(), { headers: { 'x-device-id': deviceId } });
  for (const invalid of [{ flags: 1 }, { origin: 'https://phishing.test' }, { privateKey: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }, { id: 'unknown-credential' }]) {
    const options = await call('POST', '/api/webauthn/auth/options', passkeyChallenge.token);
    const result = await call('POST', '/api/webauthn/auth/verify', passkeyChallenge.token, { credential: assertion(options.body, invalid) });
    assert.ok(result.status >= 400, 'Missing UV, wrong origin/signature or credential is rejected');
  }
  const options = await call('POST', '/api/webauthn/auth/options', passkeyChallenge.token);
  const signed = assertion(options.body);
  const passkeyProof = await call('POST', '/api/webauthn/auth/verify', passkeyChallenge.token, { credential: signed });
  assert.equal(passkeyProof.status, 200);
  assert.equal((await call('POST', '/api/webauthn/auth/verify', passkeyChallenge.token, { credential: signed })).status, 401);
  const secondChallenge = pendingLogin(user(), { headers: { 'x-device-id': deviceId } });
  assert.equal((await call('POST', '/api/login/complete', secondChallenge.token, {}, { 'X-Control-Token': passkeyProof.body.controlToken })).status, 401, 'Proof from a different login attempt cannot complete login');
  assert.equal((await call('POST', '/api/login/complete', passkeyChallenge.token, {}, { 'X-Control-Token': passkeyProof.body.controlToken })).status, 200);

  const firstUserId = Number(db.prepare("INSERT INTO users (username, password_hash, folder_path) VALUES ('first-user', 'x', 'test')").run().lastInsertRowid);
  const firstUser = db.prepare('SELECT * FROM users WHERE id = ?').get(firstUserId);
  noteLogin(db, firstUser, { deviceId, ip: '127.0.0.1', method: 'OTP test' });
  const firstLogin = pendingLogin(firstUser, { headers: { 'x-device-id': deviceId } });
  assert.equal((await call('POST', '/api/login/complete', firstLogin.token)).status, 401);
  const setup = await call('POST', '/api/control/totp/setup', firstLogin.token);
  assert.equal(setup.status, 200);
  assert.equal((await call('POST', '/api/control/totp/enable', firstLogin.token, { code: 'wrong' })).status, 401);
  const enabled = await call('POST', '/api/control/totp/enable', firstLogin.token, { code: hotp(setup.body.secret, stepOf()) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.recoveryCodes.length, 10);
  assert.equal((await call('POST', '/api/login/complete', firstLogin.token, {}, { 'X-Control-Token': enabled.body.controlToken })).status, 200);
  const untrustedId = 'new-device-bbbbbbbbbbbbbbbb';
  const newDevice = pendingLogin(user(), { headers: { 'x-device-id': untrustedId } });
  const newHeaders = { 'X-Device-Id': untrustedId };
  assert.equal((await call('POST', '/api/webauthn/register/options', newDevice.token, {}, newHeaders)).body.error, 'step_up_required');
  const deviceRequest = await call('POST', '/api/devices/request', newDevice.token, {}, newHeaders);
  assert.equal(deviceRequest.status, 200);
  assert.equal((await call('POST', `/api/devices/requests/${deviceRequest.body.id}/approve`, newDevice.token, {}, newHeaders)).status, 401);

  const statusToken = pendingLogin(user(), { headers: { 'x-device-id': deviceId } }).token;
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId);
  assert.equal((await call('GET', '/api/control/status', statusToken)).body.error, 'account_disabled');
  db.prepare('UPDATE users SET disabled = 0, token_version = token_version + 1 WHERE id = ?').run(userId);
  assert.equal((await call('GET', '/api/control/status', statusToken)).body.error, 'session_revoked');
  const expiredJwt = signToken({ uid: userId, scope: 'login_pending', did: deviceId, jti: 'expired', tv: 1 }, secret, -1);
  assert.equal((await call('GET', '/api/control/status', expiredJwt)).status, 401);
  process.env.TELEGRAM_BOT_TOKEN = 'local-test-token';
  process.env.TELEGRAM_SHARED_PG_HOST = '';
  process.env.TELEGRAM_SHARED_DATABASE_URL = '';
  process.env.MQTT_CONFIG_DIR = path.join(tmp, 'mqtt-config');
  process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';
  const otp = await import('../src/otp.js');
  const telegram = [];
  const realFetch = globalThis.fetch;
  let sendFailure = false;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.telegram.org/')) throw new Error('Unexpected external request in OTP test');
    telegram.push(JSON.parse(options.body));
    return new Response(JSON.stringify(sendFailure ? { ok: false, description: 'test failure' } : { ok: true }), { status: sendFailure ? 502 : 200 });
  };
  const lastCode = () => telegram.at(-1).text.match(/<code>(\d{6})<\/code>/)[1];
  const mkOtpUser = (phone, linked = true) => {
    const accountId = Number(db.prepare("INSERT INTO users (username, phone, chat_id, password_hash, folder_path) VALUES (?, ?, ?, 'x', 'test')")
      .run(phone, phone, linked ? Number(phone.slice(-6)) : null).lastInsertRowid);
    if (linked) upsertTelegramUser(db, phone, Number(phone.slice(-6)));
    return accountId;
  };
  try {
    assert.equal((await otp.requestLoginOtp(db, { phone: '123' })).error, 'invalid_phone');
    assert.equal((await otp.requestLoginOtp(db, { phone: '84987659999' })).error, 'user_not_found');
    mkOtpUser('84987650001', false);
    assert.equal((await otp.requestLoginOtp(db, { phone: '84987650001' })).error, 'telegram_not_linked');
    mkOtpUser('84987650002');
    assert.equal(otp.verifyLoginOtp(db, { phone: '84987650002', otp: '123456' }).error, 'otp_missing');
    assert.ok((await otp.requestLoginOtp(db, { phone: '84987650002' })).ok);
    const validCode = lastCode();
    assert.equal(otp.verifyLoginOtp(db, { phone: '84987650002', otp: 'wrong' }).error, 'otp_invalid');
    assert.ok(otp.verifyLoginOtp(db, { phone: '84987650002', otp: validCode }).ok);
    assert.equal(otp.verifyLoginOtp(db, { phone: '84987650002', otp: validCode }).error, 'otp_missing', 'Consumed OTP cannot be replayed');
    await otp.requestLoginOtp(db, { phone: '84987650002' });
    db.prepare('UPDATE otp_challenges SET expires_at = 1 WHERE phone = ?').run('84987650002');
    assert.equal(otp.verifyLoginOtp(db, { phone: '84987650002', otp: lastCode() }).error, 'otp_expired');
    mkOtpUser('84987650003');
    await otp.requestLoginOtp(db, { phone: '84987650003' });
    for (let attempt = 0; attempt < 5; attempt++) assert.equal(otp.verifyLoginOtp(db, { phone: '84987650003', otp: 'wrong' }).error, 'otp_invalid');
    assert.equal(otp.verifyLoginOtp(db, { phone: '84987650003', otp: lastCode() }).error, 'otp_locked');
    mkOtpUser('84987650004');
    for (let attempt = 0; attempt < 6; attempt++) assert.ok((await otp.requestLoginOtp(db, { phone: '84987650004' })).ok);
    assert.equal((await otp.requestLoginOtp(db, { phone: '84987650004' })).error, 'rate_limited');
    sendFailure = true;
    assert.equal((await otp.requestLoginOtp(db, { phone: '84987650002' })).error, 'telegram_send_failed');
    sendFailure = false;
    const registration = { phone: '84987650005', dataDir: tmp, webappSrc: path.join(tmp, 'webapp-source') };
    fs.mkdirSync(registration.webappSrc);
    fs.writeFileSync(path.join(registration.webappSrc, 'index.html'), '<!doctype html><title>Test</title>');
    upsertTelegramUser(db, registration.phone, 50005);
    assert.ok((await otp.requestRegisterOtp(db, registration)).ok);
    const registerCode = lastCode();
    assert.equal((await otp.verifyRegisterOtp(db, { ...registration, otp: 'wrong' })).error, 'otp_invalid');
    assert.ok((await otp.verifyRegisterOtp(db, { ...registration, otp: registerCode })).ok);
    assert.equal((await otp.verifyRegisterOtp(db, { ...registration, otp: registerCode })).error, 'otp_missing');
    assert.equal((await otp.requestRegisterOtp(db, registration)).error, 'user_exists');
  } finally { globalThis.fetch = realFetch; }
  console.log('OTP: invalid/unlinked phone, missing/wrong/expired/locked/replayed code, rate limit, send failure and registration passed');
  console.log('Login scope, HTTP two-factor and app session smoke passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}