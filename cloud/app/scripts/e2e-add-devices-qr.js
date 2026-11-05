#!/usr/bin/env node
/**
 * E2E: gen QR mọi type → seed → HTTP POST /api/devices (luồng webapp) → kiểm tra dashboard.
 * Tuỳ chọn giữ server: --serve  (C# / browser nối vào)
 *
 *   cd cloud/app
 *   node scripts/e2e-add-devices-qr.js
 *   node scripts/e2e-add-devices-qr.js --serve
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import express from 'express';
import Database from 'better-sqlite3';
import {
  configure, migrateSecurity, hashPassword, createSessionAuth, createAppSession, signToken,
} from '@plciot/security';
import { mountUserDevices, migrateUserDevices } from '../src/userDevices.js';
import { DEVICE_TYPES } from '../src/uiContract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const sampleDir = path.join(root, 'tools', 'sample-qrs');
const keepServe = process.argv.includes('--serve');
const PORT = Number(process.env.E2E_PORT || 3099);

function ok(c, m) {
  if (!c) { console.error('FAIL', m); process.exit(1); }
  console.log('ok', m);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-qr-'));
const dbPath = path.join(tmp, 'app.db');

// Gen QR + seed thẳng vào DB e2e (cùng secret với file .txt)
const gen = spawnSync(process.execPath, [
  'scripts/gen-sample-device-qrs.js', '--png', '--seed', dbPath,
], {
  cwd: path.join(root, 'cloud', 'app'),
  encoding: 'utf8',
  env: { ...process.env },
});
process.stdout.write(gen.stdout || '');
process.stderr.write(gen.stderr || '');
ok(gen.status === 0, 'gen-sample-device-qrs --seed');

const envFile = fs.readFileSync(path.join(sampleDir, 'claim-root.env'), 'utf8');
for (const line of envFile.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)="(.*)"$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/\\n/g, '\n');
}
process.env.APP_JWT_SECRET = process.env.APP_JWT_SECRET || 'sample-qr-secret-16c';
process.env.RATE_LIMIT_CLAIM = process.env.RATE_LIMIT_CLAIM || '100';
configure({ secret: () => process.env.APP_JWT_SECRET });

const db = new Database(dbPath);
// Bảng users có thể đã tạo tối thiểu bởi gen — bổ sung cột thiếu
try {
  db.exec(`ALTER TABLE users ADD COLUMN login_password_hash TEXT`);
} catch { /* exists */ }
try {
  db.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0`);
} catch { /* exists */ }
migrateSecurity(db);
migrateUserDevices(db);

const index = JSON.parse(fs.readFileSync(path.join(sampleDir, 'index.json'), 'utf8'));
const items = index.items || index;
ok(items.length >= 10, `có ${items.length} QR mẫu`);

const uid = db.prepare(
  `INSERT INTO users (username, password_hash, login_password_hash, folder_path, notify_site, notify_device, setup_complete, site_owner)
   VALUES (?,?,?,?,?,?,1,1)`,
).run('e2e_qr', hashPassword('TestQr!234'), hashPassword('TestQr!234'), 'f_e2e', 's_tmp', 'x').lastInsertRowid;

const app = express();
app.use(express.json({ limit: '256kb' }));
const requireAuth = createSessionAuth(db, process.env.APP_JWT_SECRET);
mountUserDevices(app, { db, requireAuth, sensitiveStrict: (_r, _s, n) => n() });

const server = await new Promise((resolve) => {
  const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${PORT}`;
const sid = createAppSession(db, uid, 'e2e');
const token = signToken({ uid, tv: 0, sid }, process.env.APP_JWT_SECRET);

fs.writeFileSync(path.join(sampleDir, 'e2e-session.json'), JSON.stringify({
  base, token, username: 'e2e_qr', password: 'TestQr!234',
}, null, 2));

async function api(method, pathName, body) {
  const r = await fetch(`${base}${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Schema
const sch = await api('GET', '/api/v1/ui/schema');
ok(sch.ok && sch.data.deviceTypes?.length >= Object.keys(DEVICE_TYPES).length, 'GET schema');

// Add từng tem module (không dùng gw seed để kiểm tra từng type)
const moduleFiles = items.filter((i) => i.device !== 'gw01');
const addedTypes = new Set();
for (const it of moduleFiles) {
  const qr = fs.readFileSync(path.join(sampleDir, it.file), 'utf8').trim();
  const r = await api('POST', '/api/devices', { qr });
  ok(r.ok, `POST /api/devices ${it.profile} (${it.device}) → ${r.data.error || 'ok'}`);
  for (const a of r.data.added || []) addedTypes.add(a.type);
}

const dash = await api('GET', '/api/v1/ui/dashboard?mode=simple');
ok(dash.ok, 'GET dashboard');
const typesOnDash = new Set((dash.data.devices || []).map((d) => d.type));
for (const t of Object.keys(DEVICE_TYPES)) {
  if (t === 'iot-hub') continue; // hub thường không là card con
  ok(typesOnDash.has(t), `dashboard có type ${t}`);
}
ok((dash.data.devices || []).every((d) => d.widgets?.length > 0), 'mọi device có widgets');

console.log('\n=== WEBAPP API: PASS ===');
console.log(`Devices on dashboard: ${dash.data.devices.length}`);
console.log(`Session: ${path.join(sampleDir, 'e2e-session.json')}`);
console.log(`Base: ${base}`);

if (keepServe) {
  console.log('\nServer giữ chạy cho C# / browser. Ctrl+C để dừng.');
  console.log('C#: dotnet run --project tools/CsUiQrE2e -- --base', base, '--session', path.join(sampleDir, 'e2e-session.json'));
  await new Promise(() => {});
} else {
  server.close();
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('e2e-add-devices-qr: all passed');
}
