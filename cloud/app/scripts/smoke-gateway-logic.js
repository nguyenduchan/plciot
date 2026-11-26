#!/usr/bin/env node
/** Smoke test: chương trình logic gateway (gatewayLogic.js + logicDsl.js) — text ⇄ JSON, board báo chương trình qua config,
 *  admin kiểm / đề xuất (ký khoá máy), chủ trạm xem bảng / duyệt (step-up) / từ chối, gói rpc PUT /api/offline có "appr" + "enc":"b64",
 *  hẹn giờ của chủ trạm chỉ thay Timer của đúng DO, đề xuất không có timer giữ hẹn giờ chủ trạm, PUT trực tiếp qua relay bị chặn. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import zlib from 'zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-logic-'));
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.DATA_DIR = tmp;
process.env.RADMIN_RPC_TIMEOUT_MS = '1500';

const { openDb } = await import('../src/db.js');
const { setPublisher } = await import('../src/controlPublisher.js');
const R = await import('../src/remoteAdmin.js');
const L = await import('../src/gatewayLogic.js');
const D = await import('../src/logicDsl.js');
const { cmdPublicKey, rpcMessage } = await import('../src/cmdSign.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

// ---------------------------------------------------------------- DSL
const TEXT = `tz 7
do1: need di3=1, hold | block do2 | maxon 30m | offline 2m: level bon.muc on<=20 off>=90 age 60s
do2: block do1 | offline 1m: off
do3: timer 18:00-05:30 t2-t6 | offline 5m: schedule 18:00-05:30`;
const P = D.parseLogic(TEXT);
ok(P.TzMin === 420 && P.Do.length === 3, 'DSL: 3 DO, tz 7');
ok(P.Do[0].Need[0].Di === 3 && P.Do[0].NeedHold && P.Do[0].Block[0] === 2 && P.Do[0].MaxOnSec === 1800 && P.Do[0].Mode === 'threshold' && P.Do[0].DelaySec === 120, 'DSL: do1 đủ need/hold/block/maxon/level');
ok(JSON.stringify(D.parseLogic(D.formatLogic(P))) === JSON.stringify(P), 'DSL: text → JSON → text → JSON khớp');
const rows = D.describeLogic(P, { do: { 1: 'Bơm giếng', 2: 'Bơm tăng áp' }, di: { 3: 'Phao' } });
ok(rows[0].user.join(' ').includes('Phao (DI3) có tín hiệu') && rows[1].user.join(' ').includes('Bơm giếng'), 'bảng: điều kiện + liên động hai chiều có tên');
for (const [bad, part] of [['do1: need di9=1', 'di9'], ['do1: offline: level a.b on<=50 off>=40', 'mâu thuẫn'], ['do1: block do1', 'block'], ['do1: frob', 'frob'], ['do1: timer 25:00-01:00', '25:00']]) {
  let m = ''; try { D.parseLogic(bad); } catch (e) { m = e.message; }
  ok(m.startsWith('Dòng 1:') && m.includes(part), `DSL lỗi: "${bad}" → ${m}`);
}

// ---------------------------------------------------------------- DSL: board điều khiển thiết bị RS485 / Modbus TCP (mcu-0.4.0)
{
  const T = `tz 7
bientan.run: need di1=1, bon.muc>=10, hold | block do2 | offline 2m: level bon.muc on<=20 off>=90
do2: block bientan.run
plc.van: need plc.apsuat>=2, hold | block do1
do3: offline: follow plc.apsuat
plc.cmd: offline: follow di4 invert`;
  const M = D.parseLogic(T, { kind: 'mcu' });
  ok(M.Do.map(D.idOf).join(',') === '2,3,bientan.run,plc.van,plc.cmd', `DSL board: DO trước, đầu ra field sau (${M.Do.map(D.idOf)})`);
  const bt = M.Do.find((o) => o.Out === 'bientan.run');
  ok(bt.Need[0].Di === 1 && bt.Need[1].Field === 'bon.muc' && bt.Block[0] === 2 && bt.Mode === 'threshold', 'DSL board: đầu ra RS485 có DI + field + liên động DO');
  ok(M.Do.find((o) => o.Ch === 2).Block[0] === 'bientan.run', 'DSL board: DO liên động với field (chuỗi)');
  ok(M.Do.find((o) => o.Ch === 3).Field === 'plc.apsuat' && !M.Do.find((o) => o.Ch === 3).Di, 'DSL board: follow theo field');
  ok(M.Do.find((o) => o.Out === 'plc.cmd').Di === 4, 'DSL board: đầu ra field follow DI');
  ok(JSON.stringify(D.parseLogic(D.formatLogic(M), { kind: 'mcu' })) === JSON.stringify(M), 'DSL board: text → JSON → text khớp (trộn DO + field)');
  const rr = D.describeLogic(M, { do: { 2: 'Bơm tăng áp' }, out: { 'bientan.run': 'Biến tần · Chạy' } });
  ok(rr.length === 5 && rr.find((r) => r.id === '2').user.join(' ').includes('Biến tần · Chạy') && rr.find((r) => r.id === 'bientan.run').user.join(' ').includes('Bơm tăng áp'), 'bảng: liên động hai chiều DO ↔ RS485 có tên');
  const many = ['tz 7', ...Array.from({ length: 9 }, (_, i) => `tb.o${i}: offline: off`)].join(String.fromCharCode(10));
  let m = ''; try { D.parseLogic(many, { kind: 'mcu' }); } catch (e) { m = e.message; }
  ok(m.includes('tối đa 8'), `DSL board: tối đa 8 đầu ra field → ${m}`);
  m = ''; try { D.parseLogic('pump.run: block do2', { kind: 'pc' }); } catch (e) { m = e.message; }
  ok(m.includes('gateway PC'), `DSL PC: không có doN trong block → ${m}`);
  m = ''; try { D.parseLogic('pump.run: need di1=1', { kind: 'pc' }); } catch (e) { m = e.message; }
  ok(m.includes('không có DI'), `DSL PC: không có DI → ${m}`);
}

// ---------------------------------------------------------------- hẹn giờ 1 lần (kiểu báo thức iPhone)
{
  const T = D.parseLogic('do1: timer 22:00-06:00 2026-12-24', { kind: 'mcu' });
  const t = T.Do[0].Timer[0];
  ok(t.Date === '2026-12-24' && Array.isArray(t.Days) && t.Days.length === 0, 'DSL: timer 1 lần → {Date, Days:[]} (gateway cũ từ chối)');
  ok(D.formatLogic(T).includes('timer 22:00-06:00 2026-12-24'), 'DSL: text giữ ngày chạy 1 lần');
  ok(D.describeLogic(T)[0].timer[0].includes('1 lần, ngày 24/12/2026'), 'bảng: hẹn giờ 1 lần có ngày');
  let m = ''; try { D.parseLogic('do1: timer on 06:00 2026-02-30'); } catch (e) { m = e.message; }
  ok(m.includes('không hợp lệ'), `DSL: ngày sai → ${m}`);
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const c = L.cleanTimers([{ On: '06:00', Date: future, Days: [] }, { On: '07:00', Date: '2020-01-01', Days: [] }, { On: '08:00', Days: [1, 2] }]);
  ok(Array.isArray(c) && c.length === 2 && c[0].Date === future && c[1].Days.join() === '1,2', 'timer: 1 lần đã qua bị bỏ, lặp lại giữ');
  ok(L.cleanTimers([{ On: '06:00', Date: future, Days: [3] }]) === 'timer_invalid' && L.cleanTimers([{ On: '06:00', Date: '2026-13-01' }]) === 'timer_invalid', 'timer: 1 lần kèm ngày lặp / ngày sai → timer_invalid');
}

// ---------------------------------------------------------------- server
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
  db.prepare(`INSERT INTO gateway_clients (site, device, version, first_seen, last_seen) VALUES ('siteA', 'gw01', 'mcu-0.3.9', ?, ?)`).run(Date.now(), Date.now());
}
ok(Number(db.pragma('user_version', { simple: true })) >= 6, 'DB schema ≥ v6');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const keyId = R.addAdminKey(db, 'may-test', spki);

// board giả: kiểm chữ ký rpc1, giữ chương trình + rev như offline.cpp (Rev khác → 409, thiếu appr → 403)
const board = { rev: 4, program: { TzMin: 420, Do: [{ Ch: 5, Mode: 'hold', DelaySec: 60, Timer: [{ On: '06:00', Off: '07:00' }] }] } };
const seen = [];
setPublisher(async (_s, _d, raw, opts) => {
  const i = raw.lastIndexOf(',"sig":"');
  const json = `${raw.slice(0, i)}}`;
  const key = crypto.createPublicKey({ key: Buffer.from(cmdPublicKey(), 'base64url'), format: 'der', type: 'spki' });
  if (!crypto.verify('sha256', Buffer.from(rpcMessage(opts.mqttId, json), 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(raw.slice(i + 8, -2), 'base64url'))) return;
  const m = JSON.parse(json);
  seen.push({ ...m, mqttId: opts.mqttId });
  const pc = opts.mqttId === MQ_PC;   // gateway PC: gzip như CloudBridge.cs; board: base64 thường
  const tgt = pc ? pcGw : board;
  const reqBody = m.b ? (pc ? zlib.gunzipSync(Buffer.from(m.b, 'base64')) : Buffer.from(m.b, 'base64')).toString('utf8') : '';
  let st = 200, body;
  if (m.m === 'PUT' && m.p === '/api/offline') {
    const b = JSON.parse(reqBody);
    if (!m.appr) { st = 403; body = { Ok: false, Err: 'owner_approval_required' }; }
    else if (b.Rev !== tgt.rev) { st = 409; body = { Ok: false, Err: 'rev_conflict' }; }
    else { tgt.rev++; tgt.program = { TzMin: b.TzMin, Do: b.Do }; body = { Ok: true, Rev: tgt.rev }; }
  } else body = { Ok: true };
  const raw2 = Buffer.from(JSON.stringify(body));
  const z = (pc ? zlib.gzipSync(raw2) : raw2).toString('base64');
  setTimeout(() => R.onRpcReply(opts.mqttId, Buffer.from(JSON.stringify({ rid: m.rid, i: 0, n: 1, st, ...(pc ? {} : { enc: 'b64' }), z }))), 10);
});
const MQ_PC = 'b1b2c3d4e5f60719';
const pcGw = { rev: 0, program: { TzMin: 420, Do: [] } };

// board báo chương trình (bản tin config)
L.recordReportedLogic(db, { site: 'siteA', device: 'gw01', logic: { rev: 4, sha: 'ab', tz: 420, do: board.program.Do, names: { do: { 1: 'Bơm giếng', 5: 'Đèn sân' } }, keys: { 1: 'io.do1', 5: 'io.do5' } } });

const app = express();
app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
const requireAuth = (req, res, next) => { const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.get('x-test-user') || ''); if (!u) return res.status(401).end(); req.user = u; next(); };
const security = { authorize: (req) => (req.get('x-stepup') === '1' ? {} : { error: 'step_up_required', status: 401 }) };
const admin = R.mountRemoteAdmin(app, { db, requireAuth });
L.mountGatewayLogic(app, { db, requireAuth, security, admin });
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;

async function signed(method, p, bodyObj) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const ts = Date.now(), nonce = crypto.randomBytes(12).toString('base64url');
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const sig = crypto.sign('sha256', Buffer.from(R.radmMessage(method, p.split('?')[0], ts, nonce, hash)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-radm-key': keyId, 'x-radm-ts': String(ts), 'x-radm-nonce': nonce, 'x-radm-sig': sig }, body: body || undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const user = (name, method, p, b, step) => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': name, ...(step ? { 'x-stepup': '1' } : {}) }, body: b ? JSON.stringify(b) : undefined })
  .then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

// relay chung không còn ghi logic trực tiếp
db.prepare(`INSERT INTO remote_admin_consent (site, device, enabled, updated_at) VALUES ('siteA', 'gw01', 1, ?)`).run(Date.now());
let r = await signed('POST', '/api/v1/radmin/rpc', { site: 'siteA', device: 'gw01', method: 'PUT', path: '/api/offline', body: '{}' });
ok(r.status === 403 && r.j.error === 'radmin_route_blocked', 'PUT /api/offline qua relay chung → bị chặn (phải qua duyệt)');
r = await signed('POST', '/api/v1/radmin/rpc', { site: 'siteA', device: 'gw01', method: 'GET', path: '/api/offline' });
ok(r.status === 200 && seen.at(-1)?.enc === 'b64', 'GET /api/offline tới board: gói "enc":"b64" (board không gzip)');

// admin
r = await signed('GET', '/api/v1/radmin/logic?site=siteA&device=gw01');
ok(r.status === 200 && r.j.current?.rev === 4 && r.j.current.text.includes('do5: timer 06:00-07:00'), 'admin đọc bản đang chạy dạng text');
r = await signed('POST', '/api/v1/radmin/logic/check', { site: 'siteA', device: 'gw01', text: 'do1: need di9=1' });
ok(r.status === 400 && r.j.error === 'logic_syntax' && r.j.message.startsWith('Dòng 1'), 'kiểm: lỗi cú pháp có số dòng');
r = await signed('POST', '/api/v1/radmin/logic/check', { site: 'siteA', device: 'gw01', text: TEXT });
ok(r.status === 200 && r.j.changed.join() === '1,2,3' && r.j.rows.find((x) => x.ch === 5)?.timer.length === 1, 'kiểm: DO1-3 đổi, hẹn giờ DO5 của chủ trạm vẫn giữ');
r = await signed('POST', '/api/v1/radmin/logic/propose', { site: 'siteA', device: 'gw01', text: 'tz 7\ndo1: offline: off', note: 'bản nháp' });
const first = r.j.id;
r = await signed('POST', '/api/v1/radmin/logic/propose', { site: 'siteA', device: 'gw01', text: TEXT, note: 'Theo yêu cầu: bơm tự tắt khi phao cạn' });
const pid = r.j.id;
ok(r.status === 200 && pid > first, 'admin gửi đề xuất');
ok(db.prepare('SELECT status FROM gateway_logic_proposals WHERE id = ?').get(first).status === 'superseded', 'đề xuất cũ đang chờ → superseded');

// chủ trạm
r = await user('other1', 'GET', '/api/v1/gateway-logic?gw=siteA/gw01');
ok(r.status === 403, 'người khác không xem được logic gateway');
r = await user('owner1', 'GET', '/api/v1/gateway-logic?gw=siteA/gw01');
ok(r.status === 200 && r.j.pending?.id === pid && r.j.pending.changed.join() === '1,2,3' && r.j.current.keys['1'] === 'io.do1', 'chủ trạm thấy bảng + đề xuất chờ + hàng thay đổi + DO↔nút');
r = await user('owner1', 'POST', '/api/v1/gateway-logic/approve', { gw: 'siteA/gw01', id: pid });
ok(r.status === 401 && board.rev === 4, 'duyệt không có step-up → 401, board không đổi');
const before = seen.length;
r = await user('owner1', 'POST', '/api/v1/gateway-logic/approve', { gw: 'siteA/gw01', id: pid }, true);
const put = seen.slice(before).find((m) => m.m === 'PUT');
ok(r.status === 200 && r.j.rev === 5 && board.rev === 5, 'duyệt + step-up → board áp dụng (rev 5)');
ok(put?.appr?.startsWith('owner1#') && put.enc === 'b64', 'gói PUT có mã duyệt của chủ trạm trong phần ký');
ok(board.program.Do.find((o) => o.Ch === 1)?.NeedHold === true && board.program.Do.find((o) => o.Ch === 5)?.Timer?.[0]?.On === '06:00', 'board nhận chương trình mới, hẹn giờ DO5 giữ nguyên');
ok(db.prepare('SELECT status FROM gateway_logic_proposals WHERE id = ?').get(pid).status === 'applied', 'đề xuất → applied');
r = await user('owner1', 'POST', '/api/v1/gateway-logic/approve', { gw: 'siteA/gw01', id: pid }, true);
ok(r.status === 409, 'duyệt lại đề xuất đã áp dụng → 409');

// từ chối
r = await signed('POST', '/api/v1/radmin/logic/propose', { site: 'siteA', device: 'gw01', text: 'do2: offline: on' });
r = await user('owner1', 'POST', '/api/v1/gateway-logic/reject', { gw: 'siteA/gw01', id: r.j.id });
ok(r.status === 200 && board.rev === 5, 'từ chối → board không đổi');

// hẹn giờ của chủ trạm
r = await user('owner1', 'PUT', '/api/v1/gateway-logic/timer', { gw: 'siteA/gw01', ch: 1, timers: [{ On: '25:00' }] }, true);
ok(r.status === 400 && r.j.error === 'timer_invalid', 'hẹn giờ sai giờ → timer_invalid');
r = await user('owner1', 'PUT', '/api/v1/gateway-logic/timer', { gw: 'siteA/gw01', ch: 1, timers: [{ On: '05:00', Off: '05:20', Days: [1, 2, 3, 4, 5] }] });
ok(r.status === 401, 'hẹn giờ không step-up → 401');
r = await user('owner1', 'PUT', '/api/v1/gateway-logic/timer', { gw: 'siteA/gw01', ch: 1, timers: [{ On: '05:00', Off: '05:20', Days: [1, 2, 3, 4, 5] }] }, true);
const d1 = board.program.Do.find((o) => o.Ch === 1);
ok(r.status === 200 && board.rev === 6 && d1.Timer?.[0]?.Off === '05:20' && d1.NeedHold === true && d1.Block?.[0] === 2, 'hẹn giờ: chỉ thay Timer của DO1, điều kiện/liên động giữ nguyên');
r = await user('owner1', 'PUT', '/api/v1/gateway-logic/timer', { gw: 'siteA/gw01', ch: 1, timers: [] }, true);
ok(r.status === 200 && !board.program.Do.find((o) => o.Ch === 1).Timer, 'xoá hẹn giờ DO1');

// board đổi tại chỗ → rev lệch → duyệt báo xung đột
r = await signed('POST', '/api/v1/radmin/logic/propose', { site: 'siteA', device: 'gw01', text: 'do3: offline: off' });
board.rev = 42;
r = await user('owner1', 'POST', '/api/v1/gateway-logic/approve', { gw: 'siteA/gw01', id: r.j.id }, true);
ok(r.status === 409 && r.j.error === 'logic_rev_conflict', 'board vừa đổi tại chỗ → logic_rev_conflict, không ghi đè');

// ---------------------------------------------------------------- gateway PC (đầu ra theo field)
db.prepare(`INSERT INTO devices (tenant_id, site, device, mqtt_user, mqtt_pass, created_at, updated_at, mqtt_id) VALUES ('default', 'siteA', 'gwpc', 'u2', 'p', ?, ?, ?)`).run(Date.now(), Date.now(), MQ_PC);
db.prepare(`INSERT INTO gateway_clients (site, device, version, first_seen, last_seen) VALUES ('siteA', 'gwpc', '1.4.0', ?, ?)`).run(Date.now(), Date.now());
db.prepare(`INSERT INTO user_devices (user_id, site, gateway_device, child_id, type, created_at) VALUES ((SELECT id FROM users WHERE username = 'owner1'), 'siteA', 'gwpc', 'pump1', 'pump', ?)`).run(Date.now());
L.recordReportedLogic(db, { site: 'siteA', device: 'gwpc', logic: { rev: 0, sha: 'cd', tz: 420, do: [], names: { out: { 'pump1.run': 'Bơm 1 · Chạy' }, f: { 'tank1.level': 'Bồn · Mức (%)' } }, keys: { 'pump1.run': 'pump1.run' } } });
r = await signed('POST', '/api/v1/radmin/logic/check', { site: 'siteA', device: 'gwpc', text: 'do1: offline: off' });
ok(r.status === 400 && r.j.message.includes('gateway PC'), 'gateway PC: viết doN → báo lỗi', r.j.message);
const PCT = 'pump1.run: need tank1.level>=10, hold | maxon 30m | offline 2m: level tank1.level on<=20 off>=90';
r = await signed('POST', '/api/v1/radmin/logic/check', { site: 'siteA', device: 'gwpc', text: PCT });
ok(r.status === 200 && r.j.changed[0] === 'pump1.run' && r.j.rows[0].name === 'Bơm 1 · Chạy', 'gateway PC: kiểm text → bảng có tên, hàng đổi theo field');
r = await signed('POST', '/api/v1/radmin/logic/propose', { site: 'siteA', device: 'gwpc', text: PCT, note: 'PC' });
const pcId = r.j.id;
r = await user('owner1', 'POST', '/api/v1/gateway-logic/approve', { gw: 'siteA/gwpc', id: pcId }, true);
const pcPut = seen.filter((m) => m.mqttId === MQ_PC && m.m === 'PUT').at(-1);
ok(r.status === 200 && pcGw.rev === 1 && pcGw.program.Do[0].Out === 'pump1.run' && pcPut && !pcPut.enc && pcPut.appr, 'gateway PC: duyệt trên webapp → rpc gzip + mã duyệt, gateway áp dụng');
L.recordReportedLogic(db, { site: 'siteA', device: 'gwpc', logic: { rev: 1, sha: 'ef', tz: 420, do: pcGw.program.Do, names: { out: { 'pump1.run': 'Bơm 1 · Chạy' } }, keys: { 'pump1.run': 'pump1.run' } } });
r = await user('owner1', 'PUT', '/api/v1/gateway-logic/timer', { gw: 'siteA/gwpc', id: 'pump1.run', timers: [{ On: '06:00', Off: '06:10' }] }, true);
ok(r.status === 200 && pcGw.program.Do[0].Timer?.[0]?.Off === '06:10' && pcGw.program.Do[0].NeedHold === true, 'gateway PC: hẹn giờ theo field, điều kiện giữ nguyên');
r = await user('owner1', 'PUT', '/api/v1/gateway-logic/timer', { gw: 'siteA/gwpc', id: 'tank1.level', timers: [{ On: '06:00' }] }, true);
ok(r.status === 400, 'gateway PC: hẹn giờ cho field không phải nút điều khiển → bad_request');

// ---------------------------------------------------------------- chủ trạm duyệt TẠI GATEWAY (ký bằng khoá gateway)
const gwKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const gwPub = gwKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const { ensureKeyColumns } = await import('../src/gatewayKey.js');
ensureKeyColumns(db);
db.prepare(`INSERT INTO hardware_devices (site, device, claim_hash, created_at, gw_pubkey) VALUES ('siteA', 'gwpc', 'x', ?, ?)`).run(Date.now(), gwPub);
const proof = (kind, key = gwKey.privateKey) => { const ts = Date.now(); return { site: 'siteA', device: 'gwpc', pubkey: gwPub, ts, sig: crypto.sign('sha256', Buffer.from(`${kind}|siteA|gwpc|${ts}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url') }; };
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (x) => ({ status: x.status, j: await x.json().catch(() => ({})) }));
r = await signed('POST', '/api/v1/radmin/logic/propose', { site: 'siteA', device: 'gwpc', text: 'pump1.run: maxon 10m', note: 'tại chỗ' });
const lid = r.j.id;
r = await post('/api/v1/gateway/logic/pending', proof('logic-pending'));
ok(r.status === 200 && r.j.pending?.id === lid && r.j.pending.program.Do[0].Out === 'pump1.run' && r.j.pending.program.Do[0].Timer?.[0]?.On === '06:00' && r.j.current?.rows?.length, 'gateway lấy đề xuất chờ (chương trình áp dụng giữ hẹn giờ chủ trạm) + bảng đang chạy');
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
r = await post('/api/v1/gateway/logic/pending', { ...proof('logic-pending', other.privateKey) });
ok(r.status === 403, 'chữ ký không phải khoá gateway → 403');
r = await post('/api/v1/gateway/logic/decide', { ...proof(`logic-approve-${lid}`), id: lid, decision: 'reject', by: 'x' });
ok(r.status === 403, 'chữ ký duyệt dùng cho từ chối (khác quyết định) → 403');
r = await post('/api/v1/gateway/logic/decide', { ...proof(`logic-approve-${lid}`), id: lid, decision: 'approve', by: 'chu_tram', rev: 3 });
const lrow = db.prepare('SELECT status, decided_by, result FROM gateway_logic_proposals WHERE id = ?').get(lid);
ok(r.status === 200 && lrow.status === 'applied' && lrow.decided_by.includes('tại gateway') && lrow.result === 'rev 3', 'gateway báo đã duyệt tại chỗ → applied, ghi người duyệt', JSON.stringify(lrow));
r = await post('/api/v1/gateway/logic/decide', { ...proof(`logic-approve-${lid}`), id: lid, decision: 'approve', by: 'x', rev: 4 });
ok(r.status === 409, 'báo lại lần hai → 409');

srv.close();
console.log(fails ? `\n${fails} FAIL` : '\nTẤT CẢ OK');
process.exit(fails ? 1 : 0);
