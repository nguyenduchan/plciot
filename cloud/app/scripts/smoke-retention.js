#!/usr/bin/env node
/** Offline smoke test: per-plan retention purge, wipe, device transfer. */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-ret-'));
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.APP_JWT_SECRET = 'x'.repeat(32);
delete process.env.HISTORY_DEFAULT_DAYS;

const { openDb, upsertUser } = await import('../src/db.js');
const { insertEvent } = await import('../src/historyStore.js');
const R = await import('../src/retention.js');
const { transferDevice, wipeOwnHistory } = await import('../src/deviceTransfer.js');
const { hashPassword } = await import('../src/auth.js');

const db = openDb(tmp);
let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };
const DAY = 86400e3;
const now = Date.now();
const mk = (phone, site) => upsertUser(db, {
  username: phone, passwordHash: hashPassword('pw12345'), folderPath: site, version: '1', phone, notifySite: site, notifyDevice: 'plc01',
});
const ev = (site, daysAgo) => insertEvent(db, { ts: now - daysAgo * DAY, site, device: 'plc01', kind: 'telemetry', payload: '{}', o: 1, i: 1, a: 0, c: 1, s: 0 });
const count = (site) => db.prepare('SELECT COUNT(*) n FROM mqtt_events WHERE site = ?').get(site).n;

const free = mk('84900000001', 'sfree');
const p10 = mk('84900000002', 's10');
const unl = mk('84900000003', 'sunl');
for (const s of ['sfree', 's10', 'sunl', 'sorphan']) [1, 2.9, 3.5, 9, 50].forEach((d) => ev(s, d));

ok(R.defaultDays() === 3, 'default is 3 days');
ok(R.parseRetention('3').error && R.parseRetention('4').value === 4 && R.parseRetention('unlimited').value === 0 && R.parseRetention('default').value === null, 'plan parsing (>=4, unlimited, default)');
R.setRetention(db, p10.id, 10);
R.setRetention(db, unl.id, 0);
R.purgeByPlan(db, now);
ok(count('sfree') === 2, 'free keeps <=3 days');
ok(count('sorphan') === 2, 'orphan data uses default');
ok(count('s10') === 4, '10-day plan keeps up to 10 days');
ok(count('sunl') === 5, 'unlimited keeps everything');

// shared device: longest plan wins
const sharer = mk('84900000004', 's10');
R.purgeByPlan(db, now);
ok(count('s10') === 4, 'shared site keeps longest plan');

// read window
ok(Math.abs(R.retentionFloor(free, now) - (now - 3 * DAY)) < 5 && R.retentionFloor({ retention_days: 0 }, now) === 0, 'read floor clamps');

// wipe own + transfer
ok(wipeOwnHistory(db, free, {}).error === 'invalid_credentials', 'wipe needs re-auth');
ok(wipeOwnHistory(db, free, { reauthed: true }).deleted === 2 && count('sfree') === 0, 'wipe own history');
const t = await transferDevice(db, p10.id, free.id, { admin: 't' });
ok(t.ok && count('s10') === 0, 'transfer wipes history');
const after = db.prepare('SELECT notify_site s, token_version tv FROM users WHERE id = ?');
ok(after.get(free.id).s === 's10' && after.get(p10.id).s === 's84900000002' && after.get(free.id).tv === 1, 'namespace handed over, sessions revoked');

db.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
