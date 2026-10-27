#!/usr/bin/env node
/** Offline smoke test: roles, admin user management, role-scoped MQTT ACL. */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-roles-'));
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';
process.env.ADMIN_PHONES = '0900000001';

const { openDb, upsertUser, findUserById } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const A = await import('../src/adminUsers.js');

const db = openDb(tmp);
const src = path.join(tmp, 'webapp');
fs.mkdirSync(src);
fs.writeFileSync(path.join(src, 'index.html'), 'x');
const ctx = { dataDir: tmp, webappSrc: src, ip: '127.0.0.1' };

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };
const acl = () => fs.readFileSync(path.join(tmp, 'cfg', 'acl'), 'utf8');

const root = upsertUser(db, {
  username: '84900000001', passwordHash: hashPassword('pw123456'), folderPath: 's1', version: '1', phone: '84900000001',
});
ok(root.role === 'operator', 'người dùng cũ mặc định operator');
A.applyBootstrapAdmins(db);
const admin = findUserById(db, root.id);
ok(admin.role === 'admin', 'ADMIN_PHONES nâng thành admin');

// thêm user
let r = A.createUser(db, admin, { phone: '0911111111', role: 'viewer', site: 'plantA', device: 'plc01' }, ctx);
ok(r.ok && r.user.role === 'viewer', 'admin thêm viewer');
const viewer = r.user;
r = A.createUser(db, admin, { phone: '0922222222', role: 'operator', site: 'plantA', device: 'plc01' }, ctx);
ok(r.ok, 'admin thêm operator cùng site');
const oper = r.user;

ok(A.createUser(db, admin, { phone: '0911111111' }, ctx).error === 'phone_in_use', 'trùng SĐT bị từ chối');
ok(A.createUser(db, admin, { phone: '0933333333' }, ctx).ok === true, 'admin tạo user chỉ cần SĐT (không mật khẩu)');
ok(A.createUser(db, admin, { phone: '0933333333', role: 'root' }, ctx).error === 'invalid_role', 'role lạ bị từ chối');
ok(A.createUser(db, admin, { phone: '0933333333', site: 'a/../b' }, ctx).error === 'invalid_site_or_device', 'site chứa ký tự nguy hiểm bị từ chối');

// ACL theo vai trò
const blockOf = (id) => {
  const u = findUserById(db, id);
  const lines = acl().split('\n');
  const i = lines.indexOf(`user ${u.mqtt_user}`);
  if (i < 0) return '';
  const out = [];
  for (let j = i + 1; j < lines.length && !lines[j].startsWith('user '); j++) out.push(lines[j]);
  return out.join('\n');
};
const vb = blockOf(viewer.id);
const ob = blockOf(oper.id);
ok(vb.includes('topic read plc/plantA/plc01/telemetry') && !vb.includes('write'), 'viewer: chỉ đọc, không có quyền ghi');
ok(ob.includes('topic read plc/plantA/plc01/ack') && !ob.includes('write'), 'operator: đọc được ack, KHÔNG ghi cmd trực tiếp (lệnh đi qua app server)');
ok(acl().includes('user ctl\ntopic write plc/+/+/cmd'),'acl (mã hoá): chỉ user ctl của app server được ghi cmd');
ok(!fs.readFileSync(path.join(tmp, 'cfg', 'acl-monitor'), 'utf8').includes('user ctl'), 'acl-monitor: không có user ctl');

// đổi vai trò
r = A.updateUser(db, admin, viewer.id, { role: 'operator' }, ctx);
ok(r.ok && blockOf(viewer.id).includes('topic read plc/plantA/plc01/ack'), 'nâng viewer → operator cấp quyền đọc ack (để xác nhận lệnh)');
r = A.updateUser(db, admin, viewer.id, { role: 'viewer' }, ctx);
ok(r.ok && !blockOf(viewer.id).includes('write'), 'hạ → viewer thu hồi quyền cmd');

// khoá tài khoản: ACL biến mất, token bị thu hồi
const tv = findUserById(db, oper.id).token_version;
const oldPass = findUserById(db, oper.id).mqtt_pass;
r = A.updateUser(db, admin, oper.id, { disabled: true }, ctx);
ok(r.ok && !acl().includes(findUserById(db, oper.id).mqtt_user + '\n'), 'khoá → xoá khỏi ACL');
ok(findUserById(db, oper.id).token_version === tv + 1, 'khoá → thu hồi token');
ok(findUserById(db, oper.id).mqtt_pass !== oldPass, 'khoá → đổi mật khẩu MQTT');

// monitor/control theo kênh: acl (mã hoá) có cmd cho operator; acl-monitor (không mã hoá) thì không
const blockIn = (file, id) => {
  const u = findUserById(db, id);
  const lines = fs.readFileSync(path.join(tmp, 'cfg', file), 'utf8').split('\n');
  const i = lines.indexOf(`user ${u.mqtt_user}`);
  if (i < 0) return '';
  const out = [];
  for (let j = i + 1; j < lines.length && !lines[j].startsWith('user '); j++) out.push(lines[j]);
  return out.join('\n');
};
const op2 = A.createUser(db, admin, { phone: '0944444444', role: 'operator', site: 'plantB' }, ctx).user;
ok(!blockIn('acl', op2.id).includes('write'), 'kênh mã hoá: operator không ghi cmd trực tiếp');
ok(!blockIn('acl-monitor', op2.id).includes('write') && blockIn('acl-monitor', op2.id).includes('topic read plc/plantB/plc01/telemetry'),
  'kênh không mã hoá: operator chỉ đọc, không ghi cmd');
ok(!fs.readFileSync(path.join(tmp, 'cfg', 'acl-monitor'), 'utf8').split('user gw')[1].split('user ingest')[1].includes('cmd'), 'acl-monitor không có dòng cmd cho user');

// chế độ tương thích CONTROL_VIA_SERVER=false: operator ghi cmd trực tiếp như trước
process.env.CONTROL_VIA_SERVER = 'false';
A.updateUser(db, admin, op2.id, { role: 'operator' }, ctx);
ok(blockIn('acl', op2.id).includes('topic write plc/plantB/plc01/cmd'), 'CONTROL_VIA_SERVER=false: khôi phục ghi cmd trực tiếp');
process.env.CONTROL_VIA_SERVER = 'true';
A.updateUser(db, admin, op2.id, { role: 'operator' }, ctx);

// phạm vi monitor
r = A.updateUser(db, admin, op2.id, { scopes: ['telemetry'] }, ctx);
ok(r.ok && JSON.stringify(r.user.scopes) === '["telemetry"]', 'admin giới hạn phạm vi xem');
const sb = blockIn('acl-monitor', op2.id);
ok(sb.includes('/telemetry') && !sb.includes('/status') && !sb.includes('/history') && !sb.includes('/ack'), 'kênh monitor: chỉ đọc telemetry');
const sc = blockIn('acl', op2.id);
ok(sc.includes('/telemetry') && sc.includes('/ack') && !sc.includes('/status') && !sc.includes('write'), 'kênh mã hoá: telemetry + ack (để xác nhận lệnh), không ghi');
ok(A.updateUser(db, admin, op2.id, { scopes: ['telemetry', 'secrets'] }, ctx).error === 'invalid_scopes', 'scope lạ bị từ chối');
r = A.updateUser(db, admin, op2.id, { role: 'viewer', scopes: [] }, ctx);
ok(r.ok && !blockIn('acl', op2.id).includes('topic'), 'viewer không scope nào: không có quyền gì');

// bảo vệ admin cuối
ok(A.updateUser(db, admin, admin.id, { role: 'viewer' }, ctx).error === 'last_admin', 'không tự hạ quyền admin cuối');
ok(A.updateUser(db, admin, admin.id, { disabled: true }, ctx).error === 'last_admin', 'không tự khoá mình');
ok(A.deleteUser(db, admin, admin.id, ctx).error === 'last_admin', 'không tự xoá mình');

// xoá
r = A.deleteUser(db, admin, oper.id, ctx);
ok(r.ok && !findUserById(db, oper.id), 'xoá user');
ok(A.listUsers(db).every((u) => u.role && !('password_hash' in u)), 'danh sách không lộ băm mật khẩu');

console.log(fails ? `\n${fails} test hỏng` : '\nTất cả đạt');
process.exit(fails ? 1 : 0);
