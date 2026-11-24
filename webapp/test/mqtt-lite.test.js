'use strict';
/* Test MqttLite với WebSocket giả + đồng hồ giả (chạy: node webapp/test/mqtt-lite.test.js [đường-dẫn-mqtt-lite.js]).
   Tái hiện lỗi iPhone: ở nền vài phút rồi mở lại -> "Mất kết nối" dù đã nối lại được. */
const assert = require('assert');
const path = require('path');

let now = 0, timers = [], seq = 0;
global.Date = class extends Date { static now() { return now; } };
global.setTimeout = (fn, ms) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; };
global.setInterval = (fn, ms) => { const id = ++seq; timers.push({ id, at: now + ms, fn, every: ms }); return id; };
global.clearTimeout = global.clearInterval = (id) => { timers = timers.filter((t) => t.id !== id); };
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const t = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!t) break;
    now = t.at; if (t.every) t.at += t.every; else timers = timers.filter((x) => x !== t);
    t.fn();
  }
  now = end;
}
const sockets = [];
class FakeWS {
  constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
  send(u8) { this.sent.push(u8); }
  close() { this.closing = true; }      // như socket zombie của iOS: 'close' KHÔNG tới ngay, test tự gọi fireClose()
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  rx(bytes) { this.onmessage && this.onmessage({ data: Uint8Array.from(bytes).buffer }); }
  fireClose() { this.readyState = 3; this.onclose && this.onclose(); }
}
global.WebSocket = FakeWS;
global.TextEncoder = TextEncoder; global.TextDecoder = TextDecoder;
const MqttLite = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'mqtt-lite.js')));
const CONNACK_OK = [0x20, 2, 0, 0];
const mk = () => { const ev = []; const c = new MqttLite({ url: 'wss://x', user: 'u', pass: 'p' });
  ['connect', 'close', 'error'].forEach((e) => c.on(e, () => ev.push(e))); return { c, ev }; };
const up = (c) => { c.connect(); const ws = sockets[sockets.length - 1]; ws.open(); ws.rx(CONNACK_OK); return ws; };
let fail = 0;
function test(name, fn) { try { sockets.length = 0; timers = []; fn(); console.log('ok   -', name); } catch (e) { fail++; console.log('FAIL -', name, '\n      ', e.message); } }

test('socket cũ đóng trễ KHÔNG được phát "close" sau khi kết nối mới đã lên (lỗi iPhone)', () => {
  const old = mk(); const oldWs = up(old.c);
  old.c.close();                       // app.js: link.stop() khi quay lại
  const fresh = mk(); up(fresh.c);     // link mới nối được ngay
  old.ev.length = 0;
  oldWs.fireClose();                   // vài giây sau socket zombie mới đóng xong
  assert.deepStrictEqual(old.ev, []);
});
test('đóng chủ động rồi không tự nối lại', () => {
  const m = mk(); const ws = up(m.c); m.c.close(); ws.fireClose(); advance(10000);
  assert.strictEqual(sockets.length, 1);
});
test('mất kết nối thật thì phát close và nối lại sau 3 giây', () => {
  const m = mk(); const ws = up(m.c); ws.fireClose(); advance(3100);
  assert.deepStrictEqual(m.ev, ['connect', 'close']); assert.strictEqual(sockets.length, 2);
});
test('bộ đệm gói dở dang không làm lệch CONNACK của lần nối sau', () => {
  const m = mk(); const ws = up(m.c);
  ws.rx([0x30, 100, 0, 3]);            // gói PUBLISH dở dang rồi rớt mạng
  ws.fireClose(); advance(3100);
  const ws2 = sockets[1]; ws2.open(); ws2.rx(CONNACK_OK);
  assert.deepStrictEqual(m.ev, ['connect', 'close', 'connect']);
});
test('socket im lặng quá 45 giây (half-open) thì tự phát close và nối lại', () => {
  const m = mk(); up(m.c); advance(50000);
  assert.ok(m.ev.includes('close')); advance(3100); assert.ok(sockets.length >= 2);
});
test('không có CONNACK trong 10 giây thì nối lại', () => {
  const m = mk(); m.c.connect(); sockets[0].open(); advance(11000); advance(3100);
  assert.ok(sockets.length >= 2);
});
process.exit(fail ? 1 : 0);
