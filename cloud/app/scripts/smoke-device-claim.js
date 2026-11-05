#!/usr/bin/env node
/**
 * Smoke: provision QR → claim bởi user ĐÃ đăng nhập (không tạo user từ QR).
 * Chạy: node scripts/smoke-device-claim.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  configure, migrateSecurity, generateClaimRootKeyPair, provisionHardwareDevice,
  claimHardwareDevice, verifyClaimSignature, decodeClaimQr, hashPassword,
} from '@plciot/security';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plciot-claim-'));
const dbPath = path.join(tmp, 't.db');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1',
    phone TEXT,
    notify_site TEXT NOT NULL DEFAULT 'factory1',
    notify_device TEXT NOT NULL DEFAULT 'plc01',
    site_owner INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'operator',
    disabled INTEGER NOT NULL DEFAULT 0,
    setup_complete INTEGER NOT NULL DEFAULT 1
  );
`);
migrateSecurity(db);

const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = 'smoke-claim-secret-16chars';

configure({
  secret: () => process.env.APP_JWT_SECRET,
  identity: {
    createAccount: async (database, { site, device, username: chosen }) => {
      const username = chosen || `u_${crypto.randomBytes(4).toString('hex')}`;
      const r = database.prepare(
        'INSERT INTO users (username, password_hash, folder_path, notify_site, notify_device, setup_complete, site_owner, role) VALUES (?, ?, ?, ?, ?, 0, 1, ?)',
      ).run(username, hashPassword('x'), `f_${username}`, site, device, 'operator');
      return database.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    },
    onDeviceClaimed: async () => ({ ok: true }),
  },
});

function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg);
    process.exit(1);
  }
  console.log('ok', msg);
}

const me = db.prepare(
  'INSERT INTO users (username, password_hash, folder_path, notify_site, notify_device, setup_complete, site_owner, role) VALUES (?, ?, ?, ?, ?, 1, 1, ?)',
).run('owner1', hashPassword('x'), 'f_owner1', 's_temp', 'plc01', 'operator');
const userId = me.lastInsertRowid;

const prov = provisionHardwareDevice(db, { site: 'plantA', device: 'plc01' });
ok(prov.ok && prov.qr, 'provision');
const decoded = decodeClaimQr(prov.qr);
ok(decoded?.sig, 'decode qr');
ok(!verifyClaimSignature(decoded).error, 'verify sig');

const noAuth = await claimHardwareDevice(db, { qr: prov.qr, ip: '127.0.0.1' });
ok(noAuth.error === 'unauthorized', 'claim without userId rejected');

const claimed = await claimHardwareDevice(db, {
  qr: prov.qr, userId, ip: '127.0.0.1', deviceId: 'browser-device-id-123456',
});
ok(claimed.ok && !claimed.already, 'claim binds existing user');
ok(claimed.site === 'plantA' && claimed.device === 'plc01', 'site/device bound');
ok(claimed.user.id === userId, 'same user id');
ok(claimed.user.notify_site === 'plantA', 'user notify_site updated');
ok(db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 1, 'no extra user created');

const again = await claimHardwareDevice(db, { qr: prov.qr, userId });
ok(again.ok && again.already, 'idempotent re-claim by same user');

const other = db.prepare(
  'INSERT INTO users (username, password_hash, folder_path, notify_site, notify_device, setup_complete, site_owner, role) VALUES (?, ?, ?, ?, ?, 1, 1, ?)',
).run('owner2', hashPassword('x'), 'f_owner2', 's_other', 'plc01', 'operator');
const blocked = await claimHardwareDevice(db, { qr: prov.qr, userId: other.lastInsertRowid });
ok(blocked.error === 'device_already_claimed', `claimed device blocked (${blocked.error})`);

try { db.close(); } catch { /* ignore */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows lock */ }
console.log('smoke-device-claim: all passed');
