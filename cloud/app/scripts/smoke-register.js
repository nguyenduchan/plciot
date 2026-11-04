#!/usr/bin/env node
/**
 * Smoke: đăng ký tự phục vụ 3 bước (username → sinh trắc → mật khẩu) → hoàn tất → mã khôi phục.
 * Chạy server thật trên cổng ngẫu nhiên. Sinh trắc (WebAuthn) cần thiết bị thật nên ở đây đi nhánh máy không có sinh trắc.
 * Chạy: node scripts/smoke-register.js
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plciot-register-'));
const socket = net.createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const shell = fileURLToPath(new URL('../../../webapp', import.meta.url));
const publisher = new URL('../src/controlPublisher.js', import.meta.url).href;
const server = new URL('../src/server.js', import.meta.url).href;
const bootstrap = `const publisher = await import(${JSON.stringify(publisher)}); publisher.setPublisher(async () => {}); await import(${JSON.stringify(server)});`;
const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
  env: {
    ...process.env,
    PORT: String(port), DATA_DIR: path.join(tmp, 'data'), MQTT_CONFIG_DIR: path.join(tmp, 'mqtt'),
    SHELL_DIR: shell, WEBAPP_SRC: shell, WEBAPP_PUBLIC_URL: base,
    APP_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    MQTT_INGEST: 'false', ADMIN_USERNAMES: '', BUNDLE_AUTOSYNC: 'true', REGISTRATION_OPEN: 'true',
    RATE_LIMIT_AUTH: '200', RATE_LIMIT_REGISTER: '200', RATE_LIMIT_SENSITIVE: '200',
  },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = '';
let errors = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (t) => { output += t; });
child.stderr.on('data', (t) => { errors += t; });

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log('ok', msg); else { failed++; console.error('FAIL', msg); } };

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 20000);
    const ready = () => { if (output.includes('plciot app listening on')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', ready);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${errors}`)); });
    ready();
  });

  const DEVICE = 'smoke-register-device-0001';
  const post = async (route, body, headers = {}) => {
    const r = await fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const cfg = await (await fetch(`${base}/api/auth/config`)).json();
  const consent = { consent: true, privacyVersion: cfg.privacyVersion };
  const USER = 'nhamay_an';
  const PASS = 'MatKhau-Manh-123';

  // --- Giao diện: hai tab + bước 1 đăng ký (chỉ username, không ô mật khẩu/OTP/email) ---
  const html = await (await fetch(`${base}/login.html`)).text();
  for (const id of ['tab-login', 'tab-register', 'pane-login', 'pane-register', 'reg-username', 'btn-register']) {
    ok(html.includes(`id="${id}"`), `login.html có #${id}`);
  }
  ok(!html.includes('id="reg-password"') && !/otp|email/i.test(html.slice(html.indexOf('id="pane-register"'), html.indexOf('id="progress"'))), 'tab đăng ký không có mật khẩu/OTP/email ở bước 1');

  // --- Bước 1: validate ---
  ok((await post('/api/register', { username: 'ab', ...consent })).body.error === 'username_invalid', 'username quá ngắn bị từ chối');
  ok((await post('/api/register', { username: 'Bad Name', ...consent })).body.error === 'username_invalid', 'username có khoảng trắng bị từ chối');
  ok((await post('/api/register', { username: 'u_0123456789abcdef', ...consent })).body.error === 'username_invalid', 'tên dạng tự sinh u_<hex16> bị từ chối');
  ok((await post('/api/register', { username: USER })).body.error === 'privacy_consent_required', 'thiếu đồng ý bảo vệ dữ liệu bị từ chối');

  // --- Bước 1: tạo phiên chờ ---
  const reg = await post('/api/register', { username: USER.toUpperCase(), ...consent });
  ok(reg.status === 200 && reg.body.pending === true && reg.body.token, 'bước 1: tạo phiên chờ');
  ok(reg.body.username === USER, 'username chuẩn hoá về chữ thường');
  ok(reg.body.isNew === true && reg.body.methods?.password === false && reg.body.methods?.passkey === false, 'tài khoản mới: chưa có mật khẩu, chưa có passkey');
  const auth = { Authorization: `Bearer ${reg.body.token}` };

  // Cùng máy làm lại ngay được (huỷ giữa chừng); máy khác thì tên đang bị giữ
  const other = await post('/api/register', { username: USER, ...consent }, { 'X-Device-Id': 'smoke-register-device-OTHER' });
  ok(other.status === 409 && other.body.error === 'username_taken', 'máy khác không chiếm được tên đang đăng ký dở');
  const redo = await post('/api/register', { username: USER, ...consent });
  ok(redo.status === 200 && redo.body.token, 'cùng máy đăng ký lại được sau khi huỷ giữa chừng');
  const auth2 = { Authorization: `Bearer ${redo.body.token}` };

  // --- Tài khoản chưa hoàn tất không đăng nhập / khôi phục được ---
  const pw0 = await post('/api/login/password', { username: USER, password: PASS });
  ok(pw0.status === 401 && pw0.body.error === 'password_invalid', 'chưa hoàn tất: không đăng nhập bằng mật khẩu');
  const rec = await post('/api/login/recover', { username: USER, password: PASS, recoveryCode: 'AAAA-BBBB' });
  ok(rec.status === 401 && rec.body.error === 'recover_invalid', 'chưa hoàn tất: không khôi phục được');

  // --- Bước 2/3: xin tuỳ chọn đăng ký sinh trắc trên phiên chờ (chứng minh thiết bị như client thật) ---
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = ec.publicKey.export({ format: 'jwk' });
  const proofFor = (subject, action) => {
    const deviceProof = { timestamp: Date.now(), nonce: crypto.randomBytes(24).toString('base64url') };
    const msg = Buffer.from(JSON.stringify([String(subject), DEVICE, action, deviceProof.timestamp, deviceProof.nonce]));
    deviceProof.signature = crypto.sign('sha256', msg, { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, deviceProof };
  };
  const optPath = '/api/webauthn/register/options';
  const opts = await post(optPath, proofFor(redo.body.userId, optPath), auth2);
  ok(opts.status === 200 && opts.body.challenge && opts.body.user, `xin tuỳ chọn đăng ký sinh trắc trên phiên chờ (${opts.status} ${opts.body.error || ''})`);

  // --- Hoàn tất khi chưa đặt mật khẩu bị chặn ---
  const early = await post('/api/login/complete-basic', { password: PASS }, auth2);
  ok(early.status === 401, 'chưa đặt mật khẩu thì chưa hoàn tất được');

  // --- Bước cuối: đặt mật khẩu (yếu / chứa username bị từ chối) rồi hoàn tất ---
  ok((await post('/api/account/password', { password: 'short' }, auth2)).body.error === 'password_weak', 'mật khẩu ngắn bị từ chối');
  ok((await post('/api/account/password', { password: `xx${USER}xxxx` }, auth2)).body.error === 'password_weak', 'mật khẩu chứa username bị từ chối');
  const setPw = await post('/api/account/password', { password: PASS }, auth2);
  ok(setPw.status === 200 && setPw.body.ok, 'đặt mật khẩu trên phiên chờ');
  const bio = await post('/api/login/complete-basic', { password: PASS, bioCapable: true, bioOptOut: true }, auth2);
  ok(bio.body.error === 'biometric_required', 'máy hỗ trợ sinh trắc: không được bỏ qua khi đăng ký');
  const done = await post('/api/login/complete-basic', { password: PASS }, auth2);
  ok(done.status === 200 && done.body.token && done.body.username === USER, 'hoàn tất đăng ký → vào app');
  ok(Array.isArray(done.body.recoveryCodes) && done.body.recoveryCodes.length >= 1, 'trả về mã khôi phục để người dùng lưu');

  // --- Sau khi hoàn tất ---
  const again = await post('/api/register', { username: USER, ...consent });
  ok(again.status === 409 && again.body.error === 'username_taken', 'tên đã hoàn tất không đăng ký lại được');
  ok(cfg.registrationOpen === true, '/api/auth/config báo registrationOpen');
} catch (ex) {
  failed++;
  console.error('FAIL', ex?.message || ex, errors.slice(-600));
} finally {
  child.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
if (failed) { console.error(`smoke-register: ${failed} failed`); process.exit(1); }
console.log('smoke-register: all passed');
