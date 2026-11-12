/**
 * Smoke: ADMIN_INTERNET_USERS — trang + API admin từ Internet CHỈ cho tài khoản được chỉ định (đã đăng nhập).
 * "Từ Internet" mô phỏng bằng header CF-Connecting-IP (đường hầm SSH thì không có header này).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import {
  configure, migrateSecurity, createSessionAuth, createAppSession, signToken, hashPassword,
} from '@plciot/security';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, '..'));
process.env.APP_JWT_SECRET = 'admin-internet-smoke-16c';
process.env.ADMIN_ONLY_CIDRS = '127.0.0.1/32';
let failed = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failed++; };

const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adm-int-')), 't.db'));
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT NOT NULL DEFAULT 'x',
  login_password_hash TEXT, folder_path TEXT NOT NULL DEFAULT 'f', disabled INTEGER DEFAULT 0, setup_complete INTEGER DEFAULT 1,
  token_version INTEGER DEFAULT 0, role TEXT DEFAULT 'operator');`);
migrateSecurity(db);
configure({ secret: () => process.env.APP_JWT_SECRET });
const { adminLocalOnly, adminInternetGuard, requireAdminNetwork } = await import('../src/adminGate.js');

const mk = (name, role = 'admin') => {
  const id = db.prepare('INSERT INTO users (username, login_password_hash, role) VALUES (?,?,?)').run(name, hashPassword('x'), role).lastInsertRowid;
  return signToken({ uid: id, tv: 0, sid: createAppSession(db, id, 't') }, process.env.APP_JWT_SECRET);
};
const han = mk('nguyenduchan'); const other = mk('quantri2'); const plain = mk('nguoidung', 'operator');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
const requireAuth = createSessionAuth(db, process.env.APP_JWT_SECRET);
app.use(adminLocalOnly);
app.use(adminInternetGuard((req, res, next) => requireAuth(req, res, next)));
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden' }));
app.get('/admin.html', (_q, res) => res.send('ADMIN PAGE'));
app.get('/api/admin/ping', requireAuth, requireAdmin, (_q, res) => res.json({ pong: true }));
app.post('/api/admin/write', requireAuth, requireAdmin, requireAdminNetwork, (_q, res) => res.json({ wrote: true }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, internet) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(internet ? { 'cf-connecting-ip': '8.8.8.8' } : {}) }, body: method === 'POST' ? '{}' : undefined });
  return r.status;
};

// --- chưa cấu hình ADMIN_INTERNET_USERS: Internet bị chặn hoàn toàn (như cũ)
delete process.env.ADMIN_INTERNET_USERS;
ok(await call('GET', '/admin.html', null, true) === 404, 'không cấu hình: /admin.html từ Internet → 404');
ok(await call('GET', '/api/admin/ping', han, true) === 404, 'không cấu hình: API admin từ Internet → 404 (kể cả nguyenduchan)');
ok(await call('GET', '/api/admin/ping', other, false) === 200, 'đường hầm SSH/nội bộ vẫn vào bình thường');

// --- chỉ nguyenduchan
process.env.ADMIN_INTERNET_USERS = 'nguyenduchan';
ok(await call('GET', '/admin.html', null, true) === 200, 'trang admin.html tải được từ Internet (chỉ là HTML)');
ok(await call('GET', '/api/admin/ping', null, true) === 401, 'Internet, chưa đăng nhập → 401');
ok(await call('GET', '/api/admin/ping', other, true) === 404, 'Internet, admin KHÁC → 404');
ok(await call('GET', '/api/admin/ping', plain, true) === 404, 'Internet, user thường → 404');
ok(await call('GET', '/api/admin/ping', han, true) === 200, 'Internet, nguyenduchan → 200');
ok(await call('POST', '/api/admin/write', han, true) === 200, 'nguyenduchan ghi qua Internet vượt requireAdminNetwork');
ok(await call('POST', '/api/admin/write', other, true) === 404, 'admin khác không ghi được từ Internet');
ok(await call('GET', '/api/admin/ping', other, false) === 200, 'admin khác vẫn vào được qua SSH (không đổi)');
process.env.ADMIN_INTERNET_USERS = 'NguyenDucHan, khac';
ok(await call('GET', '/api/admin/ping', han, true) === 200, 'tên không phân biệt hoa/thường, nhiều tên cách nhau dấu phẩy');
server.close();
console.log(failed ? `\n${failed} FAILED` : '\nsmoke-admin-internet: all ok');
process.exit(failed ? 1 : 0);
