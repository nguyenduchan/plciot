#!/usr/bin/env node
/**
 * Gateway no-code (mua sẵn) giai đoạn 1 — docs/NOCODE-GATEWAY.md.
 *  1) nocodeMap: đường dẫn, chống prototype, đổi kiểu, map object/list, scale/offset, ts.
 *  2) nocode.js trên DB thật: tạo (tem + MQTT + claim), ACL chỉ kênh mã hoá, raw → telemetry chuẩn,
 *     status online/offline, ánh xạ → config/dashboard, quyền chủ, hạn mức.
 * Chạy: node scripts/smoke-nocode.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fails = 0;
const ok = (c, m) => { if (c) console.log('OK', m); else { fails++; console.error('FAIL', m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nocode-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'mqtt');
process.env.MQTT_PUBLIC_HOST = 'mqtt.example.test';
process.env.MQTT_PUBLIC_MQTTS_PORT = '48263';
process.env.USER_MAX_GATEWAYS = '2';
process.env.SHARD_CONTAINER = 'nocode-smoke-no-such-container';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.MQTT_CONFIG_DIR, { recursive: true });

const { generateClaimRootKeyPair } = await import('@plciot/security');
const keys = generateClaimRootKeyPair();
process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
const M = await import('../src/nocodeMap.js');

/* ---------- 1. ánh xạ thuần ---------- */
ok(JSON.stringify(M.parsePath("$.data.I1[2]['a b']")) === JSON.stringify(['data', 'I1', 2, 'a b']), 'parsePath đủ dạng');
ok(M.parsePath('data.x') === null && M.parsePath('$..x') === null && M.parsePath('$[*]') === null, 'parsePath từ chối cú pháp lạ');
ok(M.parsePath('$.__proto__.x') === null && M.parsePath("$['constructor']") === null, 'parsePath chặn __proto__/constructor');
ok(M.parsePath('$' + '.a'.repeat(9)) === null, 'parsePath giới hạn độ sâu');
ok(M.readPath({ a: [1, { b: 5 }] }, ['a', 1, 'b']) === 5 && M.readPath({}, ['toString']) === undefined, 'readPath chỉ thuộc tính riêng');
ok(M.toNumber('12.5') === 12.5 && M.toNumber(true) === 1 && M.toNumber('OFF') === 0 && M.toNumber('run') === 1, 'toNumber chuỗi/bool');
ok(M.toNumber('abc') === undefined && M.toNumber(null) === undefined && M.toNumber(NaN) === undefined && M.toNumber({}) === undefined, 'toNumber từ chối');
ok(M.toEpochMs(1700000000) === 1700000000000 && M.toEpochMs(1700000000000) === 1700000000000 && M.toEpochMs('2026-01-01T00:00:00Z') === Date.parse('2026-01-01T00:00:00Z'), 'toEpochMs giây/ms/chuỗi');

ok(M.sanitizeMap(null).error === 'map_not_object' && M.sanitizeMap({}).error === 'map_devices_missing', 'sanitizeMap thiếu devices');
ok(M.sanitizeMap({ devices: [{ id: 'a', fields: [{ key: 'k', path: 'nope' }] }] }).error === 'map_bad_path', 'sanitizeMap path sai');
ok(M.sanitizeMap({ mode: 'list', list: '$.v', devices: [{ id: 'a', fields: [{ key: 'k' }] }] }).error === 'map_bad_point_name', 'sanitizeMap list thiếu name');
ok(M.sanitizeMap({ ts: 'x', devices: [] }).error === 'map_bad_ts_path', 'sanitizeMap ts sai');
const sm = M.sanitizeMap({ devices: [{ id: 'bom1', name: 'Bơm', fields: [
  { key: 'dong', lbl: 'Dòng', unit: 'A', widget: 'gauge', path: '$.data.I1', scale: 0.1, writable: true },
  { key: 'chay', widget: 'led_status', path: '$.data.DI1' }] }] });
ok(sm.ok && sm.map.devices[0].fields[0].scale === 0.1 && !sm.map.devices[0].fields[0].writable, 'sanitizeMap giữ scale, bỏ writable (chỉ giám sát)');
ok(sm.ok && !('path' in sm.config.devices[0].fields[0]) && sm.config.devices[0].fields[0].unit === 'A', 'config sinh từ map không có thuộc tính trích xuất');
const a1 = M.applyMap(sm.map, { data: { I1: 123, DI1: 'on' } });
ok(a1.n === 2 && a1.d.bom1.dong === 12.3 && a1.d.bom1.chay === 1, 'applyMap object + scale');
const a2 = M.applyMap(sm.map, { data: { I1: 'x' } });
ok(a2.n === 0 && a2.bad.includes('bom1.dong') && a2.bad.includes('bom1.chay'), 'applyMap báo field không đọc được');
const lm = M.sanitizeMap({ mode: 'list', list: '$.values', name: 'n', value: 'v', ts: '$.time',
  devices: [{ id: 'tram', fields: [{ key: 'ap', name: 'P1', offset: -1 }, { key: 'nhiet', name: 'T1' }] }] });
const a3 = M.applyMap(lm.map, { time: 1700000000, values: [{ n: 'P1', v: 3 }, { n: 'T1', v: '25.5' }, { n: 'X', v: 9 }] });
ok(a3.n === 2 && a3.d.tram.ap === 2 && a3.d.tram.nhiet === 25.5 && a3.ts === 1700000000000, 'applyMap list + offset + ts');

/* ---------- 2. nocode.js trên DB ---------- */
const { openDb } = await import('../src/db.js');
const db = openDb(process.env.DATA_DIR);
const N = await import('../src/nocode.js');
const { migrateUserDevices, getDashboardFor } = await import('../src/userDevices.js');
const { migrateGatewayNames } = await import('../src/gatewayNames.js');
const { rebuildAclFromUsers } = await import('../src/mqttProvision.js');
migrateUserDevices(db); migrateGatewayNames(db); N.migrateNocode(db);
db.prepare(`INSERT INTO users (id, username, password_hash, folder_path, role) VALUES
  (11, 'chu', 'x', 'f', 'operator'), (12, 'nguoikhac', 'x', 'f', 'operator'), (13, 'quantri', 'x', 'f', 'admin')`).run();
const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

// Ngữ cảnh gọi = chủ của gateway PC + chính gateway PC (cài đặt no-code chỉ qua GatewayApp)
const ctxA = { user: user(11), parent: { site: 'u11', device: 'gpc0000001' } };
const ctxA2 = { user: user(11), parent: { site: 'u11', device: 'gpc0000002' } };   // PC khác cùng chủ
const ctxB = { user: user(12), parent: { site: 'u12', device: 'gpc0000003' } };
const ctxAdmin = { user: user(13), parent: { site: 'u13', device: 'gpc0000004' } };
const sent = [];
N.setNocodePublisher(async (mqttId, kind, payload, opts) => { sent.push({ mqttId, kind, payload, retain: opts?.retain }); });
const flush = () => new Promise((r) => setTimeout(r, 5));

const c = await N.createNocodeGateway(db, ctxA, { name: 'Trạm bơm 2', ip: '127.0.0.1' });
ok(c.ok, `tạo gateway no-code ${c.error || ''}`);
const { site, device } = c;
ok(site === 'u11' && /^gnc[0-9a-f]{8}/.test(device), 'site theo tài khoản, ID do hệ thống cấp');
ok(c.sheet?.password && c.sheet.host === 'mqtt.example.test' && c.sheet.port === 48263, 'phiếu cấu hình có mật khẩu + host/cổng MQTTS');
const dev = db.prepare('SELECT * FROM devices WHERE site = ? AND device = ?').get(site, device);
ok(dev && c.sheet.topics.publish === `gw/${dev.mqtt_id}/raw` && c.sheet.lwt.topic === `gw/${dev.mqtt_id}/status`, 'topic raw + LWT status theo mqttId');
const hw = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(site, device);
ok(hw?.claimed_by === 11 && /^nc/.test(hw.activated_hw || '') && !hw.gw_pubkey, 'tem claim cho người tạo, gắn hw ngẫu nhiên, không khoá máy');
const gname = db.prepare('SELECT name FROM gateway_names WHERE site = ? AND device = ?').get(site, device)?.name;
ok(gname === 'Trạm bơm 2', 'tên hiển thị');

rebuildAclFromUsers(db);
const acl = fs.readFileSync(path.join(process.env.MQTT_CONFIG_DIR, 'acl'), 'utf8');
const aclMon = fs.readFileSync(path.join(process.env.MQTT_CONFIG_DIR, 'acl-monitor'), 'utf8');
const block = (new RegExp(`(?:^|\\n)user ${dev.mqtt_user}\\n((?:topic .*\\n)*)`).exec(acl) || [])[1] || '';
ok(block.includes(`topic write gw/${dev.mqtt_id}/raw`) && block.includes(`topic write gw/${dev.mqtt_id}/status`), 'ACL no-code ghi raw + status');
ok(!block.includes('/telemetry') && !block.includes('/config') && !/read gw\/[0-9a-f]+\/cmd\n/.test(block), 'ACL no-code KHÔNG ghi telemetry/config, KHÔNG đọc cmd');
ok(!aclMon.includes(`user ${dev.mqtt_user}`), 'no-code không có trên kênh không mã hoá');
ok(/user ctl\n(?:topic write .*\n)*topic write gw\/\+\/telemetry/.test(acl), 'ctl được phát telemetry thay gateway');
ok(/user ingest\n(?:topic read .*\n)*topic read gw\/\+\/raw/.test(acl), 'ingest đọc raw');

const parsed = { mqttId: dev.mqtt_id, site, device, kind: 'raw' };
const T0 = Date.now();
let r = N.onNocodeRaw(db, parsed, Buffer.from(JSON.stringify({ data: { I1: 100, DI1: 1 } })), T0);
await flush();
ok(r.ok && !Object.keys(r.d).length, 'chưa có ánh xạ: nhận nhưng chưa phát telemetry');
ok(sent.some((s) => s.kind === 'status' && s.payload === 'online' && s.retain), 'có raw → server phát online (retain)');
ok(!sent.some((s) => s.kind === 'telemetry'), 'chưa phát telemetry khi chưa có ánh xạ');
ok(N.getNocodeGateway(db, ctxA, device).lastRaw?.text.includes('I1'), 'chủ xem được bản tin gần nhất');
ok(N.getNocodeGateway(db, ctxB, device).error === 'not_owner', 'người khác không xem được');
ok(N.getNocodeGateway(db, ctxA2, device).error === 'not_owner', 'gateway PC khác (cùng chủ) không quản lý được gateway no-code của PC này');
ok(db.prepare('SELECT parent_device FROM nocode_gateways WHERE device = ?').get(device).parent_device === 'gpc0000001', 'ghi gateway PC đã tạo');
ok(N.getNocodeGateway(db, ctxA, device).sheet?.password === undefined, 'phiếu xem lại không có mật khẩu');

const map = { devices: [{ id: 'bom1', name: 'Bơm 1', fields: [
  { key: 'dong', lbl: 'Dòng', unit: 'A', widget: 'gauge', path: '$.data.I1', scale: 0.1 },
  { key: 'chay', lbl: 'Chạy', widget: 'led_status', path: '$.data.DI1' }] }] };
const pv = N.previewNocodeMap(db, ctxA, device, { map });
ok(pv.ok && pv.d.bom1.dong === 10, 'xem thử trên bản tin gần nhất');
ok((await N.saveNocodeMap(db, ctxB, device, map)).error === 'not_owner', 'người khác không lưu được ánh xạ');
const sv = await N.saveNocodeMap(db, ctxA, device, map);
await flush();
ok(sv.ok && sv.rev === 1 && sv.config?.devices?.[0]?.id === 'bom1', 'lưu ánh xạ → config gateway');
ok(sent.some((s) => s.kind === 'config' && s.retain && s.payload.devices[0].fields.every((f) => !f.path)), 'phát config retain (không lộ path)');
const dash = getDashboardFor(db, user(11), 'simple');
ok(dash.devices.some((d) => d.childId === 'bom1' && d.widgets.length === 2), 'dashboard có thiết bị + 2 widget từ ánh xạ');

sent.length = 0;
r = N.onNocodeRaw(db, parsed, Buffer.from(JSON.stringify({ data: { I1: 123, DI1: 'off' } })), T0 + 1000);
await flush();
const tel = sent.find((s) => s.kind === 'telemetry');
ok(r.ok && tel?.retain && tel.payload.schema === 2 && tel.payload.d.bom1.dong === 12.3 && tel.payload.d.bom1.chay === 0, 'raw → telemetry chuẩn {schema:2,d} retain');
sent.length = 0;
r = N.onNocodeRaw(db, parsed, Buffer.from(JSON.stringify({ data: { I1: 123, DI1: 'off' } })), T0 + 2000);
await flush();
ok(r.skipped && !sent.some((s) => s.kind === 'telemetry'), 'giá trị không đổi trong 10 s: không phát lại');
r = N.onNocodeRaw(db, parsed, Buffer.from('không phải json'), T0 + 3000);
ok(!r.ok && r.reason === 'invalid_json', 'bản tin không phải JSON bị bỏ');

// Gói bù: ánh xạ có ts, mốc cũ → bf:1, không retain
await N.saveNocodeMap(db, ctxA, device, { ...map, ts: '$.t' });
sent.length = 0;
N.onNocodeRaw(db, parsed, Buffer.from(JSON.stringify({ t: Math.floor((T0 - 3600_000) / 1000), data: { I1: 50, DI1: 1 } })), T0 + 4000);
await flush();
const bf = sent.find((s) => s.kind === 'telemetry');
ok(bf && bf.payload.bf === 1 && !bf.retain && bf.payload.ts < T0, 'mốc thời gian cũ → gói bù bf:1, không retain');

// Offline do im lặng
sent.length = 0;
ok(N.sweepNocodeOffline(T0 + 5000) === 0, 'mới gửi: chưa offline');
const swept = N.sweepNocodeOffline(T0 + 200_000);
await flush();
ok(swept === 1 && sent.some((s) => s.kind === 'status' && s.payload === 'offline' && s.retain), 'im lặng quá lâu → server phát offline');
N.onNocodeStatus(db, parsed, 'offline');
sent.length = 0;
N.onNocodeRaw(db, parsed, Buffer.from(JSON.stringify({ data: { I1: 1, DI1: 1 } })), T0 + 210_000);
await flush();
ok(sent.some((s) => s.kind === 'status' && s.payload === 'online'), 'có lại raw → online');

// Chống dồn
let limited = 0;
for (let i = 0; i < 200; i++) if (N.onNocodeRaw(db, parsed, Buffer.from('{}'), T0 + 220_000).reason === 'rate_limited') limited += 1;
ok(limited > 0, 'quá NOCODE_RAW_PER_MIN/phút → bỏ');

// Gateway thường không đi đường raw
const other = { mqttId: 'b'.repeat(16), site: 'x', device: 'y', kind: 'raw' };
ok(N.onNocodeRaw(db, other, Buffer.from('{}')).reason === 'not_nocode', 'gateway không phải no-code: raw bị bỏ');

/* ---------- 3. điều khiển (giai đoạn 4, USR-N720 rw_prot) ---------- */
ok(M.sanitizeMap({ control: 'abc', devices: [] }).error === 'map_bad_control', 'control lạ bị từ chối');
const noCtl = M.sanitizeMap({ devices: [{ id: 'b', fields: [{ key: 'run', widget: 'switch', writable: true, point: 'node0105' }] }] });
ok(noCtl.error === 'map_bad_path', 'không có control: field ghi vẫn phải có path (writable bị bỏ)');
const ctlMap = { control: 'usr_rw_prot', devices: [{ id: 'bom1', name: 'Bơm 1', fields: [
  { key: 'dong', lbl: 'Dòng', unit: 'A', widget: 'gauge', path: '$.data.I1', scale: 0.1 },
  { key: 'chay', lbl: 'Chạy', widget: 'led_status', path: '$.data.DI1' },
  { key: 'lenh', lbl: 'Bật bơm', widget: 'switch', writable: true, point: 'node0105', toggleMs: 3000 }] }] };
const cm = M.sanitizeMap(ctlMap);
ok(cm.ok && cm.map.control.preset === 'usr_rw_prot' && cm.map.control.valueType === 'string' && cm.map.control.timeoutMs === 8000, 'control mặc định: chuỗi, chờ 8 s');
const fl = cm.map.devices[0].fields;
ok(fl.find((f) => f.key === 'lenh').writable && fl.find((f) => f.key === 'lenh').point === 'node0105' && !fl.find((f) => f.key === 'lenh').path, 'field ghi có point, không cần path');
const cfgLenh = cm.config.devices[0].fields.find((f) => f.key === 'lenh');
ok(cfgLenh.writable && cfgLenh.toggleMs === 3000 && !('point' in cfgLenh), 'config: writable + toggleMs, không lộ point');
ok(M.sanitizeMap({ ...ctlMap, devices: [{ id: 'x', fields: [{ key: 'k', widget: 'switch', writable: true }] }] }).error === 'map_bad_path', 'writable thiếu point → coi như field đọc, phải có path');
ok(M.applyMap(cm.map, { data: { I1: 1, DI1: 1 } }).bad.length === 0, 'field chỉ ghi không bị tính là đọc lỗi');
ok(JSON.stringify(M.renderCommand(cm.map.control, { id: 'a1', point: 'node0105', v: 1 })) === '{"rw_prot":{"Ver":"1.0.1","dir":"down","id":"a1","w_data":[{"name":"node0105","value":"1"}]}}', 'renderCommand đúng mẫu sổ tay N720');
ok(M.renderCommand({ preset: 'usr_rw_prot', valueType: 'number' }, { id: 'a', point: 'p', v: 2 }).rw_prot.w_data[0].value === 2, 'valueType number');
ok(M.parseReply(cm.map.control, { rw_prot: { Ver: '1.0.1', dir: 'up', id: 'a1', w_data: [{ name: 'node0105', value: '1', err: '0' }] } }).ok === true, 'parseReply err 0 → ok');
ok(M.parseReply(cm.map.control, { rw_prot: { Ver: '1.0.1', dir: 'up', id: 'a1', w_data: [{ name: 'node0105', value: '0', err: '1' }] } }).err === 'write_failed', 'parseReply err 1 → write_failed');
ok(M.parseReply(cm.map.control, { rw_prot: { Ver: '1.0.1', dir: 'up', err: '1' } }).id === null, 'parseReply lỗi giao thức không có id');
ok(M.parseReply(cm.map.control, { rw_prot: { dir: 'down', id: 'x' } }) === null, 'parseReply bỏ bản tin dir=down');

const { publishCmd, setCmdInterceptor, setPublisher } = await import('../src/controlPublisher.js');
const plain = [];
setPublisher(async (_s, _d, raw, opts) => { plain.push({ raw, opts }); return { topic: 'plain' }; });
setCmdInterceptor((id, payload) => N.handleNocodeCmd(db, id, payload));
await N.saveNocodeMap(db, ctxA, device, map);   // về ánh xạ không có điều khiển
N.resetNocodeState();
sent.length = 0;
let pc = await publishCmd(site, device, { id: 'c0', child: 'bom1', key: 'lenh', v: 1 }, { mqttId: dev.mqtt_id });
await flush();
ok(pc.rejected === 'control_disabled' && sent.some((x) => x.kind === 'ack' && x.payload.id === 'c0' && x.payload.err === 'control_disabled') && !plain.length, 'chưa bật điều khiển: ack lỗi, không gửi cmd');
const svc = await N.saveNocodeMap(db, ctxA, device, ctlMap);
ok(svc.ok && svc.config.devices[0].fields.some((f) => f.key === 'lenh' && f.writable), 'lưu ánh xạ có điều khiển → config writable');
const dash2 = getDashboardFor(db, user(11), 'simple');
ok(dash2.devices.find((d) => d.childId === 'bom1')?.widgets.some((w) => w.cmd?.key === 'lenh'), 'dashboard có nút điều khiển');
sent.length = 0;
pc = await publishCmd(site, device, { id: 'c1', child: 'bom1', key: 'lenh', v: 1 }, { mqttId: dev.mqtt_id });
const raw1 = sent.find((x) => x.kind === 'cmdraw');
ok(pc.nocode && raw1 && raw1.retain === false && raw1.payload.rw_prot.w_data[0].name === 'node0105' && raw1.payload.rw_prot.id === 'c1', 'lệnh → cmdraw rw_prot, không retain');
ok(!plain.length && !('sig' in raw1.payload) && !('sig' in raw1.payload.rw_prot), 'không đi cmd thường, không ký');
const pk = { mqttId: dev.mqtt_id, site, device, kind: 'ackraw' };
sent.length = 0;
let ar = N.onNocodeAckRaw(db, pk, Buffer.from(JSON.stringify({ rw_prot: { Ver: '1.0.1', dir: 'up', id: 'c1', w_data: [{ name: 'node0105', value: '1', err: '0' }] } })));
await flush();
ok(ar.ok && sent.some((x) => x.kind === 'ack' && x.payload.id === 'c1' && x.payload.ok === true), 'phản hồi err 0 → ack ok');
ar = N.onNocodeAckRaw(db, pk, Buffer.from(JSON.stringify({ rw_prot: { Ver: '1.0.1', dir: 'up', id: 'c1', w_data: [{ err: '0' }] } })));
ok(!ar.ok && ar.reason === 'unknown_id', 'phản hồi lặp lại bị bỏ');
await publishCmd(site, device, { id: 'c2', child: 'bom1', key: 'lenh', v: 0 }, { mqttId: dev.mqtt_id });
sent.length = 0;
N.onNocodeAckRaw(db, pk, Buffer.from(JSON.stringify({ rw_prot: { Ver: '1.0.1', dir: 'up', err: '1' } })));
await flush();
ok(sent.some((x) => x.kind === 'ack' && x.payload.id === 'c2' && x.payload.ok === false), 'lỗi giao thức không id → gán lệnh đang chờ cũ nhất');
sent.length = 0;
pc = await publishCmd(site, device, { id: 'c3', child: 'bom1', key: 'chay', v: 1 }, { mqttId: dev.mqtt_id });
await flush();
ok(pc.rejected === 'not_writable' && !sent.some((x) => x.kind === 'cmdraw'), 'field chỉ đọc: không gửi');
pc = await publishCmd(site, device, { id: 'c4', op: 'read', a: 1, n: 1 }, { mqttId: dev.mqtt_id });
ok(pc.rejected === 'not_supported', 'lệnh đọc thanh ghi: không hỗ trợ');
pc = await publishCmd(site, device, { sys: 'claimed' }, { mqttId: dev.mqtt_id });
ok(pc.skipped === 'sys', 'lệnh hệ thống (claimed) bỏ qua');
await N.saveNocodeMap(db, ctxA, device, { ...ctlMap, control: { preset: 'usr_rw_prot', timeoutMs: 1000 } });
sent.length = 0;
await publishCmd(site, device, { id: 'c5', child: 'bom1', key: 'lenh', v: 1 }, { mqttId: dev.mqtt_id });
await new Promise((r) => setTimeout(r, 1200));
ok(sent.some((x) => x.kind === 'ack' && x.payload.id === 'c5' && x.payload.err === 'no_confirm'), 'không phản hồi → ack no_confirm');
plain.length = 0;
pc = await publishCmd('x', 'y', { id: 'c6', a: 4, v: 1 }, { mqttId: 'c'.repeat(16) });
ok(pc.topic === 'plain' && plain.length === 1, 'gateway thường vẫn đi cmd có ký như cũ');
setCmdInterceptor(null); setPublisher(null);
const aclNow = (rebuildAclFromUsers(db), fs.readFileSync(path.join(process.env.MQTT_CONFIG_DIR, 'acl'), 'utf8'));
const blk = (new RegExp(`(?:^|\\n)user ${dev.mqtt_user}\\n((?:topic .*\\n)*)`).exec(aclNow) || [])[1] || '';
ok(blk.includes(`topic read gw/${dev.mqtt_id}/cmdraw`) && blk.includes(`topic write gw/${dev.mqtt_id}/ackraw`) && !blk.includes('/cmd\n'), 'ACL no-code: đọc cmdraw, ghi ackraw, không đọc cmd');
ok(/user ctl\n(?:topic write .*\n)*topic write gw\/\+\/cmdraw/.test(aclNow) && /user ctl\n(?:topic write .*\n)*topic write gw\/\+\/ack\n/.test(aclNow), 'ctl ghi cmdraw + ack');

// Xoay mật khẩu, quyền, hạn mức
const rot = N.rotateNocodePassword(db, ctxA, device);
ok(rot.ok && rot.sheet.password && rot.sheet.password !== c.sheet.password, 'xoay mật khẩu → mật khẩu mới');
ok(N.rotateNocodePassword(db, ctxB, device).error === 'not_owner', 'người khác không xoay được');
ok((await N.createNocodeGateway(db, ctxAdmin, { name: 'x' })).error === 'admin_cannot_own', 'admin không làm chủ gateway');
const { userGatewayLimit } = await import('../src/gatewayPairing.js');
const lim = userGatewayLimit(user(11));
let made = 1;
while (made < lim) { const cx = await N.createNocodeGateway(db, ctxA, { name: `GW ${made + 1}` }); ok(cx.ok && cx.device !== device, `gateway thứ ${made + 1} ${cx.error || ''}`); made += 1; }
ok((await N.createNocodeGateway(db, ctxA, { name: 'Quá hạn mức' })).error === 'too_many_gateways', `hạn mức gói (${lim} gateway)`);
ok(N.listNocodeGateways(db, ctxA).length === lim && N.listNocodeGateways(db, ctxB).length === 0, 'danh sách theo chủ');

/* ---------- 4. xác thực gateway PC bằng chữ ký khoá máy (route /api/v1/gateway/nocode/*) ---------- */
{
  const nodeCrypto = await import('node:crypto');
  const { parsePubkey, requestMessage, ensureKeyColumns } = await import('../src/gatewayKey.js');
  ensureKeyColumns(db);
  const kp = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubkey = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const pk = parsePubkey(pubkey);
  db.prepare(`INSERT INTO hardware_devices (site, device, claim_hash, claimed_by, created_at, gw_pubkey, activated_hw)
    VALUES ('u12', 'gpc0000003', 'x', 12, ?, ?, ?)`).run(Date.now(), pk.spki, pk.hw);
  const signed = (kind, extra = {}) => {
    const ts = Date.now();
    const sig = nodeCrypto.sign('sha256', Buffer.from(requestMessage(kind, 'u12', 'gpc0000003', ts)), { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { site: 'u12', device: 'gpc0000003', pubkey, ts, sig, ...extra };
  };
  const c1 = N.nocodeCaller(db, signed('nocode-list'), 'nocode-list');
  ok(c1.user?.id === 12 && c1.parent.device === 'gpc0000003', 'chữ ký đúng → ngữ cảnh = chủ của gateway PC');
  const body = signed('nocode-list');
  ok(!N.nocodeCaller(db, body, 'nocode-create').user, 'chữ ký cho thao tác khác bị từ chối');
  ok(N.nocodeCaller(db, signed('nocode-get-abc'), 'nocode-get-xyz').error === 'not_allowed', 'chữ ký gắn với đúng gateway no-code đích');
  const once = signed('nocode-list');
  N.nocodeCaller(db, once, 'nocode-list');
  ok(N.nocodeCaller(db, once, 'nocode-list').error === 'not_allowed', 'chữ ký dùng lại bị từ chối');
  const other = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const forged = { ...signed('nocode-list'), pubkey: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
  ok(N.nocodeCaller(db, forged, 'nocode-list').error === 'not_allowed', 'khoá khác của tem bị từ chối');
  db.prepare("UPDATE hardware_devices SET claimed_by = NULL WHERE site = 'u12' AND device = 'gpc0000003'").run();
  ok(N.nocodeCaller(db, signed('nocode-list'), 'nocode-list').error === 'gateway_unclaimed', 'gateway PC chưa có chủ: không tạo được');
  db.prepare(`INSERT INTO nocode_gateways (site, device, owner_id, map_json, map_rev, created_at, updated_at) VALUES ('u12', 'gpc0000003', 12, NULL, 0, 1, 1)`).run();
  db.prepare("UPDATE hardware_devices SET claimed_by = 12 WHERE site = 'u12' AND device = 'gpc0000003'").run();
  ok(N.nocodeCaller(db, signed('nocode-list'), 'nocode-list').error === 'not_allowed', 'gateway no-code không tự làm gateway PC quản lý');
}

console.log(fails ? `\n${fails} lỗi` : '\nsmoke-nocode: tất cả OK');
process.exit(fails ? 1 : 0);
