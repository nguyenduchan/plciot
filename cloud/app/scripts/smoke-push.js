#!/usr/bin/env node
/** Offline smoke test: Web Push — đăng ký ẩn danh, chống SSRF, cảnh báo vượt ngưỡng / mất kết nối, dọn đăng ký chết. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-push-'));
process.env.DATA_DIR = tmp;
process.env.PUSH_COOLDOWN_SEC = '300';
const { openDb, upsertUser } = await import('../src/db.js');
const wp = await import('../src/webPush.js');
const al = await import('../src/pushAlerts.js');
const { migrateGatewayConfigs } = await import('../src/gatewayConfig.js');
const { migrateUserDevices } = await import('../src/userDevices.js');

let fails = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { fails++; console.error('FAIL', m); } };

const db = openDb(tmp);
migrateUserDevices(db); migrateGatewayConfigs(db);
const u1 = upsertUser(db, { username: 'pu1', passwordHash: 'x', folderPath: 'u_pu1', version: '1', notifySite: 'siteA', notifyDevice: 'gw1' });
const u2 = upsertUser(db, { username: 'pu2', passwordHash: 'x', folderPath: 'u_pu2', version: '1', notifySite: 'siteB', notifyDevice: 'gw9' });
const key = (n) => 'A'.repeat(n);
const sub = (host, id) => ({ endpoint: `https://${host}/send/${id}`, keys: { p256dh: key(87), auth: key(22) } });

// --- đăng ký
ok(wp.saveSubscription(db, u1.id, sub('fcm.googleapis.com', 'a')).ok, 'đăng ký FCM hợp lệ');
ok(wp.saveSubscription(db, u1.id, sub('evil.example.com', 'b')).error === 'invalid_endpoint', 'chặn endpoint lạ (SSRF)');
ok(wp.saveSubscription(db, u1.id, { endpoint: 'http://fcm.googleapis.com/x', keys: sub('x', 'c').keys }).error === 'invalid_endpoint', 'chặn http');
ok(wp.saveSubscription(db, u1.id, { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'bad', auth: 'bad' } }).error === 'invalid_keys', 'chặn khoá sai');
ok(wp.saveSubscription(db, u2.id, sub('updates.push.services.mozilla.com', 'm')).ok, 'user 2 đăng ký Mozilla');
for (let i = 0; i < 7; i++) wp.saveSubscription(db, u1.id, sub('fcm.googleapis.com', 'x' + i));
ok(db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id=?').get(u1.id).n === 5, 'tối đa 5 thiết bị/user');
const cols = db.prepare("SELECT name FROM pragma_table_info('push_subs')").all().map((c) => c.name).join(',');
ok(!/email|phone|ip|agent|name/.test(cols), `bảng push_subs không có cột cá nhân (${cols})`);

// --- cảnh báo
const sent = [];
let dead = null;
wp.setPushSender(async (s, body) => { if (dead && s.endpoint === dead) { const e = new Error('gone'); e.statusCode = 410; throw e; } sent.push({ ep: s.endpoint, p: JSON.parse(body) }); });
const cfg = [{ id: 'tank1', name: 'Bồn nước', fields: [{ key: 'level', lbl: 'Mức nước', unit: '%', low: 15, high: 92 }] }];
db.prepare('INSERT INTO gateway_configs (tenant_id, site, device, rev, hash, devices, updated_at) VALUES (?,?,?,?,?,?,?)').run('default', 'siteA', 'gw1', 1, 'h', JSON.stringify(cfg), Date.now());
const ev = (v, now) => al.evaluateTelemetryAlerts(db, { tenantId: 'default', site: 'siteA', device: 'gw1', d: { tank1: { level: v } }, now });
const t0 = Date.now();
ok(ev(50, t0).length === 0, 'bình thường: không báo');
const f = ev(95, t0 + 1000);
ok(f.length === 1 && f[0].level === 'high', 'vượt ngưỡng cao: báo');
await new Promise((r) => setTimeout(r, 50));
ok(sent.length > 0 && sent.every((s) => s.ep.includes('/send/')) && /vượt ngưỡng cao/.test(sent[0].p.b), 'push gửi tới thiết bị của user siteA');
ok(!sent.some((s) => s.ep.includes('mozilla')), 'user siteB không nhận cảnh báo của siteA');
ok(ev(96, t0 + 2000).length === 0, 'vẫn cao: không báo lặp');
ok(ev(50, t0 + 3000).length === 0 && ev(10, t0 + 4000).length === 1, 'về bình thường rồi xuống thấp: báo thấp');
ok(ev(95, t0 + 5000).length === 0, 'chống spam: cooldown 5 phút cùng mức');
ok(ev(50, t0 + 6000).length === 0 && ev(95, t0 + 400_000).length === 1, 'hết cooldown: báo lại');
const n0 = sent.length;
ok(al.evaluateStatusAlert(db, { site: 'siteA', device: 'gw1', text: 'offline', now: t0 + 1e6 }) === true, 'mất kết nối: báo');
ok(al.evaluateStatusAlert(db, { site: 'siteA', device: 'gw1', text: 'online', now: t0 + 2e6 }) === false, 'online: không báo');
await new Promise((r) => setTimeout(r, 50));
ok(sent.length > n0, 'push trạng thái đã gửi');

// --- đăng ký chết bị xoá
dead = db.prepare('SELECT endpoint FROM push_subs WHERE user_id=? LIMIT 1').get(u1.id).endpoint;
await wp.pushToUser(db, u1.id, { t: 'x' });
ok(!db.prepare('SELECT 1 FROM push_subs WHERE endpoint=?').get(dead), '410 → xoá đăng ký chết');

// --- API
const app = express(); app.use(express.json());
const requireAuth = (req, _res, next) => { req.user = { id: u2.id }; next(); };
wp.mountPush(app, { db, requireAuth, dataDir: tmp });
const srv = http.createServer(app).listen(0); const port = srv.address().port;
const call = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, b: await r.json() }; };
const k = await call('/api/push/key');
ok(k.s === 200 && k.b.publicKey.length > 60, 'GET /api/push/key');
ok(fs.existsSync(path.join(tmp, 'vapid.json')), 'khoá VAPID tự sinh và lưu');
const s2 = sub('web.push.apple.com', 'ios');
ok((await call('/api/push/subscribe', 'POST', { subscription: s2 })).s === 200, 'POST subscribe (Apple)');
ok((await call('/api/push/status')).b.devices === 2, 'status: 2 thiết bị');
ok((await call('/api/push/unsubscribe', 'POST', { endpoint: s2.endpoint })).b.removed === 1, 'unsubscribe');
const tst = await call('/api/push/test', 'POST', {});
ok(tst.s === 200 && tst.b.sent === 1, 'test push');
ok((await call('/api/push/test', 'POST', {})).s === 429, 'test push bị giới hạn tần suất');
srv.close();

if (fails) { console.error(`\n${fails} test hỏng`); process.exit(1); }
console.log('\nsmoke-push OK');
