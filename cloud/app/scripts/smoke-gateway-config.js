#!/usr/bin/env node
// Dynamic Discovery: <base>/config → upsert → user_devices → dashboard widgets; telemetry `data` alias.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyGatewayConfig, getGatewayConfig, sanitizeConfig } from '../src/gatewayConfig.js';
import { migrateUserDevices, getDashboardFor } from '../src/userDevices.js';
import { normalizeTelemetryPayload } from '../src/telemetryNormalize.js';
import { parseTopic, KINDS } from '../src/contract.js';
import { userAclBlock, deviceAclBlock } from '../src/mqttProvision.js';

let fails = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { fails++; console.error('FAIL', m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwcfg-'));
const db = new Database(path.join(tmp, 't.db'));
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, notify_site TEXT, notify_device TEXT);
  CREATE TABLE hardware_devices (site TEXT, device TEXT, ui_meta TEXT);`);
db.prepare("INSERT INTO users (id, notify_site, notify_device) VALUES (1,'tram1','GW01'),(2,'other','GW99')").run();
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

console.log(fails ? `FAILED ${fails}` : 'gateway-config smoke OK');
process.exit(fails ? 1 : 0);
