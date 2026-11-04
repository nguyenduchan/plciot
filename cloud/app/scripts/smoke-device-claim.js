#!/usr/bin/env node
/**
 * Smoke: provision QR → claim → pending user (không OTP/SĐT).
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
    createAccount: async (database, { site, device }) => {
      const username = `u_${crypto.randomBytes(4).toString('hex')}`;
      const r = database.prepare(
        'INSERT INTO users (username, password_hash, folder_path, notify_site, notify_device, setup_complete, site_owner, role) VALUES (?, ?, ?, ?, ?, 0, 1, ?)',
      ).run(username, hashPassword('x'), `f_${username}`, site, device, 'operator');
      return database.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    },
  },
});

function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg);
    process.exit(1);
  }
  console.log('ok', msg);
}

const prov = provisionHardwareDevice(db, { site: 'plantA', device: 'plc01' });
ok(prov.ok && prov.qr, 'provision');
const decoded = decodeClaimQr(prov.qr);
ok(decoded?.sig, 'decode qr');
ok(!verifyClaimSignature(decoded).error, 'verify sig');

const claimed = await claimHardwareDevice(db, { qr: prov.qr, ip: '127.0.0.1', deviceId: 'browser-device-id-123456' });
ok(claimed.ok && claimed.user?.setup_complete === 0, 'claim creates incomplete user');
ok(claimed.site === 'plantA' && claimed.device === 'plc01', 'site/device bound');
ok(claimed.user.username.startsWith('u_'), 'anonymous username');
ok(!claimed.user.phone, 'no phone');

// Hoàn tất setup rồi claim lại phải bị chặn
db.prepare('UPDATE users SET setup_complete = 1 WHERE id = ?').run(claimed.user.id);
const blocked = await claimHardwareDevice(db, { qr: prov.qr });
ok(blocked.error === 'device_already_claimed' || blocked.error === 'site_taken', `claimed device blocked (${blocked.error})`);

try { db.close(); } catch { /* ignore */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows lock */ }
console.log('smoke-device-claim: all passed');
