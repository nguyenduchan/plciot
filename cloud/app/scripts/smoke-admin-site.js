/**
 * Smoke test trang admin riêng: chạy server tách biệt (DATA_DIR tạm, cổng 3099) rồi gọi HTTP với header Host.
 *   docker exec plciot-app node scripts/smoke-admin-site.js
 * Không đụng DB thật.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const PORT = 3099;
const ADMIN = 'admin.test.local';
const APP = 'app.test.local';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adminsite-'));
const env = {
  PATH: process.env.PATH, PORT: String(PORT), DATA_DIR: dir, SHELL_DIR: process.env.SHELL_DIR || '/app/shell',
  APP_JWT_SECRET: 'x'.repeat(40), ADMIN_HOST: ADMIN, ADMIN_USERNAMES: 'boss', ADMIN_DASHBOARD_USERS: 'boss',
  ADMIN_ONLY_CIDRS: '127.0.0.1/32', ADMIN_INTERNET_USERS: 'boss', ADMIN_REQUIRE_TOTP: 'true',
  WEBAPP_PUBLIC_URL: `https://${APP}`, MQTT_SHARDS: '1', NODE_ENV: 'test',
};

function req(host, method, url, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: {
      Host: host, 'CF-Connecting-IP': '9.9.9.9', 'X-Forwarded-For': '9.9.9.9',
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* html */ } resolve({ status: res.statusCode, j }); }); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`); };

const child = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const stop = () => { child.kill('SIGTERM'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };

try {
  for (let i = 0; i < 50 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 200));
  if (!log.includes('listening')) throw new Error('server không khởi động:\n' + log);

  const db = new Database(path.join(dir, 'app.db'));
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const row = { username: 'boss', role: 'admin', login_password_hash: bcrypt.hashSync('Correct-horse-1', 10), setup_complete: 1, disabled: 0 };
  const have = db.prepare('SELECT id FROM users WHERE username = ?').get('boss');
  if (!have) {
    const need = db.prepare('PRAGMA table_info(users)').all().filter((c) => c.notnull && c.dflt_value == null && c.name !== 'id').map((c) => c.name);
    for (const n of need) if (!(n in row)) row[n] = n.includes('folder') ? 'u_boss' : 'x';
    const ks = Object.keys(row).filter((k) => cols.includes(k));
    db.prepare(`INSERT INTO users (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...ks.map((k) => row[k]));
  } else db.prepare('UPDATE users SET login_password_hash = ?, role = ? WHERE username = ?').run(row.login_password_hash, 'admin', 'boss');
  db.prepare("INSERT OR IGNORE INTO users (username, role, login_password_hash, setup_complete, folder_path, notify_site, notify_device) VALUES ('other','admin',?,1,'u_other','s','d')").run(row.login_password_hash);

  // 1) cổng theo tên miền
  check('admin host: trang đăng nhập', (await req(ADMIN, 'GET', '/admin-login.html')).status === 200);
  check('admin host: không phục vụ login.html của app', (await req(ADMIN, 'GET', '/login.html')).status === 404);
  check('app host: không phục vụ admin.html', (await req(APP, 'GET', '/admin.html')).status === 404);
  check('app host: không có /api/admin/users', (await req(APP, 'GET', '/api/admin/users')).status === 404);
  check('app host: không có API đăng nhập admin', (await req(APP, 'POST', '/api/admin-site/login', {})).status === 404);
  check('admin host: /api/admin cần đăng nhập', (await req(ADMIN, 'GET', '/api/admin/users')).status === 401);

  // 2) đăng nhập
  const bad = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'sai' });
  check('sai mật khẩu → 401', bad.status === 401 && bad.j?.error === 'invalid_credentials');
  const other = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'other', password: 'Correct-horse-1' });
  check('tài khoản không phải admin cao nhất bị từ chối', other.status === 401 && other.j?.error === 'invalid_credentials');
  const first = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'Correct-horse-1' });
  check('đúng mật khẩu, chưa có TOTP → bắt đăng ký', first.status === 200 && first.j?.setupRequired && first.j?.ticket);
  check('vé không dùng làm token được', (await req(ADMIN, 'GET', '/api/admin/users', null, first.j?.ticket)).status === 401);

  // 3) đăng ký TOTP + vào phiên
  const { hotp, stepOf, base32Decode } = await import('@plciot/security').then((m) => ({ hotp: m.hotp, stepOf: m.stepOf, base32Decode: m.base32Decode }));
  void base32Decode;
  const setup = await req(ADMIN, 'POST', '/api/admin-site/totp/setup', { ticket: first.j.ticket });
  check('lấy khoá TOTP', setup.status === 200 && setup.j?.secret);
  const wrong = await req(ADMIN, 'POST', '/api/admin-site/totp/enable', { ticket: first.j.ticket, code: '000000' });
  check('mã TOTP sai bị từ chối', wrong.status === 401);
  const step = stepOf();
  const en = await req(ADMIN, 'POST', '/api/admin-site/totp/enable', { ticket: first.j.ticket, code: hotp(setup.j.secret, step) });
  check('bật TOTP → có token', en.status === 200 && en.j?.token);
  const token = en.j?.token;
  check('token vào được /api/admin/users', (await req(ADMIN, 'GET', '/api/admin/users', null, token)).status === 200);
  const me = await req(ADMIN, 'GET', '/api/admin-site/me', null, token);
  check('trang cài đặt: /me', me.status === 200 && me.j?.totpEnabled === true && me.j.sessions?.length >= 1);

  // 4) đăng nhập lần sau: cần mã, mã đã dùng bị từ chối (chống phát lại)
  const need = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'Correct-horse-1' });
  check('lần sau cần mã TOTP', need.status === 401 && need.j?.error === 'totp_required');
  const replay = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'Correct-horse-1', code: hotp(setup.j.secret, step) });
  check('mã vừa dùng không dùng lại được', replay.status === 401 && replay.j?.error === 'totp_invalid');
  const ok2 = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'Correct-horse-1', code: hotp(setup.j.secret, step + 1) });
  check('mã bước kế tiếp được chấp nhận', ok2.status === 200 && ok2.j?.token);

  // 5) cài đặt
  db.prepare("UPDATE users SET totp_last_step = 0 WHERE username = 'boss'").run();   // test không chờ 30 giây
  const weak = await req(ADMIN, 'POST', '/api/admin-site/password', { current: 'Correct-horse-1', code: hotp(setup.j.secret, step), next: 'short' }, token);
  check('mật khẩu yếu bị từ chối', weak.status === 400 && weak.j?.error === 'password_weak');
  db.prepare("UPDATE users SET totp_last_step = 0 WHERE username = 'boss'").run();
  const chg = await req(ADMIN, 'POST', '/api/admin-site/password', { current: 'Correct-horse-1', code: hotp(setup.j.secret, step), next: 'New-Strong-Pass-9' }, token);
  check('đổi mật khẩu thành công', chg.status === 200 && chg.j?.ok);
  db.prepare("UPDATE users SET totp_last_step = 0 WHERE username = 'boss'").run();
  const relog = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'New-Strong-Pass-9', code: hotp(setup.j.secret, step) });
  check('đăng nhập bằng mật khẩu mới', relog.status === 200 && relog.j?.token);
  const rv = await req(ADMIN, 'POST', '/api/admin-site/sessions/revoke-others', {}, token);
  check('đăng xuất máy khác', rv.status === 200 && rv.j?.revoked >= 1);
  check('phiên cũ (ok2) bị thu hồi', (await req(ADMIN, 'GET', '/api/admin/users', null, ok2.j.token)).status === 401);

  // 6) token app thường không dùng được ở tên miền admin
  const plain = db.prepare("SELECT id, token_version FROM users WHERE username='boss'").get();
  const { createAppSession, signToken } = await import('@plciot/security');
  void createAppSession; void signToken; void plain; // phiên tạo ngoài admin-site: kiểm bằng cách chèn session device khác
  const sid = 'f'.repeat(48);
  db.prepare('INSERT INTO app_sessions (id, user_id, device_id, last_seen) VALUES (?,?,?,?)').run(sid, plain.id, 'phone-1', Date.now());
  const jwt = (await import('jsonwebtoken')).default.sign({ scope: 'full', uid: plain.id, tv: plain.token_version | 0, sid }, env.APP_JWT_SECRET, { expiresIn: 600 });
  const viaApp = await req(ADMIN, 'GET', '/api/admin/users', null, jwt);
  check('token đăng nhập của app không dùng được ở tên miền admin', viaApp.status === 401 && viaApp.j?.error === 'admin_session_required');
} catch (e) {
  fails++; console.error('LỖI', e.message);
} finally {
  stop();
}
console.log(fails ? `\n${fails} lỗi` : '\nTất cả OK');
process.exit(fails ? 1 : 0);
