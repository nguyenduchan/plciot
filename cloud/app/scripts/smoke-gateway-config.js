#!/usr/bin/env node
// Dynamic Discovery: <base>/config → upsert → user_devices → dashboard widgets; telemetry `data` alias.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyGatewayConfig, getGatewayConfig, sanitizeConfig } from '../src/gatewayConfig.js';
import { migrateUserDevices, getDashboardFor } from '../src/userDevices.js';
import { widgetsFromFields } from '../src/uiContract.js';
import { normalizeTelemetryPayload } from '../src/telemetryNormalize.js';
import { parseTopic, KINDS } from '../src/contract.js';
import { userAclBlock, deviceAclBlock } from '../src/mqttProvision.js';

let fails = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { fails++; console.error('FAIL', m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwcfg-'));
// schema THẬT của server (openDb) — bảng tự dựng tay cũ lệch dần (thiếu tenant_id, claimed_by…) và làm test hỏng
process.env.DATA_DIR = tmp;
const { openDb } = await import('../src/db.js');
const db = openDb(tmp);
db.prepare(`INSERT INTO users (id, username, password_hash, folder_path, role, notify_site, notify_device) VALUES
  (1, 'u1', 'x', 'f', 'operator', 'tram1', 'GW01'), (2, 'u2', 'x', 'f', 'operator', 'other', 'GW99')`).run();
migrateUserDevices(db);

const cfg = (devs) => ({ gw: 'GW01', devices: devs });
const bienap = { id: 'bien_ap_01', name: 'Biến áp', fields: [
  { key: 'temp', lbl: 'Nhiệt độ dầu', unit: '°C', widget: 'gauge' },
  { key: 'volt', lbl: 'Điện áp', unit: 'V', widget: 'chart' }] };
const quat = { id: 'quat_hut_02', name: 'Quạt hút', fields: [
  { key: 'status', lbl: 'Trạng thái', widget: 'led_status' },
  { key: 'control', lbl: 'Điều khiển', widget: 'switch', writable: true },
  { key: 'ro', lbl: 'Chỉ đọc', widget: 'switch' }] };

const GID = 'a'.repeat(16);   // id MQTT ngẫu nhiên của gateway
ok(KINDS.includes('config') && parseTopic(`gw/${GID}/config`)?.kind === 'config', 'topic kind config');
ok(userAclBlock('u1', [GID], 'operator').includes('/config'), 'user ACL đọc config');
ok(deviceAclBlock('g', { mqttId: GID }).includes(`write gw/${GID}/config`), 'device ACL ghi config');
ok(normalizeTelemetryPayload({ gw: 'x', ts: 1, data: { a: { v: 1 } } }).d.a.v === 1, 'telemetry `data` = `d`');
ok(sanitizeConfig({ devices: 'x' }).error === 'config_devices_missing', 'reject devices sai kiểu');
ok(sanitizeConfig({ devices: [{ id: 'bad id!', fields: [] }, { id: 'a', fields: [{ key: 'k k' }, { key: 'v', widget: 'zzz' }] }] }).devices[0].fields[0].widget === 'kpi', 'id/key xấu bị bỏ, widget lạ → kpi');

let r = applyGatewayConfig(db, { site: 'tram1', device: 'GW01', payload: cfg([bienap, quat]) });
ok(r.changed && r.rev === 1 && r.added === 2, 'config đầu: rev1, thêm 2 thiết bị');
let dash = getDashboardFor(db, { id: 1, notify_site: 'tram1', notify_device: 'GW01' }, 'simple');
ok(dash.devices.length === 2, 'dashboard có 2 thiết bị');
const fan = dash.devices.find((d) => d.childId === 'quat_hut_02');
const ba = dash.devices.find((d) => d.childId === 'bien_ap_01');
ok(ba.widgets.find((w) => w.bind === 'temp').kind === 'gauge' && ba.widgets.find((w) => w.bind === 'volt').kind === 'line', 'gauge/chart → widget');
ok(fan.widgets.find((w) => w.bind === 'control').kind === 'toggle' && fan.widgets.find((w) => w.bind === 'control').cmd.key === 'control', 'switch writable → toggle có cmd');
ok(fan.widgets.find((w) => w.bind === 'ro').kind === 'status', 'switch không writable → status (không điều khiển)');
ok(fan.source.path === 'd.quat_hut_02', 'bind telemetry theo d.<id>');

// phản hồi thật: fb chỉ giữ cho field ghi được, đúng dạng khoá, khác chính nó
const fbCfg = sanitizeConfig({ devices: [{ id: 'm1', fields: [
  { key: 'run', widget: 'switch', writable: true, fb: 'di1' },
  { key: 'ro', widget: 'switch', fb: 'di1' },
  { key: 'self', widget: 'switch', writable: true, fb: 'self' },
  { key: 'bad', widget: 'switch', writable: true, fb: 'x y!' }] }] }).devices[0].fields;
ok(fbCfg[0].fb === 'di1', 'fb hợp lệ đi qua sanitize');
ok(!('fb' in fbCfg[1]) && !('fb' in fbCfg[2]) && !('fb' in fbCfg[3]), 'fb bị bỏ: field chỉ đọc / trỏ chính nó / khoá xấu');
ok(widgetsFromFields(fbCfg).find((w) => w.bind === 'run').fb === 'di1', 'toggle mang fb xuống widget');

ok(applyGatewayConfig(db, { site: 'tram1', device: 'GW01', payload: cfg([bienap, quat]) }).changed === false, 'gửi lại y hệt → không đổi');
r = applyGatewayConfig(db, { site: 'tram1', device: 'GW01', payload: cfg([bienap]) });
ok(r.changed && r.rev === 2 && r.removed === 1, 'bớt thiết bị → rev2, gỡ 1');
dash = getDashboardFor(db, { id: 1, notify_site: 'tram1', notify_device: 'GW01' }, 'simple');
ok(dash.devices.length === 1 && dash.devices[0].childId === 'bien_ap_01', 'dashboard còn 1');
ok(getDashboardFor(db, { id: 2, notify_site: 'other', notify_device: 'GW99' }).devices.length === 0, 'user khác gateway không bị ảnh hưởng');
ok(getGatewayConfig(db, { site: 'tram1', device: 'GW01' }).devices.length === 1, 'getGatewayConfig');

// thiết bị gắn bằng QR (type khác) không bị config gỡ
db.prepare("INSERT INTO user_devices (id,user_id,site,gateway_device,child_id,type,created_at) VALUES ('ud_x',1,'tram1','GW01','pump1','pump',1)").run();
applyGatewayConfig(db, { site: 'tram1', device: 'GW01', payload: cfg([bienap, quat]) });
ok(db.prepare("SELECT 1 FROM user_devices WHERE id='ud_x'").get(), 'thiết bị QR giữ nguyên');

// Kiểu UI do gateway khai báo (icon, màu, bồn, chữ Bật/Tắt, ngưỡng) phải tới dashboard nguyên vẹn
const bon = { id: 'bon1', name: 'Bồn nước', icon: 'tank', color: 'blue', fields: [
  { key: 'level', lbl: 'Mức nước', unit: '%', widget: 'tank', min: 0, max: 100, low: 15, high: 92 },
  { key: 'run', lbl: 'Bơm', widget: 'switch', writable: true, on: 'Đang chạy', off: 'Dừng' }] };
const san = sanitizeConfig({ devices: [{ ...bon, icon: 'bad icon!', color: 'pink' }] }).devices[0];
ok(san.icon === undefined && san.color === undefined, 'icon/màu lạ bị bỏ');
applyGatewayConfig(db, { site: 'tram1', device: 'GW01', payload: cfg([bienap, bon]) });
dash = getDashboardFor(db, { id: 1, notify_site: 'tram1', notify_device: 'GW01' }, 'simple');
const bn = dash.devices.find((d) => d.childId === 'bon1');
ok(bn.icon === 'tank' && bn.color === 'blue', 'dashboard mang icon + màu của thiết bị');
const lv = bn.widgets.find((w) => w.bind === 'level');
ok(lv.kind === 'tank' && lv.low === 15 && lv.high === 92 && lv.max === 100, 'bồn giữ kiểu tank + ngưỡng thấp/cao');
const rn = bn.widgets.find((w) => w.bind === 'run');
ok(rn.kind === 'toggle' && rn.onText === 'Đang chạy' && rn.offText === 'Dừng', 'chữ Bật/Tắt do người dùng đặt');

// Hai gateway CÙNG site (mọi gateway của một tài khoản chung site u<id>) trùng id thiết bị con: mỗi gateway giữ thẻ riêng
db.prepare("INSERT INTO hardware_devices (site, device, claim_hash, claimed_by, created_at) VALUES ('tram1','GW02','x',1,1)").run();
const pumpA = { id: 'pumpx', name: 'Bơm A', fields: [{ key: 'run', widget: 'switch', writable: true }] };
const pumpB = { id: 'pumpx', name: 'Bơm B', fields: [{ key: 'run', widget: 'switch', writable: true }] };
applyGatewayConfig(db, { site: 'tram1', device: 'GW01', payload: cfg([bienap, pumpA]) });
applyGatewayConfig(db, { site: 'tram1', device: 'GW02', payload: { gw: 'GW02', devices: [pumpB] } });
applyGatewayConfig(db, { site: 'tram1', device: 'GW01', payload: cfg([bienap, { ...pumpA, name: 'Bơm A2' }]) });
const pumps = db.prepare("SELECT gateway_device g, title FROM user_devices WHERE user_id = 1 AND child_id = 'pumpx' ORDER BY g").all();
ok(pumps.length === 2 && pumps[0].g === 'GW01' && pumps[0].title === 'Bơm A2' && pumps[1].g === 'GW02' && pumps[1].title === 'Bơm B', 'trùng id thiết bị con ở 2 gateway: 2 thẻ riêng, không giành nhau');

// Migration DB cũ (khoá user/site/child) → khoá thêm gateway: giữ dữ liệu, giữ bảng cũ
{
  const Database = (await import('better-sqlite3')).default;
  const old = new Database(':memory:');
  old.exec(`CREATE TABLE user_devices (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, site TEXT NOT NULL, gateway_device TEXT NOT NULL,
    child_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT, binds TEXT, created_at INTEGER NOT NULL, critical_keys TEXT, UNIQUE(user_id, site, child_id))`);
  old.prepare("INSERT INTO user_devices VALUES ('ud_a',1,'s','gw02','pump1','dynamic','A',NULL,1,'[\"run\"]')").run();
  const { migrateUserDevices: mig } = await import('../src/userDevices.js');
  try { mig(old); } catch { /* bảng phụ (gateway_configs…) không có trong DB thử: phần đổi khoá chạy sau cùng */ }
  const uq = old.prepare("PRAGMA index_list('user_devices')").all().filter((i) => i.unique && i.origin === 'u')
    .map((i) => old.prepare(`PRAGMA index_info('${i.name}')`).all().map((c) => c.name).join(','));
  ok(uq.includes('user_id,site,gateway_device,child_id') && !uq.includes('user_id,site,child_id'), 'migration: khoá mới có gateway_device');
  ok(old.prepare("SELECT critical_keys FROM user_devices WHERE id = 'ud_a'").get()?.critical_keys === '["run"]', 'migration: giữ dữ liệu');
  ok(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'user_devices_v6_old'").get(), 'migration: bảng cũ được giữ');
  old.prepare("INSERT INTO user_devices (id,user_id,site,gateway_device,child_id,type,created_at) VALUES ('ud_b',1,'s','gw03','pump1','dynamic',2)").run();
  ok(old.prepare("SELECT COUNT(*) n FROM user_devices WHERE child_id='pump1'").get().n === 2, 'migration: gateway khác thêm được pump1');
  mig(old);   // chạy lại (deploy lần sau) không làm gì
  ok(old.prepare("SELECT COUNT(*) n FROM user_devices").get().n === 2, 'migration chạy lại an toàn');
}

// ID gateway do hệ thống cấp theo mã phần cứng; tên hiển thị tách riêng
{
  const { gatewayIdFor } = await import('../src/gatewayPairing.js');
  const { setGatewayName, gatewayName, cleanName, defaultGatewayName } = await import('../src/gatewayNames.js');
  const id1 = gatewayIdFor(db, 'u9', 'ABCDEFGHIJKLMNOPQRST');
  ok(id1 === 'gabcdefghij', 'ID theo mã phần cứng: g + 10 ký tự');
  db.prepare("INSERT INTO hardware_devices (site, device, claim_hash, created_at) VALUES ('u9', ?, 'x', 1)").run(id1);
  ok(gatewayIdFor(db, 'u9', 'ABCDEFGHIJZZZZZZZZZZ') === 'gabcdefghijzz', 'trùng tiền tố → lấy dài thêm');
  ok(gatewayIdFor(db, 'u9', '') === null, 'không có mã phần cứng → không cấp');
  defaultGatewayName(db, 'u9', id1, 2);
  ok(gatewayName(db, 'u9', id1) === 'Gateway 2', 'tên mặc định Gateway N');
  setGatewayName(db, { site: 'u9', device: id1, name: '  Trạm   bơm <b>1</b> ' });
  ok(gatewayName(db, 'u9', id1) === 'Trạm bơm b1/b', 'tên được làm sạch');
  defaultGatewayName(db, 'u9', id1, 3);
  ok(gatewayName(db, 'u9', id1) === 'Trạm bơm b1/b', 'tên đã đặt không bị ghi đè');
  ok(cleanName('x'.repeat(80)).length === 40, 'tên tối đa 40 ký tự');
  setGatewayName(db, { site: 'u9', device: id1, name: '' });
  ok(gatewayName(db, 'u9', id1) === '', 'xoá tên → hiện ID');
  const { gatewaysOfUser } = await import('../src/mqttIds.js');
  setGatewayName(db, { site: 'tram1', device: 'GW01', name: 'Nhà máy' });
  ok(gatewaysOfUser(db, { id: 1, notify_site: 'tram1', notify_device: 'GW01' }).find((g) => g.device === 'GW01')?.name === 'Nhà máy', 'danh sách gateway mang tên hiển thị');
  ok(getDashboardFor(db, { id: 1, notify_site: 'tram1', notify_device: 'GW01' }, 'simple').gateways.find((g) => g.device === 'GW01')?.name === 'Nhà máy', 'dashboard webapp mang tên hiển thị');
}

console.log(fails ? `FAILED ${fails}` : 'gateway-config smoke OK');
process.exit(fails ? 1 : 0);
