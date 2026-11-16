#!/usr/bin/env node
/** Smoke: loại webapp theo GATEWAY — user nhiều gateway khác kiểu có bundle chứa giao diện của từng gateway; dashboard trả solution theo gateway. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, '../../../webapp');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plciot-gsol-'));
process.env.SOLUTIONS_DIR = path.resolve(shellDir, '..', 'solutions');
process.env.SOLUTIONS_REGISTRY = path.join(tmp, 'solutions.json');
process.env.APP_JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'mqtt');
process.env.BUNDLE_AUTOSYNC = 'false';
delete process.env.DEFAULT_SOLUTION;
const dataDir = path.join(tmp, 'data');

const { openDb, upsertUser, findUserByUsername } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { syncBundles, shellVersion } = await import('../src/bundleSync.js');
const { resolveBundleRoot } = await import('../src/bundle.js');
const { setGatewaySolution } = await import('../src/gatewaySolution.js');
const { migrateUserDevices, getDashboardFor } = await import('../src/userDevices.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };
const db = openDb(dataDir);
migrateUserDevices(db);
upsertUser(db, { username: 'multi', passwordHash: hashPassword('x'), folderPath: 'u_multi', version: 'old', notifySite: 's1', notifyDevice: 'gwa' });
db.prepare('UPDATE users SET setup_complete = 1 WHERE username = ?').run('multi');
const u = () => findUserByUsername(db, 'multi');
const add = (site, gw, child) => db.prepare("INSERT INTO user_devices (id, user_id, site, gateway_device, child_id, type, title, created_at) VALUES (?, ?, ?, ?, ?, 'sensor', ?, ?)").run(crypto.randomUUID(), u().id, site, gw, child, child, Date.now());
add('s1', 'gwa', 'c1'); add('s2', 'gwb', 'c2');
const root = resolveBundleRoot(dataDir, 'u_multi');

syncBundles(db, { dataDir, shellDir });
ok(u().version === shellVersion(shellDir), 'chưa gateway nào có giải pháp → bản cơ bản');
ok(!fs.existsSync(path.join(root, 'solutions.json')), 'bundle cơ bản không có solutions.json');

setGatewaySolution(db, 's1', 'gwa', 'aqua');
setGatewaySolution(db, 's2', 'gwb', 'hvac');
syncBundles(db, { dataDir, shellDir });
const m = JSON.parse(fs.readFileSync(path.join(root, 'solutions.json'), 'utf8'));
ok(m.aqua && m.hvac, 'solutions.json có giải pháp của cả hai gateway');
ok(fs.existsSync(path.join(root, 'sol/aqua/spec.js')) && fs.existsSync(path.join(root, 'sol/hvac/spec.js')), 'bundle có sol/<id>/spec.js từng giải pháp');
ok(fs.existsSync(path.join(root, 'sol-multi.js')) && fs.existsSync(path.join(root, 'index.html')), 'bundle có shell + sol-multi.js');
ok(fs.existsSync(path.join(root, 'industry-engine.js')) && fs.existsSync(path.join(root, 'industry.css')), 'engine + CSS dùng chung nằm ở shell (một bản)');
ok(!fs.existsSync(path.join(root, 'sol/aqua/industry.js')) && !fs.existsSync(path.join(root, 'sol/aqua/industry.css')), 'giải pháp không chép engine/CSS rời');
ok(!/spec\.js/.test(fs.readFileSync(path.join(root, 'index.html'), 'utf8')), 'index.html không bị chèn spec của giải pháp nào');

const dash = getDashboardFor(db, u(), 'simple');
const g = Object.fromEntries(dash.gateways.map((x) => [x.device, x.solution]));
ok(g.gwa === 'aqua' && g.gwb === 'hvac', 'dashboard.gateways[].solution theo từng gateway');

setGatewaySolution(db, 's2', 'gwb', '');
const v1 = u().version;
syncBundles(db, { dataDir, shellDir });
ok(u().version !== v1 && !fs.existsSync(path.join(root, 'sol/hvac/spec.js')), 'gateway về cơ bản → bundle bỏ giao diện đó');
console.log(fails ? `${fails} FAIL` : 'ALL OK');
try { db.close(); } catch { /* */ }
process.exit(fails ? 1 : 0);
