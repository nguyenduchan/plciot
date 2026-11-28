#!/usr/bin/env node
/** Smoke test: thư viện thiết bị mẫu (deviceLibrary.js) — kiểm/chuẩn hoá mẫu, GatewayAdmin ký khoá máy mới ghi được,
 *  board đọc công khai + 304 khi rev không đổi, xoá mềm. Chạy: node scripts/smoke-device-library.js */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-tpl-'));
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.DATA_DIR = tmp;

const { openDb } = await import('../src/db.js');
const R = await import('../src/remoteAdmin.js');
const L = await import('../src/deviceLibrary.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };
const throwsMsg = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const GD20 = {
  name: 'Biến tần INVT GD20', brand: 'INVT', model: 'GD20', icon: 'vfd', serial: { baud: 9600, parity: 'None' }, test: ['f', 'a'],
  fields: [
    { key: 'f', label: 'Tần số ngõ ra', fc: 3, addr: 0x3000, type: 'UInt16', scale: 100, unit: 'Hz', access: 'r' },
    { key: 'a', label: 'Dòng điện', fc: 3, addr: 0x3004, type: 'UInt16', scale: 10, unit: 'A', access: 'r' },
    { key: 'kw', label: 'Công suất', fc: 3, addr: 0x3006, type: 'Float32', order: 'CDAB', scale: 1, unit: 'kW', access: 'r', show: false },
    { key: 'sp', label: 'Cài đặt tần số', fc: 3, addr: 0x2001, type: 'UInt16', scale: 100, unit: 'Hz', access: 'rw', min: 0, max: 50 },
    { key: 'cmd', label: 'Lệnh chạy/dừng', addr: 0x2000, access: 'w', kind: 'number', wfc: 6 },
  ],
};

// ---------------------------------------------------------------- kiểm mẫu
const v = L.validateTemplate(GD20, 'invt-gd20');
ok(v.id === 'invt-gd20' && v.fields.length === 5 && v.fields[2].order === 'CDAB' && v.fields[0].order === 'AB', 'chuẩn hoá: id, thứ tự byte mặc định');
ok(v.fields[2].show === false && v.fields[0].show === true && v.fields[3].kind === 'slider' && v.fields[4].wfc === 6, 'show/kind/wfc');
ok(JSON.stringify(v.test) === '["f","a"]', 'thông số đọc thử');
ok(JSON.stringify(L.validateTemplate({ ...GD20, test: ['cmd'] }, 'x-1').test) === '["f","a","kw"]', 'đọc thử không chọn field chỉ ghi → tự lấy 3 field đọc đầu');
for (const [patch, part] of [
  [{ fields: [{ key: 'a b', addr: 1 }] }, 'khoá'],
  [{ fields: [{ key: 'a', addr: 70000 }] }, '65535'],
  [{ fields: [{ key: 'a', addr: 65535, type: 'Float32' }] }, '65535'],
  [{ fields: [{ key: 'a', addr: 1, type: 'Float32', order: 'AB' }] }, 'thứ tự byte'],
  [{ fields: [{ key: 'a', addr: 1, fc: 4, access: 'rw' }] }, 'FC04'],
  [{ fields: [{ key: 'a', addr: 1, scale: 0 }] }, 'hệ số'],
  [{ fields: [{ key: 'a', addr: 1 }, { key: 'A', addr: 2 }] }, 'trùng'],
  [{ fields: [{ key: 'a', addr: 1, access: 'w' }] }, 'ĐỌC'],
  [{ fields: [{ key: 'a', addr: 1, type: 'Int32', access: 'rw', wfc: 6 }] }, 'FC16'],
  [{ serial: { baud: 1234 } }, 'baud'],
]) {
  const m = throwsMsg(() => L.validateTemplate({ ...GD20, ...patch }, 'x-1'));
  ok(m.includes(part), `từ chối: ${JSON.stringify(patch).slice(0, 60)} → ${m}`);
}
ok(throwsMsg(() => L.validateTemplate(GD20, 'Bad Id')).includes('Mã mẫu'), 'từ chối mã mẫu sai');

// ---------------------------------------------------------------- API
const db = openDb(tmp);
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const admin = R.mountRemoteAdmin(app, { db, requireAuth: (_q, s) => s.status(401).end() });
L.mountDeviceLibrary(app, { db, admin });
const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;

const k = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const spki = k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const keyId = R.addAdminKey(db, 'PC kỹ sư', spki);
async function signed(method, p, body) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = Date.now(), nonce = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const sig = crypto.sign('sha256', Buffer.from(R.radmMessage(method, p, ts, nonce, hash)), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const r = await fetch(base + p, { method, body: raw || undefined, headers: { 'content-type': 'application/json', 'x-radm-key': keyId, 'x-radm-ts': String(ts), 'x-radm-nonce': nonce, 'x-radm-sig': sig } });
  return { status: r.status, j: r.status === 304 ? null : await r.json() };
}

let r = await fetch(base + '/api/v1/radmin/templates/invt-gd20', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(GD20) });
ok(r.status === 401, 'PUT không ký → 401');
r = await signed('PUT', '/api/v1/radmin/templates/invt-gd20', GD20);
ok(r.status === 200 && r.j.rev === 1, 'PUT ký khoá máy → lưu rev 1');
r = await signed('PUT', '/api/v1/radmin/templates/bad', { ...GD20, fields: [] });
ok(r.status === 400 && r.j.detail.includes('chưa có thông số'), 'PUT mẫu sai → 400 kèm câu báo');
r = await signed('PUT', '/api/v1/radmin/templates/xy-md02', { name: 'Cảm biến nhiệt ẩm XY-MD02', icon: 'env', fields: [{ key: 't', label: 'Nhiệt độ', fc: 4, addr: 1, type: 'Int16', scale: 10, unit: '°C' }] });
ok(r.status === 200, 'PUT mẫu thứ 2 (FC04)');

let p = await (await fetch(base + '/api/v1/device-templates')).json();
ok(p.rev > 0 && p.templates.length === 2 && p.templates[0].id === 'invt-gd20' && p.templates[0].updatedBy === undefined, 'board đọc công khai: 2 mẫu, không lộ người sửa');
ok((await fetch(base + '/api/v1/device-templates?since=' + p.rev)).status === 304, 'rev không đổi → 304');
r = await signed('PUT', '/api/v1/radmin/templates/invt-gd20', { ...GD20, name: 'INVT GD20 (sửa)' });
ok(r.j.rev === 2, 'sửa → rev mẫu 2');
const p2 = await (await fetch(base + '/api/v1/device-templates?since=' + p.rev)).json();
ok(p2.rev > p.rev && p2.templates[0].name === 'INVT GD20 (sửa)', 'sửa → rev thư viện tăng, board tải lại');
r = await signed('DELETE', '/api/v1/radmin/templates/xy-md02');
ok(r.status === 200, 'xoá mềm');
const p3 = await (await fetch(base + '/api/v1/device-templates')).json();
ok(p3.templates.length === 1 && p3.rev > p2.rev, 'mẫu đã xoá không còn trong danh sách board');
r = await signed('GET', '/api/v1/radmin/templates');
ok(r.j.templates.length === 2 && r.j.templates.find((t) => t.id === 'xy-md02').deleted === true && r.j.templates[0].updatedBy === 'PC kỹ sư', 'GatewayAdmin thấy cả mẫu đã xoá + người sửa');
r = await signed('PUT', '/api/v1/radmin/templates/xy-md02', { name: 'XY-MD02', fields: [{ key: 't', addr: 1, fc: 4 }] });
ok(r.status === 200 && (await (await fetch(base + '/api/v1/device-templates')).json()).templates.length === 2, 'lưu lại mẫu đã xoá → dùng lại');
ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE event LIKE 'template_%'").get().n >= 4, 'ghi nhật ký audit');

srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`${fails} lỗi`); process.exit(1); }
console.log('device library smoke passed');
