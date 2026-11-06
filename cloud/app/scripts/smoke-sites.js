#!/usr/bin/env node
/** Offline smoke test: nhận thiết bị, mời/gỡ thành viên, ghép PC nhà máy bằng mã, lệnh ký bằng khoá thiết bị. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-sites-'));
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';
process.env.WEBAPP_PUBLIC_URL = 'https://plc.example.com';
process.env.RATE_LIMIT_CONTROL_AUTH = '1000';
process.env.RATE_LIMIT_CONTROL_CMD = '1000';
process.env.RATE_LIMIT_SITE = '1000';
process.env.RATE_LIMIT_STATION_CMD = '1000';
process.env.CONTROL_PHYSICAL_BIT = '5';
process.env.CONTROL_PHYSICAL_WAIT_SEC = '5';

const { openDb } = await import('../src/db.js');
const { setPublisher } = await import('../src/controlPublisher.js');
const { mountSecurityRoutes } = await import('@plciot/security');
const { mountPlcControl } = await import('../src/plcControlRoutes.js');
// ghép lõi bảo mật + phần điều khiển PLC như server.js
const mountControl = (app, ctx) => { const sec = mountSecurityRoutes(app, ctx); mountPlcControl(app, { db: ctx.db, requireAuth: ctx.requireAuth, security: sec }); return sec; };
const { mountSite } = await import('../src/siteRoutes.js');
const { stationMessage } = await import('@plciot/security');
const { noteTelemetry } = await import('../src/plcProof.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

const db = openDb(tmp);
const mk = (username, role = 'operator', site = null) => {
  const s = site ?? `s${username}`;
  return Number(db.prepare(`INSERT INTO users (username, password_hash, folder_path, role, notify_site, notify_device, mqtt_user, mqtt_pass)
    VALUES (?, 'x', 'f', ?, ?, 'plc01', ?, 'p')`).run(username, role, s, `u${username}`).lastInsertRowid);
};
const published = [];
setPublisher(async (site, device, cmd) => { published.push({ site, device, cmd }); });

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const requireAuth = (req, res, next) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.headers['x-uid']));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  req.tokenPayload = { iat: Math.floor(Date.now() / 1000) }; // vừa đăng nhập → reauth ok khi chưa có yếu tố
  next();
};
const api = mountControl(app, {
  db, requireAuth, adminOnly: [requireAuth], loginPayload: () => ({}), authStrict: (_q, _r, n) => n(),
});
mountSite(app, { db, requireAuth, reauth: api.reauth });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, uid, body, headers = {}) {
  const r = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(uid ? { 'x-uid': String(uid) } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/* ---- migration: chủ site mặc định = id nhỏ nhất ---- */
const a = mk('owner_a', 'operator', 'plantX'); const b = mk('member_b', 'operator', 'plantX');
let r = await call('GET', '/api/site', a);
ok(r.body.isOwner === true && r.body.members.length === 2, 'người dùng đầu tiên của site tự là chủ, thấy danh sách thành viên');
r = await call('GET', '/api/site', b);
ok(r.body.isOwner === false && !r.body.members, 'thành viên thường không thấy danh sách');
r = await call('POST', '/api/site/invites', b, { role: 'operator' });
ok(r.status === 403 && r.body.error === 'not_site_owner', 'thành viên không được mời người khác');

/* ---- nhận thiết bị: claim vật lý (ngõ X) đã thay bằng QR tem ---- */
const c = mk('owner_c', 'operator', 'plantNew');       // chủ site riêng (người đầu tiên của site)
noteTelemetry('plantNew', 'plc01', 0);
r = await call('POST', '/api/site/claim/start', c, { site: 'plantNew', device: 'plc01' });
ok(r.status === 410 && r.body.error === 'use_device_qr_claim', 'claim vật lý đã bỏ: dùng QR tem (xem smoke-device-claim)');
const d = mk('member_d', 'operator', 'plantNew');

/* ---- mời thành viên bằng mã mời (token), không cần SĐT/email ---- */
r = await call('POST', '/api/site/invites', c, { role: 'operator' });
ok(r.status === 200 && r.body.id && r.body.code && r.body.url.includes('invite='), 'chủ site tạo mã mời (token + liên kết)');
const inv = r.body.id;
r = await call('POST', '/api/site/invites', d, { role: 'operator' });
ok(r.status === 403 && r.body.error === 'not_site_owner', 'thành viên không tạo được mã mời');
r = await call('POST', '/api/site/invites', c, { role: 'root' });
ok(r.status === 200 && r.body.role === 'operator', 'role lạ bị đưa về operator');
r = await call('GET', '/api/site', c);
ok(r.body.isOwner === true && r.body.invitesOut?.length >= 2, 'chủ thấy các mã mời đã tạo');
r = await call('DELETE', `/api/site/invites/${inv}`, c);
ok(r.body.ok, 'chủ huỷ mã mời');
r = await call('DELETE', `/api/site/invites/${inv}`, c);
ok(r.status === 404, 'mã mời đã huỷ không huỷ lại được');
r = await call('POST', '/api/site/invites', c, { role: 'viewer' });
db.prepare("UPDATE site_invites SET expires_at = ? WHERE id = ?").run(Date.now() - 1, r.body.id);
r = await call('POST', `/api/invites/${r.body.id}/accept`, d);
ok(r.status === 410 || r.status === 404, 'mã mời hết hạn không chấp nhận được');
r = await call('DELETE', `/api/site/members/${c}`, c);
ok(r.status === 409, 'không gỡ chủ site');
r = await call('DELETE', `/api/site/members/${d}`, c);
ok(r.body.ok, 'chủ site gỡ thành viên');
const du2 = db.prepare('SELECT * FROM users WHERE id = ?').get(d);
ok(du2.notify_site !== 'plantNew' && du2.token_version === 1, 'thành viên bị gỡ về vùng riêng, phiên cũ bị thu hồi');

/* ---- ghép PC nhà máy ---- */
r = await call('POST', '/api/site/pair-code', b, { name: 'x' });
ok(r.status === 403, 'không phải chủ site không tạo được mã ghép PC');
r = await call('POST', '/api/site/pair-code', c, { name: 'PC chuyền 1' });
ok(r.status === 200 && /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(r.body.code), 'chủ site tạo mã ghép PC');
const code = r.body.code;
const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
r = await call('POST', '/api/station/pair', null, { code: 'AAAA-AAAA', publicKey: spki });
ok(r.status === 401 && r.body.error === 'invalid_pair_code', 'mã ghép sai bị từ chối');
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
r = await call('POST', '/api/station/pair', null, { code, publicKey: rsa });
ok(r.status === 400 && r.body.error === 'invalid_public_key', 'chỉ nhận khoá ECDSA P-256');
r = await call('POST', '/api/station/pair', null, { code, publicKey: spki, hwid: 'HW-1', name: 'PC chuyền 1' });
ok(r.status === 200 && r.body.stationId && r.body.site === 'plantNew', 'PC ghép thành công, không cần admin');
const sid = r.body.stationId;
r = await call('POST', '/api/station/pair', null, { code, publicKey: spki });
ok(r.status === 401, 'mã ghép chỉ dùng một lần');

let seq = 0;
async function stationCall(method, url, body, { id = sid, key = kp.privateKey, ts = Date.now(), sigOverride } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const sig = sigOverride || crypto.sign('sha256', Buffer.from(stationMessage(ts, method, url, raw)), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const rr = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', 'x-station-id': id, 'x-station-ts': String(ts), 'x-station-sig': sig, 'x-seq': String(++seq) },
    body: body === undefined ? undefined : raw,
  });
  return { status: rr.status, body: await rr.json().catch(() => ({})), sig };
}
r = await stationCall('GET', '/api/station/ping');
ok(r.status === 200 && r.body.site === 'plantNew', 'PC ký request hợp lệ');
const pingSig = r.sig;
r = await stationCall('GET', '/api/station/ping', undefined, { sigOverride: pingSig });
ok(r.status === 401 && r.body.error === 'station_replay', 'phát lại chữ ký bị chặn');
r = await stationCall('GET', '/api/station/ping', undefined, { key: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
ok(r.status === 401, 'khoá riêng khác bị từ chối');
r = await stationCall('GET', '/api/station/ping', undefined, { ts: Date.now() - 5 * 60_000 });
ok(r.status === 401, 'dấu thời gian cũ bị từ chối');
r = await stationCall('GET', '/api/station/ping', undefined, { id: 'pc_khong_co' });
ok(r.status === 401, 'trạm không tồn tại bị từ chối');
r = await stationCall('POST', '/api/station/cmd', { a: 7, v: 20, id: 'st1' });
ok(r.status === 200 && published.at(-1).site === 'plantNew' && published.at(-1).cmd.v === 20, 'PC gửi lệnh tới đúng site, không cần mã');
r = await stationCall('POST', '/api/station/cmd', { a: 99, v: 1 });
ok(r.status === 400, 'lệnh ngoài whitelist bị từ chối ở đường PC');
// body bị sửa sau khi ký
{
  const ts = Date.now();
  const signedRaw = JSON.stringify({ a: 7, v: 1 });
  const sig = crypto.sign('sha256', Buffer.from(stationMessage(ts, 'POST', '/api/station/cmd', signedRaw)), { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const rr = await fetch(`${base}/api/station/cmd`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-station-id': sid, 'x-station-ts': String(ts), 'x-station-sig': sig }, body: JSON.stringify({ a: 7, v: 65000 }) });
  ok(rr.status === 401, 'sửa nội dung lệnh sau khi ký bị phát hiện');
}
const before = published.length;
r = await stationCall('POST', '/api/station/cmd', { a: 4, v: 3 });
ok(r.status === 202 && r.body.pending && published.length === before, 'lệnh nguy hiểm vẫn cần nút vật lý');
const cid = r.body.confirmId;
noteTelemetry('plantNew', 'plc01', 0);
await new Promise((x) => setTimeout(x, 20));
noteTelemetry('plantNew', 'plc01', 1 << 5);
r = await stationCall('GET', `/api/station/confirm/${cid}`);
ok(r.body.sent && published.at(-1).cmd.a === 4, 'bấm nút vật lý: lệnh được phát');

/* ---- đổi PC: thu hồi PC cũ ---- */
r = await call('GET', '/api/site', c);
ok(r.body.stations.length === 1 && r.body.stations[0].name === 'PC chuyền 1' && !('public_key' in r.body.stations[0]), 'chủ thấy danh sách PC (không lộ khoá)');
r = await call('DELETE', `/api/site/stations/${sid}`, b);
ok(r.status === 403, 'người ngoài không thu hồi được PC');
r = await call('DELETE', `/api/site/stations/${sid}`, c);
ok(r.body.ok, 'chủ thu hồi PC cũ');
r = await stationCall('GET', '/api/station/ping');
ok(r.status === 401, 'PC đã thu hồi mất quyền ngay');
r = await call('POST', '/api/site/pair-code', c, { name: 'PC mới' });
ok(r.status === 200, 'tạo mã ghép cho PC thay thế');
db.prepare('UPDATE pair_codes SET expires_at = ?').run(Date.now() - 1);
r = await call('POST', '/api/station/pair', null, { code: r.body.code, publicKey: spki });
ok(r.status === 401, 'mã ghép hết hạn không dùng được');

server.close();
console.log(fails ? `\n${fails} test hỏng` : '\nTất cả đạt');
process.exit(fails ? 1 : 0);
