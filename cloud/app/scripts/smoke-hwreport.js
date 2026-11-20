#!/usr/bin/env node
/**
 * Smoke: chủ gateway BÁO MẤT → khoá tạm ngay (gateway nhận sys:lock) → admin duyệt (giữ khoá) hoặc từ chối (mở khoá); chủ tự huỷ khi tìm lại máy;
 *        không báo trùng, giới hạn số lần/ngày, server từ chối lệnh tới gateway đang khoá.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { configure, migrateSecurity, generateClaimRootKeyPair } from '@plciot/security';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, '..'));
const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = 'hw-report-smoke-secret-1616';
process.env.HW_REPORTS_PER_DAY = '4';   // r1..r4 hợp lệ, lần thứ 5 bị giới hạn
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-hwreport-'));
process.env.MQTT_CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;

const db = new Database(path.join(tmp, 't.db'));
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT NOT NULL DEFAULT 'x',
    folder_path TEXT NOT NULL DEFAULT 'f', disabled INTEGER DEFAULT 0, setup_complete INTEGER DEFAULT 1,
    notify_site TEXT DEFAULT 'f', notify_device TEXT DEFAULT 'plc01', mqtt_user TEXT, mqtt_pass TEXT,
    role TEXT DEFAULT 'operator', tenant_id TEXT DEFAULT 'default', monitor_scopes TEXT, site_owner INTEGER DEFAULT 0
  );
`);
migrateSecurity(db);
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile TEXT NOT NULL DEFAULT 'conveyor-v1', api_key_hash TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, site TEXT NOT NULL, device TEXT NOT NULL,
    mqtt_user TEXT, mqtt_pass TEXT, topic_ns TEXT NOT NULL DEFAULT 'iot', profile TEXT,
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tenant_id, site, device)
  );
`);
configure({ secret: () => process.env.APP_JWT_SECRET, publicUrl: () => 'https://plc.example' });

const { refreshGatewayQr, enrollGateway } = await import('../src/gatewayEnroll.js');
const P = await import('../src/gatewayPairing.js');
const H = await import('../src/hwBlock.js');
const { setPublisher } = await import('../src/controlPublisher.js');
const { makeGateway } = await import('./gw-identity.js');
const { migrateUserDevices } = await import('../src/userDevices.js');
const { ensureMqttIdColumn } = await import('../src/mqttIds.js');
migrateUserDevices(db);
H.initHwBlockTable(db);

const sent = [];
setPublisher(async (site, device, payload) => { sent.push({ site, device, payload }); });

let failed = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { console.error('FAIL', m); failed += 1; } };
db.prepare("INSERT INTO users (username) VALUES ('chu')").run();
const owner = db.prepare("SELECT * FROM users WHERE username='chu'").get();
const GW = makeGateway(), OTHER = makeGateway();
const reg = P.registerForUser(db, owner, GW.registerBody(owner.id, { config: { devices: [] } }));
ok(reg.ok && reg.approved, 'đăng ký gateway (tem có khoá công khai)');
const { site, device } = reg;
try { ensureMqttIdColumn(db); } catch { /* đã có */ }
if (!db.prepare('SELECT mqtt_id FROM devices WHERE site = ? AND device = ?').get(site, device)?.mqtt_id)
  db.prepare("UPDATE devices SET mqtt_id = '0123456789abcdef' WHERE site = ? AND device = ?").run(site, device);
const cfg = () => enrollGateway(db, { qr: reg.qr, ...GW.proof('config', site, device) }, { kind: 'config', includePassword: false });
const qrBody = () => { const ts = Date.now(); return { site, device, pubkey: GW.pubkey, ts, sig: GW.sign(`qr|${site}|${device}|${ts}`) }; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ok(!cfg().error, 'trước khi báo: gateway hỏi cấu hình bình thường');
ok(H.hwOfGateway(db, site, device) === GW.hw, 'hwOfGateway ra đúng mã phần cứng');
ok(H.hwOfGateway(db, 'nope', 'nope') === null && !H.isGatewayLocked(db, site, device), 'gateway chưa khoá; gateway lạ → null');

// ---- báo mất → khoá tạm ngay
const r1 = H.reportLost(db, { userId: owner.id, site, device, reason: 'mất ở kho' });
await sleep(20);
ok(r1.ok && r1.report.status === 'pending' && r1.report.hw === GW.hw, 'báo mất → báo cáo pending');
ok(H.isGatewayLocked(db, site, device) && cfg().error === 'device_blocked', 'khoá tạm có hiệu lực ngay (server + gateway hỏi config → device_blocked)');
ok(sent.some((s) => s.site === site && s.payload.sys === 'lock' && String(s.payload.reason).includes('chờ admin')), 'gateway đang nối nhận { sys:"lock" } kèm lý do chờ duyệt');
ok(H.reportLost(db, { userId: owner.id, site, device }).error === 'already_reported', 'báo trùng khi đang chờ → already_reported');
ok(H.listReports(db, { userId: owner.id }).length === 1 && H.listReports(db, { status: 'pending' }).length === 1, 'danh sách: của chủ + lọc pending (admin)');
ok(H.listReports(db, { userId: owner.id + 99 }).length === 0, 'người khác không thấy báo cáo của chủ');

// ---- người khác không huỷ được; chủ huỷ khi tìm lại máy
ok(H.cancelReport(db, r1.report.id, owner.id + 99).error === 'not_found', 'user khác không huỷ được báo cáo');
sent.length = 0;
const c1 = H.cancelReport(db, r1.report.id, owner.id);
await sleep(20);
ok(c1.ok && c1.report.status === 'cancelled' && !H.isGatewayLocked(db, site, device), 'chủ tìm lại máy → huỷ báo cáo → mở khoá');
ok(sent.some((s) => s.payload.sys === 'unlock') && !cfg().error, 'gateway nhận { sys:"unlock" } và hỏi config bình thường');
ok(H.cancelReport(db, r1.report.id, owner.id).error === 'not_pending', 'huỷ lần hai → not_pending');

// ---- admin TỪ CHỐI (báo nhầm) → mở khoá
const r2 = H.reportLost(db, { userId: owner.id, site, device, reason: 'báo nhầm' });
const d2 = H.decideReport(db, r2.report.id, { approve: false, adminId: 1, note: 'khách đã tìm thấy' });
ok(d2.ok && d2.report.status === 'rejected' && d2.report.decidedBy === 1 && !H.isGatewayLocked(db, site, device), 'admin từ chối → rejected + mở khoá');
ok(H.decideReport(db, r2.report.id, { approve: true }).error === 'not_pending', 'quyết định lần hai → not_pending');
ok(H.decideReport(db, 9999, { approve: true }).error === 'not_found', 'báo cáo không tồn tại → not_found');

// ---- admin DUYỆT → giữ khoá, chủ không tự mở được
const r3 = H.reportLost(db, { userId: owner.id, site, device, reason: 'bị trộm' });
const d3 = H.decideReport(db, r3.report.id, { approve: true, adminId: 1, note: 'đã xác minh' });
ok(d3.ok && d3.report.status === 'approved' && H.isGatewayLocked(db, site, device), 'admin duyệt → approved, vẫn khoá');
ok(H.listHwBlocks(db).some((x) => x.hw === GW.hw && x.blockedBy === 1 && x.reason.includes('admin đã duyệt')), 'khoá ghi tên admin + lý do đã duyệt');
ok(H.cancelReport(db, r3.report.id, owner.id).error === 'not_pending' && H.isGatewayLocked(db, site, device), 'chủ không tự huỷ báo cáo đã duyệt');
ok(H.reportLost(db, { userId: owner.id, site, device }).error === 'already_blocked', 'báo mất máy đã bị khoá → already_blocked');
ok(refreshGatewayQr(db, qrBody()).error === 'device_blocked', 'đã duyệt: lấy lại QR → device_blocked');

// ---- admin mở khoá thẳng sau khi duyệt (tìm lại máy) → released
H.unblockHw(db, GW.hw);
ok(H.listReports(db, { userId: owner.id }).find((x) => x.id === r3.report.id).status === 'released' && !H.isGatewayLocked(db, site, device), 'admin mở khoá → báo cáo released');

// ---- admin mở khoá thẳng khi còn chờ → rejected
const r4 = H.reportLost(db, { userId: owner.id, site, device });
H.unblockHw(db, GW.hw);
ok(H.getReport(db, r4.report.id).status === 'rejected', 'admin mở khoá khi còn chờ → báo cáo rejected');

// ---- giới hạn báo cáo/ngày (chống khoá bừa)
const rl = H.reportLost(db, { userId: owner.id, site, device });
ok(rl.error === 'report_limit' && rl.status === 429, `quá ${H.REPORTS_PER_DAY} lần/ngày → report_limit (429)`);
ok(!H.isGatewayLocked(db, site, device), 'báo bị giới hạn thì không khoá');

console.log(failed ? `\n${failed} kiểm tra hỏng` : '\nTất cả đạt');
process.exit(failed ? 1 : 0);
