/**
 * Smoke: /api/activate/* (trang kích hoạt gateway trên điện thoại) — BẮT BUỘC Face ID.
 *  - không token / không phải admin / không có phiên điều khiển → bị từ chối
 *  - phiên điều khiển loại TOTP (không phải passkey) → bị từ chối
 *  - phiên passkey → tạo mã, xem danh sách, xem bản khai, duyệt, huỷ
 *  - ACTIVATE_OPEN=false → 404
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import {
  configure, migrateSecurity, generateClaimRootKeyPair, createSessionAuth, createAppSession, signToken, createControlSession, hashPassword,
} from '@plciot/security';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, '..'));
const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = 'activate-smoke-secret-16c';
process.env.MQTT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'act-cfg-'));
process.env.RATE_LIMIT_ACTIVATE_WRITE = '100';
let failed = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failed++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
const db = new Database(path.join(tmp, 't.db'));
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT NOT NULL DEFAULT 'x', login_password_hash TEXT,
    folder_path TEXT NOT NULL DEFAULT 'f', disabled INTEGER DEFAULT 0, setup_complete INTEGER DEFAULT 1, token_version INTEGER DEFAULT 0,
    notify_site TEXT DEFAULT 'f', notify_device TEXT DEFAULT 'plc01', mqtt_user TEXT, mqtt_pass TEXT,
    role TEXT DEFAULT 'operator', tenant_id TEXT DEFAULT 'default', monitor_scopes TEXT, site_owner INTEGER DEFAULT 0
  );
`);
migrateSecurity(db);
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile TEXT NOT NULL DEFAULT 'conveyor-v1', api_key_hash TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, site TEXT NOT NULL, device TEXT NOT NULL,
    mqtt_user TEXT, mqtt_pass TEXT, topic_ns TEXT NOT NULL DEFAULT 'iot', profile TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tenant_id, site, device));
`);
configure({ secret: () => process.env.APP_JWT_SECRET, publicUrl: () => 'https://plc.example' });

const { mountActivateApi } = await import('../src/activateApi.js');
const { migratePairings } = await import('../src/gatewayPairing.js');
const P = await import('../src/gatewayPairing.js');
const { makeGateway } = await import('./gw-identity.js');
const GW = makeGateway();
migratePairings(db);

const mkUser = (name, role) => {
  const id = db.prepare('INSERT INTO users (username, password_hash, login_password_hash, folder_path, setup_complete, role) VALUES (?,?,?,?,1,?)')
    .run(name, hashPassword('x'), hashPassword('x'), `f_${name}`, role).lastInsertRowid;
  const sid = createAppSession(db, id, 'smoke');
  return { id, token: signToken({ uid: id, tv: 0, sid }, process.env.APP_JWT_SECRET) };
};
const admin = mkUser('adm', 'admin');
const plain = mkUser('usr', 'operator');

const app = express();
app.use(express.json());
const requireAuth = createSessionAuth(db, process.env.APP_JWT_SECRET);
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden' }));
mountActivateApi(app, { db, requireAuth, requireAdmin, reauth: (_q, _s, n) => n() });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, { token, ctl, body } = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ctl ? { 'x-control-token': ctl } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// --- không có Face ID
ok((await call('GET', '/api/activate/pairings')).status === 401, 'không đăng nhập → 401');
ok((await call('GET', '/api/activate/pairings', { token: plain.token })).status === 403, 'user thường (không phải admin) → 403');
let r = await call('GET', '/api/activate/pairings', { token: admin.token });
ok(r.status === 401 && r.body.error === 'faceid_required', 'admin nhưng CHƯA Face ID → 401 faceid_required (cả xem danh sách)');
r = await call('POST', '/api/activate/pairings', { token: admin.token, body: { label: 'x' } });
ok(r.status === 401 && r.body.error === 'faceid_required', 'admin chưa Face ID không tạo được mã');
ok((await call('GET', '/api/activate/pairings', { token: admin.token, ctl: 'token-bay-ba' })).status === 401, 'token điều khiển giả → 401');

// --- phiên TOTP không đủ
const totp = createControlSession(db, admin.id, 'totp', '127.0.0.1');
r = await call('GET', '/api/activate/pairings', { token: admin.token, ctl: totp.token });
ok(r.status === 401 && r.body.reason === 'not_passkey', 'phiên TOTP (không phải Face ID) → bị từ chối');
r = await call('POST', '/api/activate/pairings', { token: admin.token, ctl: totp.token, body: {} });
ok(r.status === 401, 'phiên TOTP không tạo được mã');
ok(!(await call('GET', '/api/activate/status', { token: admin.token, ctl: totp.token })).body.faceId, '/status báo faceId=false với phiên TOTP');

// --- phiên passkey (Face ID) hợp lệ
const pk = createControlSession(db, admin.id, 'passkey', '127.0.0.1');
const A = { token: admin.token, ctl: pk.token };
ok((await call('GET', '/api/activate/status', A)).body.faceId === true, '/status báo faceId=true với phiên passkey');
r = await call('POST', '/api/activate/pairings', { ...A, body: { label: 'Trạm test' } });
ok(r.status === 200 && /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(r.body.code), 'Face ID → tạo được mã ghép cặp');
const made = r.body;
ok((await call('GET', '/api/activate/pairings', A)).body.pairings.some((p) => p.id === made.id && p.status === 'open'), 'danh sách có mã vừa tạo');

// gateway gửi bản khai (đường công khai), rồi duyệt qua trang
const cfg = { devices: [{ id: 'bon1', name: 'Bồn 1', fields: [{ key: 'level', lbl: 'Mức', widget: 'tank' }] }] };
ok(P.submitPairing(db, { ...GW.pairBody(made.code), fp: 'AA11-BB22', config: cfg }).ok, 'gateway gửi bản khai');
const det = await call('GET', `/api/activate/pairings/${made.id}`, A);
ok(det.status === 200 && det.body.hw === GW.hw && det.body.config[0].id === 'bon1', 'xem được bản khai + ID máy');
ok((await call('POST', `/api/activate/pairings/${made.id}/approve`, { ...A, body: { site: 'bad site!', device: 'gw01' } })).body.error === 'invalid_site_or_device', 'duyệt với site sai → lỗi');
const ap = await call('POST', `/api/activate/pairings/${made.id}/approve`, { ...A, body: { site: 'act_site', device: 'gw01', label: 'Trạm test' } });
ok(ap.status === 200 && ap.body.qr && ap.body.loginUrl && !ap.body.gateway && !ap.body.mqtt, 'duyệt → QR + link, KHÔNG trả kit MQTT / mật khẩu');
ok(db.prepare('SELECT activated_hw FROM hardware_devices WHERE site = ? AND device = ?').get('act_site', 'gw01')?.activated_hw === GW.hw, 'tem đã gắn hw của máy ghép cặp');

// mã TỰ DUYỆT tạo từ trang: nhập site → gateway nhập mã là xong; trang xem lại QR (cần Face ID)
const autoMade = (await call('POST', '/api/activate/pairings', { ...A, body: { label: 'Tự động', site: 'act_auto' } })).body;
ok(autoMade.auto === true && autoMade.site === 'act_auto', 'trang tạo mã tự duyệt (có site)');
const GW2 = makeGateway();
const autoSub = P.submitPairing(db, { ...GW2.pairBody(autoMade.code), config: cfg });
ok(autoSub.approved === true && autoSub.site === 'act_auto', 'gateway nhập mã → tự duyệt, không cần bấm duyệt trên trang');
const qrRes = await call('GET', `/api/activate/pairings/${autoMade.id}/qr`, A);
ok(qrRes.status === 200 && qrRes.body.qr === autoSub.qr && qrRes.body.loginUrl, 'trang lấy lại QR của tem đã tự duyệt để user quét');
ok((await call('GET', `/api/activate/pairings/${autoMade.id}/qr`, { token: admin.token })).status === 401, 'xem QR cũng cần Face ID');
ok((await call('GET', `/api/activate/pairings/${made.id}/qr`, A)).status === 200, 'tem duyệt tay cũng xem lại được QR');

// huỷ
const m2 = (await call('POST', '/api/activate/pairings', { ...A, body: {} })).body;
ok((await call('DELETE', `/api/activate/pairings/${m2.id}`, A)).status === 200, 'huỷ mã');

// --- Phiên bị thu hồi (bấm Khoá) thì mất quyền ngay
db.prepare('UPDATE control_sessions SET revoked = 1 WHERE user_id = ?').run(admin.id);
ok((await call('GET', '/api/activate/pairings', A)).status === 401, 'khoá phiên Face ID → mất quyền ngay');

// --- PHASE TEST: cờ bỏ Face ID (chỉ khi test; production vẫn bắt buộc)
process.env.ACTIVATE_FACEID_DISABLED = 'true';
const admin2 = mkUser('adm2', 'admin');
r = await call('GET', '/api/activate/pairings', { token: admin2.token });
ok(r.status === 200, 'ACTIVATE_FACEID_DISABLED=true (test): admin vào được KHÔNG cần Face ID');
ok((await call('GET', '/api/activate/pairings', { token: plain.token })).status === 403, 'bypass Face ID vẫn đòi quyền admin');
ok((await call('GET', '/api/activate/pairings')).status === 401, 'bypass Face ID vẫn đòi đăng nhập');
ok((await call('GET', '/api/activate/status', { token: admin2.token })).body.bypass === true, '/status báo bypass=true để trang hiện cảnh báo');
process.env.NODE_ENV = 'production';
ok((await call('GET', '/api/activate/pairings', { token: admin2.token })).status === 401, 'NODE_ENV=production: cờ bị BỎ QUA, Face ID lại bắt buộc');
delete process.env.NODE_ENV; delete process.env.ACTIVATE_FACEID_DISABLED;
ok((await call('GET', '/api/activate/pairings', { token: admin2.token })).status === 401, 'tắt cờ → Face ID lại bắt buộc');

// --- kill switch
process.env.ACTIVATE_OPEN = 'false';
ok((await call('GET', '/api/activate/status', { token: admin.token })).status === 404, 'ACTIVATE_OPEN=false → 404');
server.close();
console.log(failed ? `\n${failed} FAILED` : '\nsmoke-activate: all ok');
process.exit(failed ? 1 : 0);
