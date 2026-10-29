import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { signedDevice } from './device-fixture.js';
import { configure, migrateSecurity, mountAuthentication, hotp, stepOf, verifyToken, createLoginChallenge, processDueChanges, approveRecovery, openSecret, applyChange } from '../src/index.js';
import { cancelToken } from '../src/accountSecurity.js';

const require = createRequire(new URL('../../../cloud/app/package.json', import.meta.url));
const Database = require('better-sqlite3');
const express = require('express');
const db = new Database(':memory:');
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT DEFAULT 'viewer', disabled INTEGER DEFAULT 0)");
migrateSecurity(db);
const codes = new Map();
let delivered = true;
const secret = 'independent-core-app-secret-32-characters';
configure({
  secret: () => secret, publicUrl: () => 'https://core.test',
  notify: async () => ({ delivered }),
  identity: {
    contact: (user) => user.primary_contact,
    resolveContact: async (_db, phone) => `contact:${phone}`,
    sendCode: async (contact, code) => codes.set(contact, code),
  },
});
process.env.RATE_LIMIT_AUTH = '1000';
process.env.RATE_LIMIT_OTP = '1000';
process.env.RATE_LIMIT_CONTROL_AUTH = '1000';
process.env.RATE_LIMIT_SENSITIVE = '1000';
const app = express();
app.use(express.json());
const preview = process.argv.includes('--serve');
const core = mountAuthentication(app, { db, appPayload: () => ({ version: 'test-v1', files: [] }), authConfig: () => ({ telegram: true }) });
app.get('/private', core.requireAuth, (_req, res) => res.json({ ok: true }));
if (preview) {
  app.get('/__test/otp/:phone', (req, res) => res.json({ code: codes.get(`contact:${req.params.phone}`) }));
  app.get('/__test/factor/:phone', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(req.params.phone);
    const factor = user && openSecret(user.totp_pending || user.totp_secret);
    res.json({ code: factor ? hotp(factor, stepOf()) : null });
  });
  app.get('/index.html', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><title>Core Test</title><h1>Core authentication passed</h1>'));
  app.use(express.static(fileURLToPath(new URL('../../../webapp', import.meta.url))));
}
const server = await new Promise((resolve) => { const listening = app.listen(preview ? 3092 : 0, '127.0.0.1', () => resolve(listening)); });
const base = `http://127.0.0.1:${server.address().port}`;
if (preview) { console.log(`TEST ONLY: in-memory core preview ${base}/login.html`); await new Promise(() => {}); }
const deviceA = 'independent-device-aaaaaaaa';
const deviceB = 'independent-device-bbbbbbbb';
async function call(method, path, body = {}, token, deviceId = deviceA, subject) {
  const signed = signedDevice(subject ?? (token ? verifyToken(token, secret).uid : body.id || body.newPhone || body.phone || ''), path, deviceId);
  const response = await fetch(base + path, { method,
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body.controlToken ? { 'X-Control-Token': body.controlToken } : {}), ...(body.enrollTicket ? { 'X-Enroll-Ticket': body.enrollTicket } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify({ ...body, publicKey: signed.publicKey, deviceProof: signed.deviceProof }),
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = { html: text }; }
  return { status: response.status, body: data };
}
const phone = '84987650101';
try {
  assert.equal((await call('POST', '/api/login/request-otp', { phone })).body.purpose, 'register');
  const pending = await call('POST', '/api/register/verify', { phone, otp: codes.get(`contact:${phone}`) });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.pending, true);
  assert.equal((await call('GET', '/private', {}, pending.body.token)).status, 401);
  let setup = await call('POST', '/api/control/totp/setup', {}, pending.body.token);
  assert.equal(setup.status, 200);
  const factor = await call('POST', '/api/control/totp/enable', { code: hotp(setup.body.secret, stepOf()) }, pending.body.token);
  assert.equal(factor.status, 200);
  const full = await call('POST', '/api/login/complete', { controlToken: factor.body.controlToken }, pending.body.token);
  assert.equal(full.status, 200);
  assert.equal((await call('GET', '/private', {}, full.body.token)).status, 200);
  assert.equal(full.body.mqtt, undefined, 'Core does not require MQTT');
  const userId = full.body.userId;

  const target = '84987650102';
  const recovery = await call('POST', '/api/recovery/start', { oldPhone: phone, newPhone: target }, undefined, deviceB, target);
  assert.equal(recovery.status, 200);
  const id = recovery.body.id;
  assert.equal((await call('POST', '/api/recovery/status', { id }, undefined, deviceA, id)).status, 401, 'Recovery is bound to the requesting device key');
  assert.equal((await call('POST', '/api/recovery/confirm', { id, newOtp: codes.get(`contact:${target}`) }, undefined, deviceB, id)).body.status, 'pending_review');
  assert.equal((await approveRecovery(db, id, { hours: 1, evidence: 'verified-in-person-reference' })).error, 'cooling_period_too_short');
  assert.equal((await approveRecovery(db, id, { hours: 48 })).error, 'review_evidence_required');
  assert.ok((await approveRecovery(db, id, { hours: 48, evidence: 'verified-in-person-reference' })).ok);
  db.prepare('UPDATE phone_changes SET execute_at = 1 WHERE id = ?').run(id);
  await processDueChanges(db);
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  assert.equal(user.phone, target);
  assert.equal(user.recovery_required, 1);
  assert.equal(user.totp_enabled, 0);
  assert.equal((await call('GET', '/private', {}, full.body.token)).status, 401);
  assert.equal(createLoginChallenge(db, user, deviceA, secret).error, 'recovery_device_required');

  const proof = signedDevice(target, 'otp-verify', deviceB);
  const recoveredPending = createLoginChallenge(db, user, deviceB, secret, proof);
  assert.ok(recoveredPending.pending);
  setup = await call('POST', '/api/control/totp/setup', {}, recoveredPending.token, deviceB);
  assert.equal(setup.status, 200);
  const newFactor = await call('POST', '/api/control/totp/enable', { code: hotp(setup.body.secret, stepOf()) }, recoveredPending.token, deviceB);
  assert.equal(newFactor.status, 200);
  const recovered = await call('POST', '/api/login/complete', { controlToken: newFactor.body.controlToken }, recoveredPending.token, deviceB);
  assert.equal(recovered.status, 200);
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  assert.equal(user.recovery_required, 0);
  assert.ok(db.prepare('SELECT used_at FROM recovery_enrollments WHERE user_id = ?').get(userId).used_at);

  const nextPhone = '84987650103';
  const started = await call('POST', '/api/account/phone/start', { newPhone: nextPhone, oldChannel: 'telegram', controlToken: newFactor.body.controlToken }, recovered.body.token, deviceB);
  assert.equal(started.status, 200);
  const change = { id: started.body.id, newOtp: codes.get(`contact:${nextPhone}`), oldOtp: codes.get(`contact:${target}`), controlToken: newFactor.body.controlToken };
  delivered = false;
  assert.equal((await call('POST', '/api/account/phone/confirm', change, recovered.body.token, deviceB)).body.error, 'notification_required');
  assert.equal(db.prepare('SELECT phone FROM users WHERE id = ?').get(userId).phone, target);
  delivered = true;
  const cancelled = await call('GET', `/api/phone/cancel?id=${change.id}&t=${cancelToken(change.id)}`);
  assert.equal(cancelled.status, 200);
  assert.match(cancelled.body.html, /<form method="post"/);
  assert.equal(db.prepare('SELECT status FROM phone_changes WHERE id = ?').get(change.id).status, 'pending_otp');
  await call('POST', `/api/phone/cancel?id=${change.id}&t=${cancelToken(change.id)}`);
  assert.equal(db.prepare('SELECT status FROM phone_changes WHERE id = ?').get(change.id).status, 'cancelled');
  const deviceC = 'independent-device-cccccccc';
  const lostRequest = await call('POST', '/api/devices/request', { replaceLost: true }, recovered.body.token, deviceC);
  assert.equal(lostRequest.status, 200);
  assert.equal((await call('POST', `/api/devices/requests/${lostRequest.body.id}/approve`, { approvalCode: 'wrong', controlToken: newFactor.body.controlToken }, recovered.body.token, deviceB)).status, 401);
  assert.equal((await call('POST', `/api/devices/requests/${lostRequest.body.id}/approve`, { approvalCode: lostRequest.body.approvalCode, controlToken: newFactor.body.controlToken }, recovered.body.token, deviceB)).status, 200);
  const lostPending = createLoginChallenge(db, user, deviceC, secret);
  const ticket = await call('POST', `/api/devices/requests/${lostRequest.body.id}/poll`, { pollToken: lostRequest.body.pollToken }, lostPending.token, deviceC);
  assert.ok(ticket.body.ticket);
  setup = await call('POST', '/api/control/totp/setup', { enrollTicket: ticket.body.ticket }, lostPending.token, deviceC);
  assert.equal(setup.status, 200);
  const replacement = await call('POST', '/api/control/totp/enable', { enrollTicket: ticket.body.ticket, code: hotp(setup.body.secret, stepOf()) }, lostPending.token, deviceC);
  assert.equal(replacement.status, 200);
  assert.equal(replacement.body.recoveryCodes.length, 10, 'Lost-device replacement rotates recovery codes');
  assert.equal((await call('GET', '/private', {}, recovered.body.token, deviceB)).status, 401, 'Lost device sessions are revoked');
  assert.equal(db.prepare('SELECT revoked FROM auth_devices WHERE user_id = ? AND device_id = ?').get(userId, deviceB).revoked, 1);
  const replacementLogin = await call('POST', '/api/login/complete', { controlToken: replacement.body.controlToken }, lostPending.token, deviceC);
  assert.equal(replacementLogin.status, 200);
  const deviceD = 'independent-device-dddddddd';
  const transfer = await call('POST', '/api/devices/request', {}, replacementLogin.body.token, deviceD);
  assert.equal(transfer.status, 200);
  assert.equal((await call('POST', `/api/devices/requests/${transfer.body.id}/approve`, { approvalCode: transfer.body.approvalCode, controlToken: replacement.body.controlToken }, replacementLogin.body.token, deviceC)).status, 200);
  const transferPending = createLoginChallenge(db, user, deviceD, secret);
  const transferTicket = await call('POST', `/api/devices/requests/${transfer.body.id}/poll`, { pollToken: transfer.body.pollToken }, transferPending.token, deviceD);
  setup = await call('POST', '/api/control/totp/setup', { enrollTicket: transferTicket.body.ticket }, transferPending.token, deviceD);
  assert.equal(setup.status, 200);
  const transferFactor = await call('POST', '/api/control/totp/enable', { enrollTicket: transferTicket.body.ticket, code: hotp(setup.body.secret, stepOf()) }, transferPending.token, deviceD);
  assert.equal(transferFactor.status, 200);
  const transferLogin = await call('POST', '/api/login/complete', { controlToken: transferFactor.body.controlToken }, transferPending.token, deviceD);
  assert.equal(transferLogin.status, 200);
  assert.equal((await call('GET', '/private', {}, replacementLogin.body.token, deviceC)).status, 200, 'Normal transfer does not silently revoke the old app session');
  const devices = await call('GET', '/api/devices', { controlToken: transferFactor.body.controlToken }, transferLogin.body.token, deviceD);
  assert.ok(devices.body.devices.some((device) => device.device_id === deviceC));
  assert.equal((await call('POST', `/api/devices/${deviceC}/revoke`, { controlToken: transferFactor.body.controlToken }, transferLogin.body.token, deviceD)).status, 200);
  assert.equal((await call('GET', '/private', {}, replacementLogin.body.token, deviceC)).status, 401);
  assert.equal((await call('GET', '/private', {}, transferLogin.body.token, deviceD)).status, 200, 'Retiring the old device preserves the new device session');
  const deviceE = 'independent-device-eeeeeeee';
  const waiting = await call('POST', '/api/devices/request', {}, transferLogin.body.token, deviceE);
  const waitingLogin = createLoginChallenge(db, user, deviceE, secret);
  delivered = false;
  const failedNotice = await call('POST', `/api/devices/requests/${waiting.body.id}/recovery`, { code: replacement.body.recoveryCodes[0] }, waitingLogin.token, deviceE);
  assert.equal(failedNotice.body.error, 'notification_required');
  db.prepare('UPDATE device_requests SET execute_at = 1 WHERE id = ?').run(waiting.body.id);
  await processDueChanges(db);
  assert.equal(db.prepare('SELECT status FROM device_requests WHERE id = ?').get(waiting.body.id).status, 'cooling');
  delivered = true;
  await processDueChanges(db);
  const retried = db.prepare('SELECT * FROM device_requests WHERE id = ?').get(waiting.body.id);
  assert.equal(retried.notification_state, 'delivered');
  assert.ok(retried.execute_at >= Date.now() + 24 * 3600_000 - 1000, 'Waiting period restarts only after the security notice is delivered');
  const concurrentPhone = '84987650104';
  await call('POST', '/api/register/request-otp', { phone: concurrentPhone });
  const concurrentCode = codes.get(`contact:${concurrentPhone}`);
  const attempts = await Promise.all([
    call('POST', '/api/register/verify', { phone: concurrentPhone, otp: concurrentCode }, undefined, deviceA),
    call('POST', '/api/register/verify', { phone: concurrentPhone, otp: concurrentCode }, undefined, deviceB),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 200).length, 1, 'Concurrent verification consumes a registration OTP only once');
  db.prepare("INSERT INTO phone_changes (id, user_id, kind, old_phone, new_phone, new_contact, status, new_verified, old_verified, notification_state, execute_at, created_at, updated_at) VALUES ('concurrent-apply', ?, 'self', ?, '84987650105', 'contact:84987650105', 'cooling', 1, 1, 'delivered', 1, ?, ?)")
    .run(userId, target, Date.now(), Date.now());
  const applied = await Promise.all([applyChange(db, 'concurrent-apply'), applyChange(db, 'concurrent-apply')]);
  assert.equal(applied.filter((result) => result.ok).length, 1);
  assert.equal(db.prepare("SELECT status FROM phone_changes WHERE id = 'concurrent-apply'").get().status, 'applied', 'Duplicate application cannot overwrite an applied change with rejected status');
  console.log('Independent core: registration, mandatory factor, recovery device binding, lost factor reset, one-time reenrollment, notification failure and safe cancel passed');
} finally {
  core.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
}