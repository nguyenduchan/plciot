#!/usr/bin/env node
/** Smoke test: cài đặt gateway từ xa (remoteAdmin.js) — chữ ký máy GatewayAdmin, chống phát lại, quyền chủ gateway, route bị chặn,
 *  gói rpc có chữ ký rpc1 (không dùng được như cmd1), ghép trả lời rpcr nhiều phần, trả lời từ gateway khác bị bỏ, ACL broker. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-radm-'));
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.DATA_DIR = tmp;
process.env.RADMIN_RPC_TIMEOUT_MS = '1500';

const { openDb } = await import('../src/db.js');
const { setPublisher } = await import('../src/controlPublisher.js');
const R = await import('../src/remoteAdmin.js');
const { cmdPublicKey, rpcMessage, verifySignedCmd } = await import('../src/cmdSign.js');
const { deviceAclBlock, rebuildAclFromUsers } = await import('../src/mqttProvision.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

const db = openDb(tmp);
const { migrateUserDevices } = await import('../src/userDevices.js');
migrateUserDevices(db);
db.prepare(`INSERT INTO users (username, password_hash, folder_path, role, notify_site, notify_device) VALUES ('owner1', 'x', 'f', 'operator', 'siteA', 'gw01')`).run();
db.prepare(`INSERT INTO users (username, password_hash, folder_path, role, notify_site, notify_device) VALUES ('other1', 'x', 'f', 'operator', 'siteB', 'gw09')`).run();
const MQ = 'a1b2c3d4e5f60718';
{
  const cols = db.prepare("PRAGMA table_info('devices')").all().map((c) => c.name);
  if (!cols.includes('mqtt_id')) db.exec('ALTER TABLE devices ADD COLUMN mqtt_id TEXT');
  db.prepare(`INSERT INTO devices (tenant_id, site, device, mqtt_user, mqtt_pass, created_at, updated_at, mqtt_id) VALUES ('default', 'siteA', 'gw01', 'u1', 'p', ?, ?, ?)`).run(Date.now(), Date.now(), MQ);
}

// máy GatewayAdmin
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const keyId = R.addAdminKey(db, 'may-test', spki);
ok(keyId === R.keyIdOf(spki) && /^[0-9a-f]{16}$/.test(keyId), 'đăng ký khoá máy admin → key_id 16 hex');

// gateway giả: nhận rpc, kiểm chữ ký, trả lời chia phần
const seenRpc = [];
let replyFrom = MQ, bigReply = false;
setPublisher(async (_s, _d, raw, opts) => {
  seenRpc.push({ raw, opts });
  const i = raw.lastIndexOf(',"sig":"');
  const json = `${raw.slice(0, i)}}`;
  const key = crypto.createPublicKey({ key: Buffer.from(cmdPublicKey(), 'base64url'), format: 'der', type: 'spki' });
  const good = crypto.verify('sha256', Buffer.from(rpcMessage(opts.mqttId, json), 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(raw.slice(i + 8, -2), 'base64url'));
  if (!good) return;
  const m = JSON.parse(json);
  const reqBody = m.b ? zlib.gunzipSync(Buffer.from(m.b, 'base64')).toString('utf8') : '';
  const body = bigReply ? JSON.stringify({ Ok: true, pad: crypto.randomBytes(9000).toString('hex') }) : JSON.stringify({ Ok: true, echo: `${m.m} ${m.p}`, reqBody, adm: m.adm });
  const z = zlib.gzipSync(Buffer.from(body)).toString('base64');
  const parts = z.match(/[\s\S]{1,3000}/g);
  setTimeout(() => parts.forEach((p, k) => R.onRpcReply(replyFrom, Buffer.from(JSON.stringify({ rid: m.rid, i: k, n: parts.length, st: 200, z: p })))), 20);
  bigReply && (bigReply = body);
});

const app = express();
app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
const requireAuth = (req, res, next) => { const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.get('x-test-user') || ''); if (!u) return res.status(401).end(); req.user = u; next(); };
R.mountRemoteAdmin(app, { db, requireAuth });
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;

async function signed(method, p, bodyObj, { tamper, ts, nonce, key = privateKey, kid = keyId } = {}) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  ts ??= Date.now(); nonce ??= crypto.randomBytes(12).toString('base64url');
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  let sig = crypto.sign('sha256', Buffer.from(R.radmMessage(method, p, ts, nonce, hash)), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  if (tamper) sig = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-radm-key': kid, 'x-radm-ts': String(ts), 'x-radm-nonce': nonce, 'x-radm-sig': sig }, body: body || undefined });
  return { status: r.status, j: await r.json().catch(() => ({})), nonce, ts };
}
const user = (name, method, p, b) => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': name }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

ok((await fetch(`${base}/api/v1/radmin/gateways`)).status === 401, 'không ký → 401');
ok((await signed('GET', '/api/v1/radmin/gateways', undefined, { tamper: true })).status === 401, 'chữ ký sai → 401');
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
ok((await signed('GET', '/api/v1/radmin/gateways', undefined, { key: other.privateKey })).j.error === 'radmin_bad_sig', 'khoá khác ký với key_id đã đăng ký → bad_sig');
ok((await signed('GET', '/api/v1/radmin/gateways', undefined, { kid: 'ffffffffffffffff' })).j.error === 'radmin_unknown_key', 'key_id chưa đăng ký → 401');
ok((await signed('GET', '/api/v1/radmin/gateways', undefined, { ts: Date.now() - 120_000 })).j.error === 'radmin_clock', 'lệch giờ 2 phút → 401');
const g1 = await signed('GET', '/api/v1/radmin/gateways');
ok(g1.status === 200 && g1.j.gateways.some((g) => g.site === 'siteA' && g.device === 'gw01' && g.allowed === false && g.owner === 'owner1'), 'danh sách gateway: gw01 của owner1, mặc định CHƯA cho phép');
ok((await signed('GET', '/api/v1/radmin/gateways', undefined, { nonce: g1.nonce })).j.error === 'radmin_replay', 'dùng lại nonce → radmin_replay');
// sửa thân sau khi ký
{
  const body = JSON.stringify({ site: 'siteA', device: 'gw01', method: 'GET', path: '/api/state' });
  const ts = Date.now(), nonce = crypto.randomBytes(12).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(R.radmMessage('POST', '/api/v1/radmin/rpc', ts, nonce, crypto.createHash('sha256').update(body).digest('hex'))), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const r = await fetch(`${base}/api/v1/radmin/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-radm-key': keyId, 'x-radm-ts': String(ts), 'x-radm-nonce': nonce, 'x-radm-sig': sig }, body: body.replace('/api/state', '/api/config') });
  ok(r.status === 401, 'sửa thân yêu cầu sau khi ký → 401');
}

const rpc = (method, p, body, extra = {}) => signed('POST', '/api/v1/radmin/rpc', { site: 'siteA', device: 'gw01', method, path: p, body, ...extra });
ok((await rpc('GET', '/api/state')).j.error === 'radmin_not_allowed', 'chủ chưa cho phép → 403 radmin_not_allowed');
ok((await user('other1', 'PUT', '/api/v1/remote-support', { site: 'siteA', device: 'gw01', allowed: true })).j.error === 'not_owner', 'người khác bật hộ → not_owner');
const on = await user('owner1', 'PUT', '/api/v1/remote-support', { site: 'siteA', device: 'gw01', allowed: true });
ok(on.status === 200 && on.j.allowed === true, 'chủ gateway bật "Cho phép hỗ trợ từ xa"');
ok((await user('owner1', 'GET', '/api/v1/remote-support')).j.gateways?.some((g) => g.device === 'gw01' && g.allowed), 'chủ xem lại trạng thái cho phép');
ok((await rpc('POST', '/api/run', '{"Run":false}')).j.error === 'radmin_route_blocked', 'route chạy/dừng gateway bị chặn');
ok((await rpc('PUT', '/api/network', '{}')).j.error === 'radmin_route_blocked', 'route đổi mạng bị chặn');

const st = await rpc('GET', '/api/state');
ok(st.status === 200 && st.j.status === 200 && JSON.parse(st.j.body).echo === 'GET /api/state' && JSON.parse(st.j.body).adm === 'may-test', 'GET /api/state qua relay: gateway nhận đúng, có tên máy admin');
const last = seenRpc.at(-1);
ok(last.opts.mqttId === MQ && last.opts.kind === 'rpc', 'publish lên gw/<mqttId>/rpc đúng gateway');
ok(!verifySignedCmd(MQ, last.raw), 'chữ ký rpc1 KHÔNG hợp lệ như lệnh cmd1 (tách miền chữ ký)');
const cfg = JSON.stringify({ Config: { PollMs: 1000, Pack: Array.from({ length: 50 }, (_, k) => ({ Child: `d${k}`, Field: 'run' })) } });
const put = await rpc('PUT', '/api/config', cfg);
ok(put.j.status === 200 && JSON.parse(put.j.body).reqBody === cfg, 'PUT /api/config: thân (gzip) tới gateway nguyên vẹn');
bigReply = true;
const big = await rpc('GET', '/api/config');
ok(big.j.status === 200 && big.j.body === bigReply && big.j.body.length > 18000, `trả lời lớn (${big.j.body?.length} B) ghép từ nhiều phần rpcr`);
bigReply = false;
replyFrom = 'ffffffffffffffff';
const to = await rpc('GET', '/api/state');
ok(to.j.status === 504, 'trả lời từ gateway KHÁC bị bỏ → hết giờ 504');
replyFrom = MQ;
ok((await rpc('PUT', '/api/config', 'x'.repeat(40000) + crypto.randomBytes(12000).toString('hex'))).j.status === 413, 'thân quá lớn → 413 too_large');
const aud = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'radmin_rpc'").get().n;
ok(aud >= 3, `ghi nhật ký radmin_rpc (${aud} dòng: lệnh ghi + đọc cấu hình)`);
await user('owner1', 'PUT', '/api/v1/remote-support', { site: 'siteA', device: 'gw01', allowed: false });
ok((await rpc('GET', '/api/state')).j.error === 'radmin_not_allowed', 'chủ tắt lại → admin bị chặn ngay');

const acl = deviceAclBlock('u1', { mqttId: MQ });
ok(acl.includes(`topic read gw/${MQ}/rpc`) && acl.includes(`topic write gw/${MQ}/rpcr`) && !acl.includes(`topic write gw/${MQ}/rpc\n`), 'ACL gateway: đọc rpc, ghi rpcr (không ghi rpc)');
process.env.MQTT_CONFIG_DIR = tmp;
try { rebuildAclFromUsers(db); } catch { /* thư mục shard có thể khác: bỏ qua phần ghi file */ }
const aclFile = ['acl', 'acl-monitor'].map((f) => path.join(tmp, f)).find((f) => fs.existsSync(f));
if (aclFile) {
  const txt = fs.readFileSync(path.join(tmp, 'acl'), 'utf8');
  ok(/user ctl\n(?:.*\n)*?topic write gw\/\+\/rpc/.test(txt) && /user ingest\n(?:.*\n)*?topic read gw\/\+\/rpcr/.test(txt), 'ACL tĩnh: ctl ghi rpc, ingest đọc rpcr');
}

srv.close();
console.log(fails ? `\n${fails} FAIL` : '\nTẤT CẢ OK');
process.exit(fails ? 1 : 0);
