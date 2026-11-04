#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  configure, migrateSecurity, generateClaimRootKeyPair, provisionHardwareDevice,
  listHardwareDevices, getHardwareDeviceQr, claimHardwareDevice, deleteHardwareDevice,
} from '@plciot/security';

const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = 'admin-hw-test-secret16';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'));
const db = new Database(path.join(tmp, 't.db'));
db.exec(`CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT NOT NULL DEFAULT 'x',
  folder_path TEXT NOT NULL DEFAULT 'f', version TEXT DEFAULT '1', phone TEXT,
  notify_site TEXT DEFAULT 'f', notify_device TEXT DEFAULT 'plc01', site_owner INTEGER DEFAULT 0,
  role TEXT DEFAULT 'operator', disabled INTEGER DEFAULT 0, setup_complete INTEGER DEFAULT 1
)`);
migrateSecurity(db);
configure({
  secret: () => process.env.APP_JWT_SECRET,
  publicUrl: () => 'https://plc.example',
  identity: {
    createAccount: async (database, { site, device }) => {
      const u = `u_${crypto.randomBytes(3).toString('hex')}`;
      const r = database.prepare(
        'INSERT INTO users (username, password_hash, folder_path, notify_site, notify_device, setup_complete, site_owner) VALUES (?,?,?,?,?,0,1)',
      ).run(u, 'x', `f_${u}`, site, device);
      return database.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    },
  },
});

function ok(cond, msg) {
  if (!cond) { console.error('FAIL', msg); process.exit(1); }
  console.log('ok', msg);
}

const p = provisionHardwareDevice(db, { site: 'plant1', device: 'plc01', label: 'Line A', note: 'SN-1' });
ok(p.ok && p.qr && p.loginUrl.includes('claim='), 'provision + loginUrl');
ok(listHardwareDevices(db).length === 1 && listHardwareDevices(db)[0].label === 'Line A', 'list');
const again = getHardwareDeviceQr(db, { site: 'plant1', device: 'plc01' });
ok(again.qr === p.qr, 'reprint same qr');

const ghost = provisionHardwareDevice(db, { site: 'ghost', device: 'x' });
db.prepare('DELETE FROM hardware_devices WHERE site=?').run('ghost');
const unk = await claimHardwareDevice(db, { qr: ghost.qr });
ok(unk.error === 'unknown_device', 'reject unregistered device');

const claimed = await claimHardwareDevice(db, { qr: p.qr });
ok(claimed.ok, 'claim registered device');
ok(listHardwareDevices(db)[0].claimed, 'marked claimed');

const del = deleteHardwareDevice(db, { site: 'plant1', device: 'plc01' });
ok(del.error === 'device_already_claimed', 'block delete while claimed');
ok(deleteHardwareDevice(db, { site: 'plant1', device: 'plc01', force: true }).ok, 'force delete');

try { db.close(); } catch { /* ignore */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('smoke-admin-hardware: all passed');
