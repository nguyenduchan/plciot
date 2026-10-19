#!/usr/bin/env node
/** Offline smoke test of the account-security flows (Telegram stubbed, temp DB). */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-acct-'));
process.env.DATA_DIR = tmp;
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.WEBAPP_PUBLIC_URL = 'https://example.test';

const sent = [];
globalThis.fetch = async (_url, init) => {
  sent.push(JSON.parse(init.body));
  return { ok: true, json: async () => ({ ok: true }) };
};
const lastCode = (chatId) => {
  const m = [...sent].reverse().find((x) => x.chat_id === chatId && /<code>(\d{6})<\/code>/.test(x.text));
  return m.text.match(/<code>(\d{6})<\/code>/)[1];
};

const { openDb, upsertUser, upsertTelegramUser, findUserById } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const A = await import('../src/accountSecurity.js');
const { consumeRecoveryCode } = await import('../src/recoveryCodes.js');
const { noteTelemetry } = await import('../src/plcProof.js');

const db = openDb(tmp);
let fails = 0;
const ok = (cond, label) => {
  if (!cond) { fails++; console.error('FAIL', label); } else console.log('ok  ', label);
};

const mk = (phone, chat) => {
  upsertTelegramUser(db, phone, chat);
  return upsertUser(db, {
    username: phone, passwordHash: hashPassword('secret1'), folderPath: `u${phone}`, version: '1',
    phone, chatId: chat, notifySite: `s${phone}`, notifyDevice: 'plc01',
  });
};
let u = mk('84987654321', 1001);
upsertTelegramUser(db, '84912345678', 2002);
upsertTelegramUser(db, '84923456789', 3003);
upsertTelegramUser(db, '84934567890', 4004);

// 1) wrong password
ok((await A.startSelfChange(db, u, { newPhone: '0912345678', password: 'bad', oldChannel: 'telegram' })).error === 'invalid_credentials', 'self: wrong password rejected');

// 2) strong path: old OTP + new OTP -> applied immediately, sessions revoked
let r = await A.startSelfChange(db, u, { newPhone: '0912345678', password: 'secret1', oldChannel: 'telegram' });
ok(r.ok, 'self: start');
ok((await A.confirmSelfChange(db, u, { id: r.id, newOtp: '000000', oldOtp: lastCode(1001) })).error === 'otp_invalid', 'self: wrong new OTP');
r = await A.confirmSelfChange(db, u, { id: r.id, newOtp: lastCode(2002), oldOtp: lastCode(1001) });
ok(r.status === 'applied', 'self: strong -> applied');
u = findUserById(db, u.id);
ok(u.username === '84912345678' && u.chat_id === 2002 && u.token_version === 1, 'self: user moved + token_version bumped');

// 3) weak path: recovery code -> cooling -> applied once elapsed
const codes = (await A.regenerateRecoveryCodes(db, u, { password: 'secret1' })).codes;
ok(codes.length === 10, 'codes: 10 generated');
r = await A.startSelfChange(db, u, { newPhone: '0923456789', password: 'secret1', oldChannel: 'recovery_code' });
r = await A.confirmSelfChange(db, u, { id: r.id, newOtp: lastCode(3003), recoveryCode: codes[0] });
ok(r.status === 'cooling', 'weak: recovery code -> cooling');
ok(findUserById(db, u.id).username === '84912345678', 'weak: not applied during cooling');
const hit = sent.find((x) => /api\/phone\/cancel/.test(x.text));
ok(Boolean(hit), 'weak: owner got cancel link');
const m = hit.text.match(/id=([0-9a-f]{32})&t=([\w-]+)/);
ok((await A.cancelChange(db, m[1], { token: 'wrong' })).error === 'forbidden', 'cancel: bad token rejected');
db.prepare('UPDATE phone_changes SET execute_at = 1 WHERE id = ?').run(m[1]);
await A.processDueChanges(db);
ok(findUserById(db, u.id).username === '84923456789', 'weak: applied after cooling elapsed');
u = findUserById(db, u.id);
ok(!consumeRecoveryCode(db, u.id, codes[0]), 'codes: single-use');

// 4) lost everything: ticket -> admin review -> PLC proof -> cooling -> owner veto
r = await A.startRecovery(db, { oldPhone: '84923456789', newPhone: '0934567890', note: 'site s84987654321' });
ok(r.ok, 'recovery: start');
const rid = r.id;
ok((await A.confirmRecovery(db, { id: rid, newOtp: lastCode(4004) })).status === 'pending_review', 'recovery: waits for admin');
ok((await A.startPlcChallenge(db, rid)).error === 'plc_offline', 'plc: offline refused');
noteTelemetry(u.notify_site, u.notify_device, 0);
const ch = await A.startPlcChallenge(db, rid);
ok(ch.ok, 'plc: challenge started');
ok((await A.checkPlcChallenge(db, rid)).plcOk === false, 'plc: no edge yet');
await new Promise((res) => setTimeout(res, 5));
noteTelemetry(u.notify_site, u.notify_device, 1 << ch.bit);
ok((await A.checkPlcChallenge(db, rid)).plcOk === true, 'plc: edge observed');
ok((await A.approveRecovery(db, rid, { hours: 1, admin: 't' })).ok, 'admin: approve -> cooling');
ok((await A.cancelChange(db, rid, { token: A.cancelToken(rid) })).ok, 'owner: veto link cancels');
db.prepare('UPDATE phone_changes SET execute_at = 1 WHERE id = ?').run(rid);
await A.processDueChanges(db);
ok(findUserById(db, u.id).username === '84923456789', 'cancelled ticket is not applied');

db.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
