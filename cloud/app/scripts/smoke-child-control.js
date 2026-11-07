#!/usr/bin/env node
/** Smoke: giới hạn giá trị + lệnh nguy hiểm của thiết bị con, đặt lúc provisioning (ui_meta) và dấu sao của người dùng. */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-childctl-'));
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';

const { openDb } = await import('../src/db.js');
const { migrateUserDevices, listUserDevices, setCriticalKey, getDashboardFor } = await import('../src/userDevices.js');
const { deviceToUiNode } = await import('../src/uiContract.js');
const { validateChildCmd } = await import('../src/plcCommands.js');
const { seedFromHardware } = await import('../src/gatewayEnroll.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

const db = openDb(tmp);
// DB cũ có bảng user_devices khác schema: migrate phải đổi tên nó và tạo bảng đúng
db.exec('DROP TABLE IF EXISTS user_devices');
db.exec('CREATE TABLE user_devices (user_id INTEGER NOT NULL, site TEXT NOT NULL, device TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (user_id, site, device))');
migrateUserDevices(db);
ok(db.prepare("PRAGMA table_info('user_devices')").all().some((c) => c.name === 'id'), 'migrate: bảng schema cũ được thay bằng bảng có cột id');
const meta = {
  seed: [
    { childId: 'pump1', type: 'pump', limits: { run: { min: 0, max: 1 } }, critical: ['run'] },
    { childId: 'relay1', type: 'relay', limits: { on: { min: 0, max: 0 } } },     // giới hạn hẹp hơn nút: chỉ cho ghi 0
    { childId: 'env1', type: 'env', limits: { t: { min: 5, max: 1 } } },          // min > max: bỏ qua
  ],
};
db.prepare('INSERT INTO hardware_devices (site, device, claim_hash, profile, ui_meta, created_at) VALUES (?,?,?,?,?,?)')
  .run('s1', 'gw1', 'h', 'iot-hub', JSON.stringify(meta), Date.now());
db.prepare("INSERT INTO users (username, password_hash, folder_path, notify_site, notify_device, mqtt_user, mqtt_pass) VALUES ('u1','x','f','s1','gw1','mu','mp')").run();
const user = db.prepare("SELECT * FROM users WHERE username='u1'").get();
const add = (id, child, type) => db.prepare('INSERT INTO user_devices (id,user_id,site,gateway_device,child_id,type,title,binds,created_at) VALUES (?,?,?,?,?,?,?,NULL,?)')
  .run(id, user.id, 's1', 'gw1', child, type, child, Date.now());
add('ud1', 'pump1', 'pump'); add('ud2', 'relay1', 'relay'); add('ud3', 'env1', 'env');

const nodes = () => listUserDevices(db, user).map(deviceToUiNode);
const cmdOf = (child) => nodes().find((n) => n.childId === child).widgets.find((w) => w.cmd)?.cmd;
ok(cmdOf('pump1').critical === true && cmdOf('pump1').criticalLocked === true, 'tem đặt critical: nút bơm là lệnh nguy hiểm, khoá');
ok(cmdOf('pump1').limits?.max === 1, 'giới hạn từ tem đi vào widget');
ok(cmdOf('relay1').critical === false, 'relay chưa critical');

// kiểm lệnh phía server
let v = validateChildCmd({ child: 'pump1', key: 'run', v: 1 }, nodes());
ok(v.cmd && v.critical === true, 'lệnh bơm hợp lệ và được đánh dấu critical');
ok(validateChildCmd({ child: 'pump1', key: 'run', v: 5 }, nodes()).error === 'value_out_of_range', 'giá trị ngoài on/off bị từ chối');
ok(validateChildCmd({ child: 'relay1', key: 'on', v: 1 }, nodes()).error === 'value_out_of_range', 'giới hạn tem hẹp hơn nút: v=1 bị từ chối');
ok(validateChildCmd({ child: 'relay1', key: 'on', v: 0 }, nodes()).cmd, 'v=0 trong giới hạn được nhận');
ok(validateChildCmd({ child: 'env1', key: 't', v: 1 }, nodes()).error === 'bad_command', 'cảm biến không có nút điều khiển');

// dấu sao của người dùng
let r = setCriticalKey(db, user, 'ud2', 'on', true);
ok(r.ok && cmdOf('relay1').critical === true && cmdOf('relay1').criticalLocked === false, 'người dùng đánh dấu relay là nguy hiểm');
ok(validateChildCmd({ child: 'relay1', key: 'on', v: 0 }, nodes()).critical === true, 'lệnh relay giờ yêu cầu xác nhận từng lần');
r = setCriticalKey(db, user, 'ud1', 'run', false);
ok(r.error === 'locked_by_provisioning', 'không bỏ được dấu nguy hiểm do tem đặt');
r = setCriticalKey(db, user, 'ud2', 'on', false);
ok(r.ok && cmdOf('relay1').critical === false, 'người dùng bỏ dấu của chính mình');
ok(setCriticalKey(db, user, 'ud2', 'khong_co', true).error === 'unknown_key', 'key không có nút bị từ chối');
ok(setCriticalKey(db, { id: 999 }, 'ud2', 'on', true).error === 'not_found', 'không đánh dấu được thiết bị của người khác');

// pack gửi cho gateway mang limits (min<=max), bỏ limits hỏng
const pack = seedFromHardware(db.prepare('SELECT * FROM hardware_devices').get()).children;
ok(pack.find((c) => c.id === 'pump1').limits.run.max === 1, 'enroll: pack mang giới hạn của tem');
ok(Object.keys(pack.find((c) => c.id === 'env1').limits).length === 0, 'enroll: giới hạn min>max bị bỏ');
ok(getDashboardFor(db, user, 'simple').devices.length === 3, 'dashboard dựng đủ 3 thiết bị');

console.log(fails ? `\n${fails} test hỏng` : '\nTất cả đạt');
process.exit(fails ? 1 : 0);
