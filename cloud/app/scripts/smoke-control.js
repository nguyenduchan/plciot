#!/usr/bin/env node
/** Offline smoke test: TOTP, Passkey (authenticator giả lập), phiên điều khiển, PC trạm, nút vật lý, whitelist lệnh. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-ctl-'));
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.WEBAPP_PUBLIC_URL = 'https://plc.example.com';
process.env.CONTROL_LAN_CIDRS = '203.0.113.0/24';
process.env.CONTROL_PHYSICAL_BIT = '5';
process.env.CONTROL_PHYSICAL_WAIT_SEC = '5';
process.env.RATE_LIMIT_CONTROL_AUTH = '1000';
process.env.RATE_LIMIT_CONTROL_CMD = '1000';

const { openDb } = await import('../src/db.js');
const T = await import('@plciot/security');
const { setPublisher } = await import('../src/controlPublisher.js');
const { mountSecurityRoutes } = await import('@plciot/security');
const { mountPlcControl } = await import('../src/plcControlRoutes.js');
// ghép lõi bảo mật + phần điều khiển PLC như server.js
const mountControl = (app, ctx) => { const sec = mountSecurityRoutes(app, ctx); mountPlcControl(app, { db: ctx.db, requireAuth: ctx.requireAuth, security: sec }); return sec; };
const { noteTelemetry } = await import('../src/plcProof.js');
const CA = await import('@plciot/security');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

/* ---- TOTP: vector RFC 6238 (SHA-1, bí mật "12345678901234567890") ---- */
const rfcSecret = T.base32Encode(Buffer.from('12345678901234567890'));
ok(T.hotp(rfcSecret, Math.floor(59 / 30)) === '287082', 'TOTP khớp vector RFC 6238 (t=59)');
ok(T.verifyTotp(rfcSecret, '287082', { now: 59_000 }) === 1, 'verifyTotp chấp nhận mã đúng');
ok(T.verifyTotp(rfcSecret, '287082', { now: 59_000, lastStep: 1 }) === null, 'mã đã dùng bị từ chối (phát lại)');
ok(T.verifyTotp(rfcSecret, '287082', { now: 59_000 + 300_000 }) === null, 'mã quá hạn bị từ chối');
ok(T.openSecret(T.sealSecret('ABC')) === 'ABC' && T.openSecret('v1.xxxx') === null, 'mã hoá/giải mã bí mật TOTP');
ok(CA.netOf('10.1.2.3') === '10.1.2' && CA.netOf('2001:db8:1:2:aaaa::1') === '2001:0db8:0001:0002', 'netOf v4 /24, v6 /64');
ok(CA.ipInCidrs('203.0.113.77', ['203.0.113.0/24']) && !CA.ipInCidrs('203.0.114.1', ['203.0.113.0/24']), 'CIDR IPv4');

/* ---- App thử ---- */
const db = openDb(tmp);
const mkUser = (name, role = 'operator') => {
  const info = db.prepare(`INSERT INTO users (username, password_hash, folder_path, phone, role, notify_site, notify_device)
    VALUES (?, 'x', 'f', ?, ?, 'siteA', 'plc01')`).run(name, name, role);
  return Number(info.lastInsertRowid);
};
const uOp = mkUser('84900000010'); const uViewer = mkUser('84900000011', 'viewer'); const uAdmin = mkUser('84900000012', 'admin');
const uTotp = mkUser('84900000013');

const published = [];
setPublisher(async (site, device, cmd) => { published.push({ site, device, cmd }); });

const app = express();
app.use(express.json());
let ipOverride = '198.51.100.7';
const requireAuth = (req, res, next) => {
  const uid = Number(req.headers['x-uid']);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  req.tokenPayload = { iat: Math.floor(Date.now() / 1000) - Number(req.headers['x-age'] || 0) };
  next();
};
const adminOnly = [requireAuth, (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden' }))];
app.use((req, _res, next) => { req.headers['cf-connecting-ip'] = ipOverride; next(); });
const loginPayload = (u) => ({ token: `jwt-${u.id}`, userId: u.id, username: u.username });
const { reauth } = mountControl(app, { db, requireAuth, adminOnly, loginPayload, authStrict: (_q, _r, n) => n() });
app.post('/t/sensitive', requireAuth, reauth, (req, res) => res.json({ ok: true, reauthed: req.reauthed }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, uid, body, headers = {}) {
  const r = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', 'x-uid': String(uid), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const cmd = (uid, body, h) => call('POST', '/api/control/cmd', uid, body, h);

/* ---- Chưa có yếu tố nào ---- */
let r = await cmd(uOp, { a: 6, v: 1 });
ok(r.status === 401 && r.body.error === 'step_up_required' && r.body.reason === 'no_factor', 'chưa đăng ký yếu tố: bị chặn (no_factor)');
r = await cmd(uViewer, { a: 6, v: 1 });
ok(r.status === 403, 'viewer không được điều khiển');
r = await cmd(uOp, { a: 99, v: 1 });
ok(r.status === 400, 'thanh ghi ngoài whitelist bị từ chối');
r = await cmd(uOp, { a: 7, v: 70000 });
ok(r.status === 400, 'giá trị ngoài 16 bit bị từ chối');
ok(published.length === 0, 'chưa có lệnh nào lọt ra MQTT');

/* ---- Đọc không cần step-up ---- */
r = await cmd(uOp, { op: 'read', a: 100, n: 4 });
ok(r.status === 200 && published.at(-1).cmd.op === 'read', 'lệnh đọc không cần step-up');

/* ---- TOTP ---- */
r = await call('POST', '/api/control/totp/setup', uOp, {}, { 'x-age': '3600' });
ok(r.status === 401 && r.body.error === 'reauth_required', 'đăng ký yếu tố đầu khi đăng nhập đã cũ: yêu cầu đăng nhập lại');
r = await call('POST', '/api/control/totp/setup', uOp, {});
ok(r.status === 200 && r.body.secret && r.body.uri.startsWith('otpauth://totp/'), 'setup TOTP trả secret + otpauth');
const secret = r.body.secret;
r = await call('POST', '/api/control/totp/enable', uOp, { code: '000000' });
ok(r.status === 401 && r.body.error === 'totp_invalid', 'bật TOTP với mã sai bị từ chối');
let step = T.stepOf();
let code = T.hotp(secret, step);
r = await call('POST', '/api/control/totp/enable', uOp, { code });
ok(r.status === 200 && r.body.controlToken, 'bật TOTP bằng mã đúng, nhận luôn phiên điều khiển');
ok(Array.isArray(r.body.recoveryCodes) && r.body.recoveryCodes.length === 10, 'bật yếu tố đầu tiên: tự tạo 10 mã khôi phục');
const tokTotp = r.body.controlToken;

r = await cmd(uOp, { a: 6, v: 1 });
ok(r.status === 401 && r.body.reason === 'no_token', 'có yếu tố nhưng không kèm token: bị chặn');
r = await cmd(uOp, { id: 'abc1', a: 7, v: 50 }, { 'x-control-token': tokTotp });
ok(r.status === 200 && r.body.via === 'totp' && published.at(-1).cmd.v === 50 && published.at(-1).site === 'siteA', 'có phiên TOTP: lệnh được phát tới đúng site/device');
ok(published.at(-1).cmd.id === 'abc1', 'giữ id của client để khớp ack');

r = await cmd(uOp, { a: 7, v: 51 }, { 'x-control-token': tokTotp });
ipOverride = '198.51.100.250'; // cùng /24
r = await cmd(uOp, { a: 7, v: 52 }, { 'x-control-token': tokTotp });
ok(r.status === 200, 'đổi IP trong cùng /24: phiên vẫn dùng được');
ipOverride = '192.0.2.9';
r = await cmd(uOp, { a: 7, v: 53 }, { 'x-control-token': tokTotp });
ok(r.status === 401 && r.body.reason === 'network_changed', 'đổi sang mạng khác: hỏi lại mã');
// mã step kế tiếp (nằm trong cửa sổ ±1) → mở khoá được ở mạng mới
r = await call('POST', '/api/control/unlock', uOp, { code: T.hotp(secret, step + 1) });
ok(r.status === 200 && r.body.controlToken, 'unlock ở mạng mới bằng mã mới → cấp phiên mới');
const tokNet2 = r.body.controlToken;
r = await cmd(uOp, { a: 7, v: 54 }, { 'x-control-token': tokNet2 });
ok(r.status === 200, 'phiên mới dùng được ở mạng mới');
r = await call('POST', '/api/control/unlock', uOp, { code: T.hotp(secret, step + 1) });
ok(r.status === 401 && r.body.error === 'totp_invalid', 'mã TOTP đã dùng không dùng lại được');
ipOverride = '198.51.100.7';

// khoá sau 5 lần sai
for (let i = 0; i < 5; i++) await call('POST', '/api/control/unlock', uOp, { code: '111111' });
r = await call('POST', '/api/control/unlock', uOp, { code: T.hotp(secret, step + 1) });
ok(r.status === 429 && r.body.error === 'totp_locked', 'sai 5 lần: khoá thử mã');

/* ---- Token của user khác không dùng được ---- */
r = await cmd(uAdmin, { a: 7, v: 1 }, { 'x-control-token': tokTotp });
ok(r.status === 401, 'token điều khiển của người khác bị từ chối');

/* ---- Passkey (authenticator giả lập) ---- */
const cborEnc = (v) => {
  if (v instanceof Map) {
    const parts = [Buffer.from([0xa0 | v.size])];
    for (const [k, val] of v) parts.push(cborEnc(k), cborEnc(val));
    return Buffer.concat(parts);
  }
  if (Buffer.isBuffer(v)) {
    const h = v.length < 24 ? Buffer.from([0x40 | v.length]) : v.length < 256 ? Buffer.from([0x58, v.length]) : Buffer.from([0x59, v.length >> 8, v.length & 255]);
    return Buffer.concat([h, v]);
  }
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([Buffer.from([0x60 | b.length]), b]); }
  if (typeof v === 'number') {
    if (v >= 0) return v < 24 ? Buffer.from([v]) : Buffer.from([0x18, v]);
    const n = -1 - v; return n < 24 ? Buffer.from([0x20 | n]) : Buffer.from([0x38, n]);
  }
  throw new Error('enc');
};
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const origin = 'https://plc.example.com';
const rpHash = sha('plc.example.com');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const credId = crypto.randomBytes(16);
let counter = 0;
const clientData = (type, challenge, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o }));

function attestation(options, { uv = true, o = origin } = {}) {
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
  const cnt = Buffer.alloc(4);
  const authData = Buffer.concat([rpHash, Buffer.from([0x01 | (uv ? 0x04 : 0) | 0x40]), cnt, Buffer.alloc(16), idLen, credId, cborEnc(cose)]);
  const att = cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  return {
    id: credId.toString('base64url'),
    response: {
      clientDataJSON: clientData('webauthn.create', options.challenge, o).toString('base64url'),
      attestationObject: att.toString('base64url'),
    },
  };
}
function assertion(options, { sign = privateKey, cnt = ++counter } = {}) {
  const c = Buffer.alloc(4); c.writeUInt32BE(cnt);
  const authData = Buffer.concat([rpHash, Buffer.from([0x05]), c]);
  const cd = clientData('webauthn.get', options.challenge);
  const sig = crypto.sign('sha256', Buffer.concat([authData, sha(cd)]), sign);
  return {
    id: credId.toString('base64url'),
    response: { clientDataJSON: cd.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url') },
  };
}

const uPk = mkUser('84900000014');
let opt = (await call('POST', '/api/webauthn/register/options', uPk, {})).body;
ok(opt.challenge && opt.rp.id === 'plc.example.com' && opt.authenticatorSelection.userVerification === 'required' && opt.attestation === 'none', 'register/options đúng rpId, bắt buộc UV');
r = await call('POST', '/api/webauthn/register/verify', uPk, { credential: attestation(opt, { uv: false }) });
ok(r.status === 400 && /user_verification/.test(r.body.detail), 'đăng ký không có xác thực người dùng bị từ chối');
opt = (await call('POST', '/api/webauthn/register/options', uPk, {})).body;
r = await call('POST', '/api/webauthn/register/verify', uPk, { credential: attestation(opt, { o: 'https://evil.example' }) });
ok(r.status === 400 && /origin/.test(r.body.detail), 'origin lạ (phishing) bị từ chối');
opt = (await call('POST', '/api/webauthn/register/options', uPk, {})).body;
r = await call('POST', '/api/webauthn/register/verify', uPk, { credential: attestation(opt), name: 'iPhone' });
ok(r.status === 200 && r.body.method === 'passkey' && r.body.controlToken, 'đăng ký passkey thành công, nhận phiên');
const pkCodes = r.body.recoveryCodes || [];
ok(pkCodes.length === 10, 'đăng ký passkey đầu tiên: tự tạo mã khôi phục');
r = await call('POST', '/api/webauthn/register/verify', uPk, { credential: attestation(opt) });
ok(r.status >= 400, 'không phát lại được yêu cầu đăng ký đã dùng');

opt = (await call('POST', '/api/webauthn/auth/options', uPk)).body;
ok(opt.allowCredentials.length === 1 && opt.userVerification === 'required', 'auth/options');
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
r = await call('POST', '/api/webauthn/auth/verify', uPk, { credential: assertion(opt, { sign: other }) });
ok(r.status === 401 && /signature/.test(r.body.detail), 'chữ ký sai bị từ chối');
opt = (await call('POST', '/api/webauthn/auth/options', uPk)).body;
r = await call('POST', '/api/webauthn/auth/verify', uPk, { credential: assertion(opt) });
ok(r.status === 200 && r.body.method === 'passkey', 'mở khoá bằng passkey');
const tokPk = r.body.controlToken;
opt = (await call('POST', '/api/webauthn/auth/options', uPk)).body;
r = await call('POST', '/api/webauthn/auth/verify', uPk, { credential: assertion(opt, { cnt: 1 }) });
ok(r.status === 401 && /counter/.test(r.body.detail), 'bộ đếm lùi (khoá bị sao chép) bị từ chối');
r = await cmd(uPk, { a: 4, v: 3 }, { 'x-control-token': tokPk });
ok(r.status === 202 && r.body.pending && r.body.bit === 5, 'lệnh nguy hiểm (D4) chờ nút nhấn vật lý');

/* ---- Nút vật lý ---- */
const cid = r.body.confirmId;
noteTelemetry('siteA', 'plc01', 0); // mốc ban đầu
r = await call('GET', `/api/control/confirm/${cid}`, uPk);
ok(r.status === 200 && r.body.waiting, 'chưa bấm nút: vẫn chờ, chưa phát lệnh');
const before = published.length;
ok(published.at(-1).cmd.a !== 4, 'lệnh D4 chưa ra MQTT');
await new Promise((x) => setTimeout(x, 20));
noteTelemetry('siteA', 'plc01', 1 << 5); // cạnh ở X5
r = await call('GET', `/api/control/confirm/${cid}`, uPk);
ok(r.status === 200 && r.body.sent && published.length === before + 1 && published.at(-1).cmd.a === 4, 'bấm nút X5: lệnh được phát');
r = await call('GET', `/api/control/confirm/${cid}`, uPk);
ok(r.status === 404, 'xác nhận chỉ dùng một lần');
r = await cmd(uPk, { a: 7, v: 9 }, { 'x-control-token': tokPk });
ok(r.status === 200, 'lệnh thường không cần nút vật lý');

/* ---- PC trạm ---- */
const uSt = mkUser('84900000015');
r = await call('POST', '/api/admin/stations', uOp, { userId: uSt });
ok(r.status === 403, 'chỉ admin tạo được trạm');
r = await call('POST', '/api/admin/stations', uAdmin, { userId: uSt, name: 'PC xưởng' });
ok(r.status === 200 && r.body.id && r.body.key, 'admin tạo trạm, nhận khoá một lần');
const st = r.body;
const stH = { 'x-station-id': st.id, 'x-station-key': st.key };
ipOverride = '203.0.113.20';
r = await cmd(uSt, { a: 7, v: 5 }, stH);
ok(r.status === 200 && r.body.via === 'station', 'PC trạm trong dải LAN: không cần mã');
r = await cmd(uSt, { a: 7, v: 5 }, { ...stH, 'x-station-key': 'sai' });
ok(r.status === 401, 'sai khoá trạm bị từ chối');
r = await cmd(uOp, { a: 7, v: 5 }, stH);
ok(r.status === 401, 'khoá trạm của user khác không dùng được');
ipOverride = '198.51.100.7';
r = await cmd(uSt, { a: 7, v: 5 }, stH);
ok(r.status === 401, 'đúng khoá nhưng IP ngoài dải xưởng: bị từ chối');
ok(CA.listStations(db)[0].key_hash === undefined, 'danh sách trạm không lộ băm khoá');

/* ---- Đăng nhập bằng passkey (không biết trước ai) ---- */
const loginAssertion = (o, extra = {}) => {
  const a = assertion(o, extra);
  a.response.userHandle = Buffer.from(extra.handle ?? `u${uPk}`).toString('base64url');
  return a;
};
let lo = (await call('POST', '/api/login/passkey/options', 0, {})).body;
ok(lo.cid && lo.allowCredentials.length === 0 && lo.userVerification === 'required', 'login/options: passkey khám phá được, không cần SĐT');
r = await call('POST', '/api/login/passkey/verify', 0, { cid: lo.cid, credential: loginAssertion(lo) });
ok(r.status === 200 && r.body.token === `jwt-${uPk}` && r.body.controlToken, 'đăng nhập bằng passkey: nhận JWT + phiên điều khiển');
r = await call('POST', '/api/login/passkey/verify', 0, { cid: lo.cid, credential: loginAssertion(lo) });
ok(r.status === 401, 'cid/challenge đăng nhập dùng một lần');
lo = (await call('POST', '/api/login/passkey/options', 0, {})).body;
r = await call('POST', '/api/login/passkey/verify', 0, { cid: lo.cid, credential: loginAssertion(lo, { handle: 'u999' }) });
ok(r.status === 401 && /user_mismatch/.test(r.body.detail), 'userHandle không khớp chủ passkey bị từ chối');
lo = (await call('POST', '/api/login/passkey/options', 0, {})).body;
r = await call('POST', '/api/login/passkey/verify', 0, { cid: 'khac', credential: loginAssertion(lo) });
ok(r.status === 401, 'cid không khớp challenge bị từ chối');
db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(uPk);
lo = (await call('POST', '/api/login/passkey/options', 0, {})).body;
r = await call('POST', '/api/login/passkey/verify', 0, { cid: lo.cid, credential: loginAssertion(lo) });
ok(r.status === 403, 'tài khoản bị khoá không đăng nhập được bằng passkey');
db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(uPk);

/* ---- Thao tác nhạy cảm không cần mật khẩu: reauth = phiên điều khiển / vừa đăng nhập ---- */
const uNew = mkUser('84900000016');
r = await call('POST', '/t/sensitive', uNew, {});
ok(r.status === 200 && r.body.reauthed, 'chưa có yếu tố + vừa đăng nhập: thao tác nhạy cảm được phép (không cần mật khẩu)');
r = await call('POST', '/t/sensitive', uNew, {}, { 'x-age': '3600' });
ok(r.status === 401 && r.body.error === 'reauth_required', 'chưa có yếu tố + đăng nhập cũ: yêu cầu đăng nhập lại');
r = await call('POST', '/t/sensitive', uPk, {});
ok(r.status === 401 && r.body.error === 'step_up_required' && r.body.methods.passkey, 'đã có passkey: đòi vân tay, không đòi mật khẩu');
r = await call('POST', '/t/sensitive', uPk, {}, { 'x-control-token': tokPk });
ok(r.status === 200, 'có phiên điều khiển (vừa vân tay): được phép');

/* ---- Thêm máy điện thoại mới ---- */
const { deviceCancelToken } = await import('@plciot/security');
const newDev = {}; // máy mới: đã đăng nhập OTP (JWT) nhưng không có phiên điều khiển
r = await call('POST', '/api/devices/request', uNew, {});
ok(r.status === 200 && r.body.options.wait === true && r.body.options.device === false, 'chưa có yếu tố: chỉ có đường chờ/email (không có máy cũ để duyệt)');

// A. Duyệt từ máy cũ
r = await call('POST', '/api/devices/request', uPk, { label: 'iPhone mới' });
ok(r.status === 200 && r.body.id && r.body.pollToken && r.body.options.recoveryCode, 'máy mới tạo yêu cầu, thấy các lựa chọn');
const reqA = r.body;
r = await call('POST', '/api/webauthn/register/options', uPk, {});
ok(r.status === 401, 'chưa duyệt: không đăng ký được yếu tố');
r = await call('GET', '/api/devices/requests', uPk);
ok(r.status === 401, 'chỉ máy đã mở khoá mới xem được danh sách yêu cầu');
r = await call('GET', '/api/devices/requests', uPk, undefined, { 'x-control-token': tokPk });
ok(r.status === 200 && r.body.requests.length === 1 && r.body.requests[0].label === 'iPhone mới', 'máy cũ thấy yêu cầu');
r = await call('GET', '/api/control/status', uPk, undefined, { 'x-control-token': tokPk });
ok(r.body.pendingDevices === 1, 'status báo có 1 yêu cầu chờ');
r = await call('POST', `/api/devices/requests/${reqA.id}/poll`, uPk, { pollToken: 'sai' });
ok(r.status === 404, 'sai pollToken bị từ chối');
r = await call('POST', `/api/devices/requests/${reqA.id}/poll`, uPk, { pollToken: reqA.pollToken });
ok(r.body.status === 'pending' && !r.body.ticket, 'chưa duyệt: không có vé');
r = await call('POST', `/api/devices/requests/${reqA.id}/approve`, uPk, {});
ok(r.status === 401, 'duyệt mà không có phiên điều khiển bị từ chối');
r = await call('POST', `/api/devices/requests/${reqA.id}/approve`, uPk, {}, { 'x-control-token': tokPk });
ok(r.status === 200, 'máy cũ bấm Cho phép');
r = await call('POST', `/api/devices/requests/${reqA.id}/poll`, uPk, { pollToken: reqA.pollToken });
ok(r.body.status === 'approved' && r.body.ticket, 'máy mới nhận vé đăng ký');
const ticketA = r.body.ticket;
r = await call('POST', '/t/sensitive', uPk, {}, { 'x-enroll-ticket': ticketA });
ok(r.status === 401, 'vé không dùng được cho thao tác nhạy cảm khác');
r = await call('POST', '/api/control/cmd', uPk, { a: 7, v: 1 }, { 'x-enroll-ticket': ticketA });
ok(r.status === 401, 'vé không dùng để điều khiển');
r = await call('POST', '/api/webauthn/register/options', uPk, {}, { 'x-enroll-ticket': 'gia' });
ok(r.status === 401, 'vé giả bị từ chối');
r = await call('POST', '/api/control/totp/setup', uPk, {}, { 'x-enroll-ticket': ticketA });
ok(r.status === 200 && r.body.secret, 'có vé: thiết lập Authenticator trên máy mới');
const newSecret = r.body.secret;
r = await call('POST', '/api/control/totp/enable', uPk, { code: '000000' }, { 'x-enroll-ticket': ticketA });
ok(r.status === 401, 'mã sai không bật được');
r = await call('POST', '/api/control/totp/enable', uPk, { code: T.hotp(newSecret, T.stepOf()) }, { 'x-enroll-ticket': ticketA });
ok(r.status === 200 && r.body.controlToken && !r.body.recoveryCodes, 'bật yếu tố trên máy mới: nhận phiên, không tạo lại mã khôi phục');
const tokNewDev = r.body.controlToken;
r = await cmd(uPk, { a: 7, v: 11 }, { 'x-control-token': tokNewDev });
ok(r.status === 200, 'máy mới điều khiển được');
r = await call('POST', '/api/control/totp/setup', uPk, {}, { 'x-enroll-ticket': ticketA });
ok(r.status === 401, 'vé đã dùng một lần');

// B. Mã khôi phục + chờ 24h
r = await call('POST', '/api/devices/request', uPk, { label: 'Android' });
const reqB = r.body;
r = await call('POST', `/api/devices/requests/${reqB.id}/recovery`, uPk, { code: 'AAAA-AAAA-AAAA' });
ok(r.status === 401 && r.body.error === 'recovery_code_invalid', 'mã khôi phục sai bị từ chối');
r = await call('POST', `/api/devices/requests/${reqB.id}/recovery`, uPk, { code: pkCodes[0] });
ok(r.status === 200 && r.body.status === 'cooling' && r.body.coolingHours === 24, 'mã khôi phục đúng: vào thời gian chờ 24h');
r = await call('POST', `/api/devices/requests/${reqB.id}/poll`, uPk, { pollToken: reqB.pollToken });
ok(r.body.status === 'cooling' && !r.body.ticket, 'đang chờ: chưa có vé');
r = await call('POST', `/api/devices/requests/${reqB.id}/recovery`, uPk, { code: pkCodes[0] });
ok(r.status === 409, 'không dùng mã khôi phục hai lần cho cùng yêu cầu');
db.prepare('UPDATE device_requests SET execute_at = ? WHERE id = ?').run(Date.now() - 1, reqB.id); // giả lập hết 24h
r = await call('POST', `/api/devices/requests/${reqB.id}/poll`, uPk, { pollToken: reqB.pollToken });
ok(r.body.status === 'approved' && r.body.ticket, 'hết thời gian chờ: nhận vé');

// C. Chủ huỷ trong lúc chờ (link trong tin nhắn cảnh báo)
r = await call('POST', '/api/devices/request', uPk, { label: 'Kẻ lạ' });
const reqC = r.body;
await call('POST', `/api/devices/requests/${reqC.id}/recovery`, uPk, { code: pkCodes[1] });
let cr = await fetch(`${base}/api/device/cancel?id=${reqC.id}&t=sai`);
ok(cr.status === 403, 'link huỷ sai token bị từ chối');
cr = await fetch(`${base}/api/device/cancel?id=${reqC.id}&t=${deviceCancelToken(reqC.id)}`);
ok(cr.status === 200, 'chủ bấm link huỷ');
db.prepare('UPDATE device_requests SET execute_at = ? WHERE id = ?').run(Date.now() - 1, reqC.id);
r = await call('POST', `/api/devices/requests/${reqC.id}/poll`, uPk, { pollToken: reqC.pollToken });
ok(r.body.status === 'cancelled' && !r.body.ticket, 'yêu cầu đã huỷ không bao giờ nhận vé');

// D. Máy cũ từ chối ; email không khả dụng
r = await call('POST', '/api/devices/request', uPk, { label: 'Khác' });
const reqD = r.body;
ok(r.body.options.email === false, 'email chưa cấu hình: không có lựa chọn email');
r = await call('POST', `/api/devices/requests/${reqD.id}/email/start`, uPk, {});
ok(r.status === 400 && r.body.error === 'old_channel_unavailable', 'email không khả dụng bị từ chối');
r = await call('POST', `/api/devices/requests/${reqD.id}/deny`, uPk, {}, { 'x-control-token': tokNewDev });
ok(r.status === 200, 'máy cũ từ chối');
r = await call('POST', `/api/devices/requests/${reqD.id}/poll`, uPk, { pollToken: reqD.pollToken });
ok(r.body.status === 'denied', 'yêu cầu bị từ chối');

/* ---- Hạn bật yếu tố: quá hạn thì khoá điều khiển, có thông báo trong status ---- */
const uLock = mkUser('84900000020');
r = await call('GET', '/api/control/status', uLock);
ok(r.body.enroll.needed === true && r.body.enroll.locked === false && r.body.enroll.deadline > Date.now(), 'chưa có yếu tố: còn thời gian ân hạn, status báo hạn chót');
db.prepare('UPDATE users SET enroll_deadline = ? WHERE id = ?').run(Date.now() - 1000, uLock);
r = await call('GET', '/api/control/status', uLock);
ok(r.body.enroll.locked === true, 'quá hạn: status báo bị khoá');
r = await cmd(uLock, { a: 7, v: 1 });
ok(r.status === 403 && r.body.error === 'enroll_required', 'quá hạn: lệnh ghi bị chặn với enroll_required');
r = await cmd(uLock, { op: 'read', a: 100, n: 1 });
ok(r.status === 200, 'quá hạn: vẫn đọc được');
r = await call('POST', '/api/control/totp/setup', uLock, {});
const lockSecret = r.body.secret;
ok(r.status === 200 && lockSecret, 'bị khoá vẫn thiết lập được yếu tố (vừa đăng nhập)');
r = await call('POST', '/api/control/totp/enable', uLock, { code: T.hotp(lockSecret, T.stepOf()) });
ok(r.status === 200, 'bật Authenticator');
const lockTok = r.body.controlToken;
r = await call('GET', '/api/control/status', uLock, undefined, { 'x-control-token': lockTok });
ok(r.body.enroll.needed === false && r.body.enroll.locked === false, 'bật xong: hết khoá');
r = await cmd(uLock, { a: 7, v: 2 }, { 'x-control-token': lockTok });
ok(r.status === 200, 'điều khiển lại được');

/* ---- Đăng xuất mọi máy / admin step-up ---- */
const tv0 = db.prepare('SELECT token_version FROM users WHERE id = ?').get(uLock).token_version;
r = await call('POST', '/api/account/logout-all', uLock, {});
ok(r.status === 401 && r.body.error === 'step_up_required', 'đăng xuất mọi máy cần xác nhận lại');
r = await call('POST', '/api/account/logout-all', uLock, {}, { 'x-control-token': lockTok });
ok(r.status === 200 && db.prepare('SELECT token_version FROM users WHERE id = ?').get(uLock).token_version === tv0 + 1, 'đăng xuất mọi máy: token_version tăng');
r = await cmd(uLock, { a: 7, v: 3 }, { 'x-control-token': lockTok });
ok(r.status === 401, 'và phiên điều khiển bị thu hồi');
db.prepare("UPDATE users SET totp_enabled = 1, totp_secret = 'v1.x' WHERE id = ?").run(uAdmin); // admin đã có yếu tố
r = await call('POST', '/api/admin/stations', uAdmin, { userId: uOp, name: 'x' });
ok(r.status === 401 && r.body.error === 'step_up_required', 'thao tác admin đòi xác nhận lại khi đã có yếu tố');

/* ---- Cảnh báo thiết bị lạ ---- */
const { noteLogin } = await import('@plciot/security');
const uDev = db.prepare('SELECT * FROM users WHERE id = ?').get(uOp);
const nl = (id) => noteLogin(db, uDev, { deviceId: id, ip: '1.2.3.4', method: 'OTP' });
ok(nl('device-aaaaaaaaaaaaaaaa').notified === false, 'thiết bị đầu tiên: không báo');
ok(nl('device-aaaaaaaaaaaaaaaa').known === true, 'thiết bị quen');
ok(nl('device-bbbbbbbbbbbbbbbb').notified === true, 'thiết bị thứ hai: gửi cảnh báo');
ok(nl('x').known === null, 'device-id sai định dạng bị bỏ qua');
ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'login_new_device' AND user_id = ?").get(uOp).n === 1, 'ghi audit đăng nhập thiết bị mới');

/* ---- clientIp chỉ tin header từ proxy tin cậy ---- */
const { clientIp } = await import('@plciot/security');
const mkReq = (remote, headers) => ({ headers, socket: { remoteAddress: remote } });
ok(clientIp(mkReq('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4' })) === '203.0.113.9', 'kết nối trực tiếp từ internet: bỏ qua header giả IP');
ok(clientIp(mkReq('172.18.0.5', { 'cf-connecting-ip': '1.2.3.4' })) === '1.2.3.4', 'qua proxy tin cậy: dùng CF-Connecting-IP');
ok(clientIp(mkReq('::ffff:172.18.0.5', { 'x-forwarded-for': '6.6.6.6, 9.9.9.9, 10.0.0.2' })) === '9.9.9.9', 'XFF: lấy hop không tin cậy ngoài cùng bên phải (không tin phần client tự thêm)');

/* ---- OTP: ngân sách theo số điện thoại ---- */
const OT = await import('../src/otp.js');
const { createOtpChallenge } = await import('../src/db.js');
mkUser('84900000030');
let lim = null;
for (let i = 0; i < 8 && !lim; i++) { const x = await OT.requestLoginOtp(db, { phone: '0900000030' }); if (x.error === 'rate_limited') lim = i; }
ok(lim === 6, 'xin OTP quá 6 lần/giờ cho một số bị chặn (bất kể IP)');
const hashOtp = (c) => crypto.createHash('sha256').update(String(c)).digest('hex');
for (let i = 0; i < 10; i++) { createOtpChallenge(db, { phone: '84900000030', purpose: 'login', codeHash: hashOtp('123456') }); OT.verifyLoginOtp(db, { phone: '0900000030', otp: '000000' }); }
createOtpChallenge(db, { phone: '84900000030', purpose: 'login', codeHash: hashOtp('123456') });
ok(OT.verifyLoginOtp(db, { phone: '0900000030', otp: '123456' }).error === 'otp_locked', 'sai 10 lần trong 15 phút: khoá cả khi xin mã mới và nhập đúng');

/* ---- Chống chiếm Telegram tự bật yếu tố đầu tiên: chỉ thiết bị đầu tiên được bật ngay ---- */
const { noteLogin: noteL } = await import('@plciot/security');
const uFd = mkUser('84900000040');
const fdUser = db.prepare('SELECT * FROM users WHERE id = ?').get(uFd);
const DEV_A = 'device-first-aaaaaaaaaaaa'; const DEV_B = 'device-other-bbbbbbbbbbbb';
noteL(db, fdUser, { deviceId: DEV_A, ip: '1.1.1.1', method: 'OTP' });
noteL(db, fdUser, { deviceId: DEV_B, ip: '2.2.2.2', method: 'OTP' });
r = await call('POST', '/api/control/totp/setup', uFd, {}, { 'x-device-id': DEV_B });
ok(r.status === 401 && r.body.error === 'first_device_required', 'thiết bị thứ hai không bật được yếu tố đầu tiên ngay');
r = await call('POST', '/api/webauthn/register/options', uFd, {}, { 'x-device-id': DEV_B });
ok(r.status === 401 && r.body.error === 'first_device_required', '… cả vân tay lẫn Authenticator');
r = await call('POST', '/api/control/totp/setup', uFd, {});
ok(r.status === 401 && r.body.error === 'first_device_required', 'thiếu X-Device-Id: coi là không phải thiết bị đầu tiên');
// đường chờ 24 giờ có cảnh báo + link huỷ
r = await call('POST', '/api/devices/request', uFd, { label: 'Máy khác' }, { 'x-device-id': DEV_B });
const reqW = r.body;
r = await call('POST', `/api/devices/requests/${reqW.id}/wait`, uFd, {});
ok(r.status === 200 && r.body.status === 'cooling', 'chọn chờ: vào thời gian chờ 24 giờ');
r = await call('POST', `/api/devices/requests/${reqW.id}/poll`, uFd, { pollToken: reqW.pollToken });
ok(r.body.status === 'cooling' && !r.body.ticket, 'đang chờ: chưa có vé');
db.prepare('UPDATE device_requests SET execute_at = ? WHERE id = ?').run(Date.now() - 1, reqW.id);
r = await call('POST', `/api/devices/requests/${reqW.id}/poll`, uFd, { pollToken: reqW.pollToken });
ok(r.body.status === 'approved' && r.body.ticket, 'hết chờ: nhận vé');
r = await call('POST', '/api/control/totp/setup', uFd, {}, { 'x-device-id': DEV_B, 'x-enroll-ticket': r.body.ticket });
ok(r.status === 200 && r.body.secret, 'có vé: thiết bị thứ hai bật được yếu tố');
r = await call('POST', '/api/control/totp/setup', uFd, {}, { 'x-device-id': DEV_A });
ok(r.status === 200, 'thiết bị đầu tiên bật yếu tố ngay, không cần chờ');

/* ---- Không có bậc bảo mật thấp: OTP Telegram KHÔNG được dùng để điều khiển ---- */
const uTg = mkUser('84900000050');
db.prepare('UPDATE users SET chat_id = 777 WHERE id = ?').run(uTg);
for (const route of ['/api/control/telegram/enable', '/api/control/telegram/send']) {
  r = await call('POST', route, uTg, {});
  ok(r.status === 404, `đường ${route} không còn tồn tại`);
}
r = await call('POST', '/api/control/unlock', uTg, { method: 'telegram', code: '123456' });
ok(r.status === 400 && r.body.error === 'totp_not_enabled', 'unlock không nhận phương thức telegram');
r = await call('GET', '/api/control/status', uTg);
ok(r.body.methods.enrolled === false && !('canTelegram' in r.body.methods), 'đã liên kết Telegram vẫn chưa có yếu tố điều khiển');
r = await cmd(uTg, { a: 7, v: 15 });
ok(r.status === 401 && r.body.reason === 'no_factor', 'chỉ có Telegram: không điều khiển được');
r = await cmd(uTg, { op: 'read', a: 100, n: 1 });
ok(r.status === 200, 'nhưng vẫn đọc/xem được');

/* ---- Giá trị ghi theo từng thanh ghi ---- */
const { validateCmd: vc, plcControlConfig: cc } = await import('../src/plcCommands.js');
const bad = (a, v) => vc({ a, v }, cc()).error === 'value_out_of_range';
const good = (a, v) => Boolean(vc({ a, v }, cc()).cmd);
ok(bad(3, 2) && good(3, 0) && good(3, 1), 'D3 (chế độ) chỉ 0/1');
ok(bad(4, 256) && good(4, 255) && good(4, 0), 'D4 (mặt nạ Y0..Y7) tối đa 255');
ok(bad(6, 2) && good(6, 1), 'D6 (chạy/dừng) chỉ 0/1');
ok(bad(7, 60001) && good(7, 0) && good(7, 60000), 'D7 (số lượng mục tiêu) 0..60000');
ok(bad(9, 0) && bad(9, 2) && good(9, 1), 'D9 (xoá số đếm) chỉ nhận 1');
process.env.CONTROL_REG_LIMITS = '7:0-500,4:0-15';
ok(bad(7, 501) && good(7, 500) && bad(4, 16), 'CONTROL_REG_LIMITS siết thêm theo cấu hình');
delete process.env.CONTROL_REG_LIMITS;
r = await cmd(uOp, { a: 4, v: 999 }, { 'x-control-token': tokTotp });
ok(r.status === 400 && r.body.error === 'value_out_of_range' && r.body.max === 255, 'API trả value_out_of_range kèm khoảng cho phép');
const { jwtTtlSeconds } = await import('../src/auth.js');
ok(jwtTtlSeconds() === 72 * 3600, 'JWT mặc định 72 giờ (trượt), không còn 7 ngày');

/* ---- Thu hồi ---- */
r = await call('POST', '/api/control/lock', uPk, {}, { 'x-control-token': tokPk });
r = await cmd(uPk, { a: 7, v: 9 }, { 'x-control-token': tokPk });
ok(r.status === 401, 'khoá lại: token bị thu hồi');
r = await call('GET', '/api/control/status', uPk);
ok(r.status === 200 && r.body.methods.passkey && r.body.methods.totp, 'status báo yếu tố đã có (passkey + Authenticator máy mới)');

server.close();
console.log(fails ? `\n${fails} test hỏng` : '\nTất cả đạt');
process.exit(fails ? 1 : 0);
