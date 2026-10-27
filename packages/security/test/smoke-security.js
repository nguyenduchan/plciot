#!/usr/bin/env node
/**
 * Kiểm thử gói @plciot/security ĐỘC LẬP với app PLC: dựng một app đồ chơi (không có PLC, MQTT, Telegram) chỉ với lõi +
 * adapter giả, chứng minh gói tái sử dụng được cho app khác. Chạy: node packages/security/test/smoke-security.js
 * (cần better-sqlite3 và express — có sẵn khi chạy từ cloud/app; hoặc NODE_PATH=cloud/app/node_modules).
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
// tìm dependency của app host (gói tự nó không có dependency)
const hostRequire = createRequire(path.resolve(here, '..', '..', '..', 'cloud', 'app', 'package.json'));
const Database = hostRequire('better-sqlite3');
const express = hostRequire('express');

const S = await import('../src/index.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

/* ---- adapter giả: app đồ chơi tự quyết cách báo tin, email, quyền ---- */
const notes = [];
S.configure({
  secret: () => 'toy-app-secret-toy-app-secret',
  publicUrl: () => 'https://toy.example.com',
  notify: async (_db, user, msg) => { notes.push({ user: user.id, subject: msg.subject }); },
  email: { available: () => false, send: async () => { throw new Error('no email'); } },
  canControl: (u) => u.role === 'staff',
  brand: { rpName: 'Toy' },
});

/* ---- DB: app tự tạo users, lõi tự thêm phần còn lại ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-pkg-'));
const db = new Database(path.join(tmp, 'toy.db'));
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', disabled INTEGER NOT NULL DEFAULT 0)");
S.migrateSecurity(db);
S.migrateSecurity(db); // chạy lại không lỗi (idempotent)
const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
ok(['totp_secret', 'totp_enabled', 'totp_pending', 'enroll_deadline', 'token_version'].every((c) => cols.includes(c)), 'migrateSecurity thêm cột vào users của app');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
ok(['passkeys', 'control_sessions', 'device_requests', 'known_devices', 'pair_codes', 'stations', 'recovery_codes', 'audit_log'].every((t) => tables.includes(t)), 'đủ bảng của lõi');
const mk = (name, role = 'staff') => Number(db.prepare('INSERT INTO users (username, role) VALUES (?, ?)').run(name, role).lastInsertRowid);

/* ---- app đồ chơi: một route "mở két" được bảo vệ bằng step-up của lõi ---- */
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const requireAuth = (req, res, next) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.headers['x-uid']));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user; req.tokenPayload = { iat: Math.floor(Date.now() / 1000) };
  next();
};
const sec = S.mountSecurityRoutes(app, {
  db, requireAuth, adminOnly: [requireAuth], loginPayload: (u) => ({ token: `t${u.id}` }), authStrict: (_q, _r, n) => n(),
  extraStatus: () => ({ toy: true }),
});
app.post('/toy/open-safe', requireAuth, (req, res) => {
  const es = S.enrollState(db, req.user);
  if (es.locked) return res.status(403).json({ error: 'enroll_required' });
  const a = sec.authorize(req);
  if (a.error) return res.status(a.status).json(a);
  res.json({ ok: true, via: a.via });
});
app.post('/toy/rename', requireAuth, sec.reauth, (req, res) => res.json({ ok: true, reauthed: req.reauthed }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, url, uid, body, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-uid': String(uid), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const alice = mk('alice'); const visitor = mk('visitor', 'guest');
let r = await call('POST', '/toy/open-safe', alice, {});
ok(r.status === 401 && r.body.reason === 'no_factor', 'route của app đồ chơi: chưa có yếu tố → bị chặn');
r = await call('GET', '/api/control/status', alice);
ok(r.status === 200 && r.body.toy === true && r.body.enroll.needed === true, 'status trộn trường riêng của app (extraStatus) và canControl do app quyết');
r = await call('GET', '/api/control/status', visitor);
ok(r.body.enroll.needed === false, 'canControl của app: vai trò guest không bị ép bật yếu tố');

// TOTP: bật yếu tố đầu tiên + mã khôi phục + thông báo qua adapter
r = await call('POST', '/api/control/totp/setup', alice, {});
const secret = r.body.secret;
r = await call('POST', '/api/control/totp/enable', alice, { code: S.hotp(secret, S.stepOf()) });
ok(r.status === 200 && r.body.controlToken && r.body.recoveryCodes?.length === 10, 'bật TOTP: phiên điều khiển + 10 mã khôi phục');
ok(notes.some((n) => n.user === alice), 'notify do adapter của app nhận cảnh báo');
const tok = r.body.controlToken;
r = await call('POST', '/toy/open-safe', alice, {}, { 'x-control-token': tok });
ok(r.status === 200 && r.body.via === 'totp', 'có phiên điều khiển: route của app chạy');
r = await call('POST', '/toy/rename', alice, {});
ok(r.status === 401 && r.body.error === 'step_up_required', 'reauth dùng lại được cho thao tác nhạy cảm của app');
r = await call('POST', '/toy/rename', alice, {}, { 'x-control-token': tok });
ok(r.status === 200 && r.body.reauthed === true, '… và qua được khi đã xác nhận');

// Hồi quy: vòng poll của máy mới (3 giây/lần) dùng hạn mức riêng, không chặn mở khoá của chính người dùng
const dev = (await call('POST', '/api/devices/request', alice, { label: 'Máy mới' }, { 'x-device-id': 'toy-device-aaaaaaaaaaaa' })).body;
let polls429 = 0;
for (let i = 0; i < 20; i++) {
  const pr = await call('POST', `/api/devices/requests/${dev.id}/poll`, alice, { pollToken: dev.pollToken });
  if (pr.status === 429) polls429++;
}
ok(polls429 === 0, 'poll thiết bị mới 20 lần liên tiếp không bị 429');
r = await call('POST', '/api/control/unlock', alice, { code: S.hotp(secret, S.stepOf() + 1) });
ok(r.status === 200, 'ngay sau đó người dùng vẫn mở khoá được (hạn mức không bị poll ăn mất)');

// Khoá điều khiển khi quá hạn
const bob = mk('bob');
db.prepare('UPDATE users SET enroll_deadline = ? WHERE id = ?').run(Date.now() - 1000, bob);
r = await call('POST', '/toy/open-safe', bob, {});
ok(r.status === 403 && r.body.error === 'enroll_required', 'quá hạn bật yếu tố → khoá');

// Lõi: các hàm thuần
ok(S.netOf('10.1.2.3') === '10.1.2' && S.ipInCidrs('192.168.5.9', ['192.168.0.0/16']), 'net helpers');
ok(S.clientIp({ headers: { 'cf-connecting-ip': '1.2.3.4' }, socket: { remoteAddress: '203.0.113.9' } }) === '203.0.113.9', 'clientIp không tin header từ nguồn lạ');
const codes = S.generateRecoveryCodes(db, alice);
ok(S.tryRecoveryCode(db, { id: alice }, codes[0], '1.1.1.1') === 'ok' && S.tryRecoveryCode(db, { id: alice }, codes[0], '1.1.1.1') === 'invalid', 'mã khôi phục dùng một lần');
ok(S.openSecret(S.sealSecret('abc')) === 'abc', 'seal/open TOTP dùng khoá dẫn xuất từ secret của app');
const sealedUnderToy = S.sealSecret('abc');
S.configure({ secret: () => 'khac-hoan-toan-khac-hoan-toan' });
ok(S.openSecret(sealedUnderToy) === null, 'đổi secret của app → dữ liệu mã hoá cũ không mở được (khoá dẫn xuất từ secret app)');

// bản sao client trong webapp phải khớp client của gói
const { spawnSync } = await import('child_process');
const chk = spawnSync(process.execPath, [path.join(here, '..', 'scripts', 'sync-client.js'), '--check'], { encoding: 'utf8' });
ok(chk.status === 0, 'client trong webapp/security khớp packages/security/client' + (chk.status ? ' — ' + chk.stderr.trim() : ''));

server.close();
console.log(fails ? `\n${fails} test hỏng` : '\nTất cả đạt');
process.exit(fails ? 1 : 0);
