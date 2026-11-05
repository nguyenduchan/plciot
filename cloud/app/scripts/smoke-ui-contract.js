#!/usr/bin/env node
/**
 * Smoke UI contract + add device từ QR (auto profile).
 * node scripts/smoke-ui-contract.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import {
  configure, migrateSecurity, generateClaimRootKeyPair, provisionHardwareDevice,
  hashPassword, createSessionAuth, signToken, createAppSession,
} from '@plciot/security';
import { migrateUserDevices, mountUserDevices, addDeviceFromQr, getDashboardFor } from '../src/userDevices.js';
import { uiSchemaPublic, getDeviceType } from '../src/uiContract.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-contract-'));
const db = new Database(path.join(tmp, 't.db'));
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT NOT NULL,
    folder_path TEXT NOT NULL, version TEXT DEFAULT '1',
    notify_site TEXT DEFAULT 's_tmp', notify_device TEXT DEFAULT 'plc01',
    site_owner INTEGER DEFAULT 1, role TEXT DEFAULT 'operator',
    disabled INTEGER DEFAULT 0, setup_complete INTEGER DEFAULT 1, token_version INTEGER DEFAULT 0
  );
`);
migrateSecurity(db);
migrateUserDevices(db);

const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = 'ui-contract-smoke-secret';
configure({ secret: () => process.env.APP_JWT_SECRET });

function ok(c, m) { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok', m); }

const schema = uiSchemaPublic();
ok(schema.deviceTypes.includes('env') && schema.widgetKinds.gauge, 'schema public');
ok(getDeviceType('conveyor-v1')?.id === 'conveyor', 'alias conveyor-v1');

const user = db.prepare(
  `INSERT INTO users (username, password_hash, folder_path, notify_site, notify_device, setup_complete, site_owner)
   VALUES (?,?,?,?,?,1,1)`,
).run('u_test', hashPassword('x'), 'f_u', 's_tmp', 'plc01');
const userId = user.lastInsertRowid;
const me = db.prepare('SELECT * FROM users WHERE id=?').get(userId);

const hub = provisionHardwareDevice(db, {
  site: 'demo_home', device: 'gw01', label: 'Hub', profile: 'iot-hub',
  uiMeta: {
    seed: [
      { childId: 'env01', type: 'env', title: 'Phòng' },
      { childId: 'pump1', type: 'pump', title: 'Bơm' },
    ],
  },
});
ok(hub.ok && hub.qr, 'provision hub');

const added = await addDeviceFromQr(db, me, { qr: hub.qr, ip: '127.0.0.1' });
ok(added.ok && added.added.length === 2, `seed ${added.added?.length} devices`);
const dash = getDashboardFor(db, db.prepare('SELECT * FROM users WHERE id=?').get(userId), 'simple');
ok(dash.devices.length === 2 && dash.devices[0].widgets.length > 0, 'dashboard widgets');
ok(dash.devices.every((d) => d.widgets.every((w) => w.kind)), 'all widgets have kind');

const env = provisionHardwareDevice(db, {
  site: 'demo_home', device: 'env01', profile: 'env', label: 'Env',
});
const again = await addDeviceFromQr(db, db.prepare('SELECT * FROM users WHERE id=?').get(userId), { qr: env.qr });
ok(again.ok && again.added.some((a) => a.already), 'idempotent child add');

// HTTP mount smoke
const app = express();
app.use(express.json());
const requireAuth = createSessionAuth(db, process.env.APP_JWT_SECRET);
const sensitiveStrict = (_req, _res, next) => next();
mountUserDevices(app, { db, requireAuth, sensitiveStrict });
const server = app.listen(0);
const port = server.address().port;
const sid = createAppSession(db, userId, 'smoke');
const token = signToken({ uid: userId, tv: 0, sid }, process.env.APP_JWT_SECRET);
const res = await fetch(`http://127.0.0.1:${port}/api/v1/ui/dashboard?mode=simple`, {
  headers: { Authorization: `Bearer ${token}` },
});
ok(res.ok, 'GET dashboard HTTP');
const body = await res.json();
ok(body.schema === 1 && body.devices.length >= 2, 'dashboard body');

server.close();
try { db.close(); } catch { /* ignore */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('smoke-ui-contract: all passed');
