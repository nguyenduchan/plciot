#!/usr/bin/env node
/**
 * Live test trên BROKER THẬT (mosquitto) dựng từ ACL do app sinh (gen-broker-test-config.js):
 * topic gw/<mqttId>/<kind> — mỗi gateway chỉ ghi/đọc topic của id mình; user app chỉ đọc topic gateway được xem.
 *   BROKER=mqtt://host:1883 BROKER_CTL=mqtt://host:1884 INFO=/đường/dẫn/info.json node scripts/smoke-mqtt-id-broker.js
 *
 * Mosquitto 2.x vẫn trả SUBACK "thành công" cho topic bị ACL cấm đọc rồi lọc ở lúc phát, nên kiểm tra theo THỰC TẾ phát/nhận gói
 * (không dựa vào mã SUBACK): gói không được tới nơi bị cấm.
 */
import fs from 'node:fs';
import mqtt from 'mqtt';

const E = process.env;
const info = JSON.parse(fs.readFileSync(E.INFO || './broker-test/info.json', 'utf8'));
const url = E.BROKER || 'mqtt://127.0.0.1:1883';
const urlCtl = E.BROKER_CTL || 'mqtt://127.0.0.1:1884';
let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(u, broker = url) {
  return new Promise((resolve) => {
    const c = mqtt.connect(broker, { username: u.user || u.username, password: u.pass || u.password, clientId: `t-${Math.random().toString(16).slice(2, 10)}`, reconnectPeriod: 0, connectTimeout: 5000 });
    c.once('connect', () => resolve(c));
    c.once('error', () => { c.end(true); resolve(null); });
    c.once('close', () => resolve(null));
  });
}
const sub = (c, ...topics) => Promise.all(topics.map((t) => new Promise((res) => c.subscribe(t, () => res()))));
const collect = (c) => { const seen = []; c.on('message', (t, p) => seen.push([t, p.toString()])); return seen; };
const from = (seen, tag) => seen.filter((x) => x[1].includes(tag));

const A = info.gwA, B = info.gwB;
const a = await connect(A), b = await connect(B);
const ua = await connect(info.userA), ub = await connect(info.userB);
const ing = await connect(info.ingest), ctl = await connect(info.ctl, urlCtl);
ok(a && b && ua && ub && ing && ctl, 'đăng nhập đủ: 2 gateway, 2 user app, ingest, ctl');
ok(!(await connect({ user: A.user, pass: 'sai' })), 'sai mật khẩu bị từ chối');
ok(!(await connect({ user: A.user, pass: '' })), 'mật khẩu rỗng bị từ chối');
if (![a, b, ua, ub, ing, ctl].every(Boolean)) process.exit(1);

const seenIng = collect(ing), seenUA = collect(ua), seenUB = collect(ub), seenA = collect(a), seenB = collect(b);
// Mỗi bên đăng ký cả topic của mình lẫn mọi cách "với" tới topic người khác
await sub(ing, 'gw/+/telemetry', 'gw/+/status', 'gw/+/config', 'gw/+/cmd');
await sub(ua, `gw/${A.id}/telemetry`, `gw/${A.id}/status`, `gw/${B.id}/telemetry`, `gw/${B.id}/status`, '#', 'gw/#', 'gw/+/telemetry', 'gw/+/+', 'plc/#', 'iot/#');
await sub(ub, `gw/${A.id}/telemetry`, `gw/${B.id}/telemetry`, '#', 'gw/#', 'gw/+/telemetry');
await sub(a, `gw/${A.id}/cmd`, `gw/${B.id}/cmd`, `gw/${B.id}/telemetry`, 'gw/+/cmd', 'gw/#', '#');
await sub(b, `gw/${B.id}/cmd`, `gw/${A.id}/cmd`, 'gw/+/cmd', '#');

// 1) gateway ghi đúng topic của mình
a.publish(`gw/${A.id}/telemetry`, '{"tag":"A-tele"}', { qos: 1 });
a.publish(`gw/${A.id}/status`, 'A-online', { qos: 1 });
b.publish(`gw/${B.id}/telemetry`, '{"tag":"B-tele"}', { qos: 1 });
await wait(700);
ok(from(seenIng, 'A-tele').length >= 1 && from(seenIng, 'A-online').length >= 1 && from(seenIng, 'B-tele').length >= 1, 'ingest nhận telemetry/status của cả hai gateway qua gw/+/<kind>');
ok(from(seenUA, 'A-tele').length >= 1 && from(seenUA, 'A-online').length >= 1, 'user A nhận telemetry + status của gateway A');
ok(from(seenUA, 'B-tele').length === 0, 'user A KHÔNG nhận dữ liệu gateway B (kể cả subscribe #, gw/#, gw/+/telemetry)');
ok(from(seenUB, 'B-tele').length >= 1 && from(seenUB, 'A-tele').length === 0 && from(seenUB, 'A-online').length === 0, 'user B chỉ nhận gateway B');
ok(from(seenA, 'B-tele').length === 0, 'gateway A không nghe được telemetry gateway B');

// 2) giả mạo: gateway A ghi vào topic gateway B / topic cũ; user app ghi telemetry/cmd
a.publish(`gw/${B.id}/telemetry`, '{"tag":"FAKE1"}', { qos: 1 });
a.publish(`gw/${B.id}/status`, 'FAKE2', { qos: 1 });
a.publish('plc/siteB/gwB/telemetry', '{"tag":"FAKE3"}', { qos: 1 });
a.publish('iot/default/siteB/gwB/telemetry', '{"tag":"FAKE4"}', { qos: 1 });
ua.publish(`gw/${A.id}/telemetry`, '{"tag":"FAKE5"}', { qos: 1 });
ua.publish(`gw/${A.id}/cmd`, '{"tag":"FAKE6"}', { qos: 1 });
b.publish(`gw/${A.id}/cmd`, '{"tag":"FAKE7"}', { qos: 1 });
await wait(800);
const allSeen = [...seenIng, ...seenUA, ...seenUB, ...seenA, ...seenB];
ok(!allSeen.some((x) => x[1].includes('FAKE')), 'mọi gói giả mạo (topic gateway khác, topic cũ plc/ iot/, user ghi, gateway ghi cmd) bị broker chặn');

// 3) ctl ghi cmd: chỉ gateway có đúng id nhận
ctl.publish(`gw/${A.id}/cmd`, '{"tag":"CMD-A"}', { qos: 1 });
ctl.publish(`gw/${B.id}/cmd`, '{"tag":"CMD-B"}', { qos: 1 });
await wait(700);
ok(from(seenA, 'CMD-A').length >= 1 && from(seenA, 'CMD-B').length === 0, 'gateway A nhận cmd của A, không nhận cmd của B');
ok(from(seenB, 'CMD-B').length >= 1 && from(seenB, 'CMD-A').length === 0, 'gateway B nhận cmd của B, không nhận cmd của A');
ok(from(seenUA, 'CMD-A').length === 0 && from(seenUB, 'CMD-B').length === 0, 'user app không thấy cmd (không có quyền đọc cmd)');

[a, b, ua, ub, ing, ctl].forEach((c) => c.end(true));
console.log(fails ? `\n${fails} test hỏng` : '\nTất cả đạt');
process.exit(fails ? 1 : 0);
