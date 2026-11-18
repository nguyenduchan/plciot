#!/usr/bin/env node
/**
 * Smoke: ĐỔI CHỦ gateway — tài khoản mới xin → chờ chủ cũ duyệt/từ chối hoặc hết hạn chờ; người thứ ba không chen được;
 *        không giữ khoá riêng của gateway thì không xin được.
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
process.env.APP_JWT_SECRET = 'gateway-transfer-smoke-secret16';
process.env.TRANSFER_WAIT_HOURS = '24';   // test chế độ CÓ CHỜ (mặc định là chuyển ngay cho người cầm thiết bị: xem smoke-gateway-transfer-holder.js)
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-transfer-'));
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

process.env.REAUTH_DISABLED = 'true';
const P = await import('../src/gatewayPairing.js');
const T = await import('../src/gatewayTransfer.js');
const { makeGateway } = await import('./gw-identity.js');
const { migrateUserDevices } = await import('../src/userDevices.js');
const { initPushTables } = await import('../src/webPush.js');
migrateUserDevices(db); initPushTables(db); T.migrateGatewayTransfers(db);

let failed = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { console.error('FAIL', m); failed += 1; } };
for (const u of ['a', 'b', 'c']) db.prepare('INSERT INTO users (username) VALUES (?)').run(u);
const U = (n) => db.prepare('SELECT * FROM users WHERE username = ?').get(n);
const A = U('a'); const B = U('b'); const C = U('c');
const GW = makeGateway(); const OTHER = makeGateway();
let fresh; try { fresh = P.findForeignPairing(db, A, GW.registerBody(A.id, {})); } catch (e) { fresh = e; }
ok(fresh === null, 'DB mới (chưa đăng ký lần nào): tra cứu đổi chủ không lỗi (cột user_id có sẵn)');
const reg = P.registerForUser(db, A, GW.registerBody(A.id, { config: { devices: [] } }));
ok(reg.ok && reg.approved, 'A đăng ký gateway');
const ownerOf = () => db.prepare("SELECT user_id FROM gateway_pairings WHERE site = ? AND device = ? AND status = 'approved'").get(reg.site, reg.device)?.user_id;

// Không giữ khoá riêng → không xin được (chữ ký của máy khác với khoá công khai của gateway)
const forged = { ...OTHER.registerBody(B.id, {}), pubkey: GW.pubkey };
const prev = P.findForeignPairing(db, B, forged);
ok(prev && prev.user_id === A.id, 'B tra được gateway đang thuộc A');
ok(P.checkTransferRequest(db, B, forged).error === 'invalid_proof', 'không giữ khoá riêng → invalid_proof');

// B xin → chờ, chưa chuyển
ok(P.checkTransferRequest(db, B, GW.registerBody(B.id, {})).ok, 'B giữ khoá riêng → được xin');
const t1 = await T.requestTransfer(db, B, prev, {});
ok(t1.status === 'transfer_pending' && t1.dueAt > Date.now(), 'tạo yêu cầu chờ, chưa chuyển');
ok(ownerOf() === A.id, 'trong lúc chờ gateway vẫn của A');
ok((await T.requestTransfer(db, B, prev, {})).transferId === t1.transferId, 'B xin lại → trả đúng yêu cầu cũ');
ok((await T.requestTransfer(db, C, prev, {})).error === 'transfer_in_progress', 'C không chen được khi đang có yêu cầu');

// A từ chối (qua bảng như endpoint reject) → B không xin lại được trong thời gian chờ
db.prepare("UPDATE gateway_transfers SET status = 'rejected', decided_at = ? WHERE id = ?").run(Date.now(), t1.transferId);
ok((await T.requestTransfer(db, B, prev, {})).error === 'transfer_rejected', 'bị từ chối → B không xin lại ngay được');
ok(ownerOf() === A.id, 'từ chối → vẫn của A');

// C xin, A duyệt → chuyển ngay
const t2 = await T.requestTransfer(db, C, prev, {});
ok(t2.status === 'transfer_pending', 'C xin');
const done = await T.completeTransfer(db, t2.transferId, { reason: 'approved' });
ok(done.ok && ownerOf() === C.id, 'A duyệt → gateway thuộc C');
ok((await T.completeTransfer(db, t2.transferId)).error === 'not_found', 'không chạy lại được lần hai');
ok(!P.findForeignPairing(db, C, GW.registerBody(C.id, {})), 'C đăng ký lại = gateway của chính mình (không còn là đổi chủ)');

// Hết hạn chờ → bộ quét tự chuyển; yêu cầu cũ mà gateway đã đổi chủ → huỷ
const prev2 = P.findForeignPairing(db, A, GW.registerBody(A.id, {}));
const t3 = await T.requestTransfer(db, A, prev2, {});
db.prepare('UPDATE gateway_transfers SET due_at = ? WHERE id = ?').run(Date.now() - 1, t3.transferId);
await T.sweepTransfers(db);
ok(ownerOf() === A.id, 'hết hạn chờ, C không từ chối → tự chuyển về A');
db.prepare("INSERT INTO gateway_transfers (id, pairing_id, site, device, from_user, to_user, status, created_at, due_at) VALUES ('gt_stale', ?, ?, ?, ?, ?, 'pending', 0, 0)").run(prev2.id, reg.site, reg.device, C.id, B.id);
ok((await T.completeTransfer(db, 'gt_stale')).error === 'gateway_changed', 'yêu cầu cũ (chủ đã đổi) → huỷ, không chuyển');
ok(ownerOf() === A.id, 'vẫn của A');

// Chủ cũ bị khoá tài khoản → chuyển ngay (không có ai để hỏi)
db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(A.id);
const prev3 = P.findForeignPairing(db, B, GW.registerBody(B.id, {}));
db.prepare("UPDATE gateway_transfers SET decided_at = 0 WHERE status = 'rejected'").run();
const t4 = await T.requestTransfer(db, B, prev3, {});
ok(t4.status === 'transfer_done' && ownerOf() === B.id, 'chủ cũ bị khoá → chuyển ngay');

console.log(failed ? `\n${failed} FAIL` : '\nall ok');
process.exit(failed ? 1 : 0);
