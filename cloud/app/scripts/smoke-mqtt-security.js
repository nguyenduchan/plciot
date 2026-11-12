#!/usr/bin/env node
/**
 * Live test against a running broker: cô lập topic giữa 2 user + từ chối truy cập bất hợp lệ.
 *   BROKER=mqtts://plc-mqtt.example.net:8883 \
 *   A_USER=u1 A_PASS=... A_ID=<mqttId gateway A> \
 *   B_USER=u2 B_PASS=... B_ID=<mqttId gateway B> \
 *   node scripts/smoke-mqtt-security.js
 * (BROKER mặc định mqtt://127.0.0.1:1883; đặt INSECURE_TLS=1 cho chứng chỉ tự ký.)
 */
import mqtt from 'mqtt';

const E = process.env;
const url = E.BROKER || 'mqtt://127.0.0.1:1883';
const rej = E.INSECURE_TLS === '1' ? { rejectUnauthorized: false } : {};
// topic = gw/<mqttId>: id MQTT ngẫu nhiên server cấp cho gateway (devices.mqtt_id)
const A = { username: E.A_USER, password: E.A_PASS, id: E.A_ID };
const B = { username: E.B_USER, password: E.B_PASS, id: E.B_ID };
if (!A.username || !B.username || !A.id || !B.id) { console.error('Thiếu A_USER/B_USER...'); process.exit(2); }

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(u) {
  return new Promise((resolve) => {
    const c = mqtt.connect(url, {
      clientId: `smoke-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 0, connectTimeout: 5000, ...rej,
      username: u.username, password: u.password,
    });
    c.once('connect', () => resolve(c));
    c.once('error', () => { c.end(true); resolve(null); });
    c.once('close', () => resolve(null));
  });
}
// 128 (0x80) = SUBACK từ chối
const sub = (c, t) => new Promise((res) => c.subscribe(t, (err, g) => res(err ? 128 : g?.[0]?.qos)));
const base = (u) => `gw/${u.id}`;

// 1. Xác thực
ok(!(await connect({ username: A.username, password: 'sai-mat-khau' })), 'sai mật khẩu bị từ chối');
ok(!(await connect({})), 'ẩn danh bị từ chối');

const a = await connect(A);
const b = await connect(B);
ok(a && b, 'A và B đăng nhập được');
if (!a || !b) process.exit(1);

// 2. B không subscribe được topic của A
for (const k of ['telemetry', 'status', 'ack', 'history']) {
  ok((await sub(b, `${base(A)}/${k}`)) === 128, `B không đọc được ${base(A)}/${k}`);
  ok((await sub(a, `${base(A)}/${k}`)) !== 128, `A đọc được topic của mình: ${k}`);
}
for (const wild of ['#', 'gw/#', 'gw/+/telemetry', `gw/${A.id}/#`, '$SYS/#', 'gw/+/+']) {
  ok((await sub(b, wild)) === 128, `B không subscribe được wildcard ${wild}`);
}

// 3. B không nhận/không gây ảnh hưởng dữ liệu của A
const seenByB = [];
b.on('message', (t) => seenByB.push(t));
await sub(b, `${base(B)}/telemetry`);
a.publish(`${base(A)}/cmd`, '{"o":1}');
a.publish(`${base(A)}/telemetry`, '{"i":1}'); // user thường không có quyền ghi telemetry
await wait(500);
ok(seenByB.length === 0, 'B không nhận dữ liệu nào của A');

const seenByA = [];
a.on('message', (t) => seenByA.push(t));
b.publish(`${base(A)}/ack`, '{"x":1}'); // B giả ack vào site của A
await wait(500);
ok(seenByA.length === 0, 'A không nhận ack giả từ B');

// 4. Gói quá lớn (>4 KB) → broker ngắt kết nối
const big = await connect(A);
let dropped = false;
big.on('close', () => { dropped = true; });
big.publish(`${base(A)}/cmd`, 'x'.repeat(8192));
await wait(1000);
ok(dropped, 'gói 8 KB làm broker ngắt kết nối');

[a, b, big].forEach((c) => c.end(true));
console.log(fails ? `\n${fails} test hỏng` : '\nTất cả đạt');
process.exit(fails ? 1 : 0);
