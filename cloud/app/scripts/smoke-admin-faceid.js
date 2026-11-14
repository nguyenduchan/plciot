/**
 * Smoke test Face ID (WebAuthn) bắt buộc cho trang admin riêng: server tách (DATA_DIR tạm, cổng 3098), authenticator giả lập.
 *   docker exec plciot-app node scripts/smoke-admin-faceid.js
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const PORT = 3098;
const ADMIN = 'admin.test.local';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adminface-'));
const env = {
  PATH: process.env.PATH, PORT: String(PORT), DATA_DIR: dir, SHELL_DIR: process.env.SHELL_DIR || '/app/shell',
  APP_JWT_SECRET: 'x'.repeat(40), ADMIN_HOST: ADMIN, ADMIN_USERNAMES: 'boss', ADMIN_DASHBOARD_USERS: 'boss',
  ADMIN_ONLY_CIDRS: '127.0.0.1/32', ADMIN_INTERNET_USERS: 'boss', ADMIN_REQUIRE_FACEID: 'true', ADMIN_REQUIRE_TOTP: 'false', RATE_LIMIT_ADMIN_LOGIN: '1000', RATE_LIMIT_ADMIN_LOGIN_USER: '1000',
  WEBAPP_PUBLIC_URL: 'https://app.test.local', MQTT_SHARDS: '1', NODE_ENV: 'test',
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

/* ---- authenticator giả lập ---- */
const cborEnc = (v) => {
  if (v instanceof Map) { const parts = [Buffer.from([0xa0 | v.size])]; for (const [k, val] of v) parts.push(cborEnc(k), cborEnc(val)); return Buffer.concat(parts); }
  if (Buffer.isBuffer(v)) { const h = v.length < 24 ? Buffer.from([0x40 | v.length]) : v.length < 256 ? Buffer.from([0x58, v.length]) : Buffer.from([0x59, v.length >> 8, v.length & 255]); return Buffer.concat([h, v]); }
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([Buffer.from([0x60 | b.length]), b]); }
  if (typeof v === 'number') { if (v >= 0) return v < 24 ? Buffer.from([v]) : Buffer.from([0x18, v]); const n = -1 - v; return n < 24 ? Buffer.from([0x20 | n]) : Buffer.from([0x38, n]); }
  throw new Error('enc');
};
const sha = (b) => crypto.createHash('sha256').update(b).digest();
function device(rpId, origin) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  let counter = 0;
  const cd = (type, challenge, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o }));
  return {
    id: credId.toString('base64url'),
    attest(options, { uv = true, o = origin, rp = rpId } = {}) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha(rp), Buffer.from([0x01 | (uv ? 0x04 : 0) | 0x40]), Buffer.alloc(4), Buffer.alloc(16), idLen, credId, cborEnc(cose)]);
      const att = cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: credId.toString('base64url'), response: { clientDataJSON: cd('webauthn.create', options.challenge, o).toString('base64url'), attestationObject: att.toString('base64url') } };
    },
    assert(options, { key = privateKey, uv = true, rp = rpId } = {}) {
      const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
      const authData = Buffer.concat([sha(rp), Buffer.from([uv ? 0x05 : 0x01]), c]);
      const data = cd('webauthn.get', options.challenge);
      const sig = crypto.sign('sha256', Buffer.concat([authData, sha(data)]), key);
      return { id: credId.toString('base64url'), response: { clientDataJSON: data.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url') } };
    },
  };
}

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
  const need = db.prepare('PRAGMA table_info(users)').all().filter((c) => c.notnull && c.dflt_value == null && c.name !== 'id').map((c) => c.name);
  for (const n of need) if (!(n in row)) row[n] = n.includes('folder') ? 'u_boss' : 'x';
  const ks = Object.keys(row).filter((k) => cols.includes(k));
  if (!db.prepare("SELECT 1 FROM users WHERE username = 'boss'").get()) db.prepare(`INSERT INTO users (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...ks.map((k) => row[k]));
  else db.prepare('UPDATE users SET login_password_hash = ?, role = ? WHERE username = ?').run(row.login_password_hash, 'admin', 'boss');
  db.close();

  const origin = `https://${ADMIN}`;
  const phone = device(ADMIN, origin);
  const login = (password = 'Correct-horse-1') => req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password });

  let r = await req(ADMIN, 'GET', '/api/admin-site/config');
  check('config báo requireFaceId', r.j?.requireFaceId === true);

  r = await login('sai-mat-khau-1');
  check('sai mật khẩu: không cấp vé Face ID', r.status === 401 && !r.j?.ticket);

  // Lần đầu: mật khẩu đúng → phải đăng ký Face ID, KHÔNG có token
  r = await login();
  check('lần đầu: yêu cầu đăng ký Face ID, chưa có token', r.status === 200 && r.j.faceIdSetup === true && r.j.ticket && !r.j.token);
  const setupTicket = r.j.ticket;
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/options', { ticket: setupTicket });
  check('vé đăng ký không dùng được cho bước xác thực', r.status === 401);

  let opt = (await req(ADMIN, 'POST', '/api/admin-site/faceid/register/options', { ticket: setupTicket })).j;
  check('register/options: rpId = tên miền admin, bắt buộc UV', opt.rp?.id === ADMIN && opt.authenticatorSelection?.userVerification === 'required');
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/register/verify', { ticket: setupTicket, credential: phone.attest(opt, { uv: false }) });
  check('đăng ký không có xác thực người dùng: bị từ chối', r.status === 400 && !r.j?.token);
  opt = (await req(ADMIN, 'POST', '/api/admin-site/faceid/register/options', { ticket: setupTicket })).j;
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/register/verify', { ticket: setupTicket, credential: phone.attest(opt, { o: 'https://evil.example' }) });
  check('origin lạ (phishing): bị từ chối', r.status === 400 && !r.j?.token);
  opt = (await req(ADMIN, 'POST', '/api/admin-site/faceid/register/options', { ticket: setupTicket })).j;
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/register/verify', { ticket: setupTicket, credential: phone.attest(opt, { rp: 'plc.example.com' }) });
  check('rpId khác (khoá của tên miền khác): bị từ chối', r.status === 400 && !r.j?.token);
  opt = (await req(ADMIN, 'POST', '/api/admin-site/faceid/register/options', { ticket: setupTicket })).j;
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/register/verify', { ticket: setupTicket, credential: phone.attest(opt), name: 'iPhone' });
  check('đăng ký Face ID đúng: nhận token admin', r.status === 200 && r.j.token, JSON.stringify(r.j));
  const firstToken = r.j.token;
  r = await req(ADMIN, 'GET', '/api/admin-site/me', null, firstToken);
  check('/me thấy 1 Face ID', r.status === 200 && r.j.faceIds?.length === 1 && r.j.requireFaceId === true);

  // Các lần sau: mật khẩu → Face ID (xoá bộ đếm sai để thử riêng từng ca; khoá khi sai nhiều thử ở cuối)
  const clearFails = () => { const d = new Database(path.join(dir, 'app.db')); d.prepare("DELETE FROM audit_log WHERE event = 'admin_login_fail'").run(); d.close(); };
  clearFails();
  r = await login();
  check('lần sau: yêu cầu Face ID, chưa có token', r.j.faceIdRequired === true && r.j.ticket && !r.j.token);
  const authTicket = r.j.ticket;
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/register/options', { ticket: authTicket });
  check('vé xác thực không dùng để đăng ký thêm', r.status === 401);
  const ao = (await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/options', { ticket: authTicket })).j;
  check('auth/options: có allowCredentials, UV bắt buộc', ao.allowCredentials?.length === 1 && ao.userVerification === 'required' && ao.rpId === ADMIN);
  const stranger = device(ADMIN, origin);
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/verify', { ticket: authTicket, credential: stranger.assert(ao) });
  check('khoá lạ chưa đăng ký: bị từ chối', r.status === 400 && !r.j?.token);
  const ao2 = (await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/options', { ticket: authTicket })).j;
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/verify', { ticket: authTicket, credential: phone.assert(ao2, { uv: false }) });
  check('không có xác thực người dùng (UV): bị từ chối', r.status === 401 && !r.j?.token);
  const ao3 = (await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/options', { ticket: authTicket })).j;
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/verify', { ticket: authTicket, credential: phone.assert(ao3, { rp: 'plc.example.com' }) });
  check('rpId sai: bị từ chối', r.status === 401 && !r.j?.token);
  const ao4 = (await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/options', { ticket: authTicket })).j;
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/verify', { ticket: authTicket, credential: phone.assert(ao4) });
  check('Face ID đúng: nhận token admin', r.status === 200 && r.j.token);
  const token2 = r.j.token;
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/verify', { ticket: authTicket, credential: phone.assert(ao4) });
  check('phát lại (challenge đã dùng): bị từ chối', r.status === 401 && !r.j?.token);
  r = await req(ADMIN, 'GET', '/api/admin/users', null, token2);
  check('token sau Face ID gọi được API admin', r.status === 200, JSON.stringify(r.j));

  // Thêm máy khác khi đã đăng nhập
  clearFails();
  const tablet = device(ADMIN, origin);
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/add/options', { password: 'sai' }, token2);
  check('thêm máy: sai mật khẩu bị từ chối', r.status === 401);
  const addOpt = (await req(ADMIN, 'POST', '/api/admin-site/faceid/add/options', { password: 'Correct-horse-1' }, token2)).j;
  check('thêm máy: exclude máy đã có', addOpt.excludeCredentials?.length === 1, JSON.stringify(addOpt));
  r = await req(ADMIN, 'POST', '/api/admin-site/faceid/add/verify', { name: 'iPad', credential: tablet.attest(addOpt) }, token2);
  check('thêm máy thứ hai thành công', r.status === 200);
  r = await req(ADMIN, 'GET', '/api/admin-site/me', null, token2);
  check('/me thấy 2 Face ID', r.j.faceIds?.length === 2);
  const delId = r.j.faceIds[1].id;
  r = await req(ADMIN, 'DELETE', `/api/admin-site/faceid/${delId}`, null, token2);
  check('xoá một máy (còn 1)', r.status === 200);
  r = await req(ADMIN, 'GET', '/api/admin-site/me', null, token2);
  const lastId = r.j.faceIds[0].id;
  r = await req(ADMIN, 'DELETE', `/api/admin-site/faceid/${lastId}`, null, token2);
  check('không xoá được Face ID cuối cùng', r.status === 409 && r.j.error === 'last_faceid');

  // Khoá khi sai nhiều
  for (let i = 0; i < 6; i++) {
    const t = (await login()).j.ticket;
    const o = (await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/options', { ticket: t })).j;
    if (!o.challenge) break;
    await req(ADMIN, 'POST', '/api/admin-site/faceid/auth/verify', { ticket: t, credential: stranger.assert(o) });
  }
  r = await login();
  check('sai Face ID nhiều lần: tài khoản bị khoá tạm', r.status === 429 && r.j.error === 'locked', JSON.stringify(r.j));
} catch (e) {
  fails++;
  console.error('LỖI', e.message);
  console.error(log.split('\n').slice(-15).join('\n'));
} finally { stop(); }

console.log(fails ? `${fails} lỗi` : 'Tất cả OK');
process.exit(fails ? 1 : 0);
