#!/usr/bin/env node
/**
 * E2E thật cho Web Push, KHÔNG cần trình duyệt: đóng vai một "trình duyệt Firefox" bằng giao thức autopush của Mozilla.
 *   node scripts/e2e-push-mozilla.js --api https://plc.example --token <jwt> [--wait 60] [--keep]
 * 1. Đăng ký kênh push thật ở push.services.mozilla.com với khoá VAPID của server (GET /api/push/key).
 * 2. POST /api/push/subscribe, rồi POST /api/push/test → server gửi qua dịch vụ push thật.
 * 3. Nhận + giải mã thông báo (aes128gcm) và in ra. Với --wait N: tiếp tục lắng nghe N giây (cảnh báo ngưỡng/offline).
 * Kết thúc: POST /api/push/unsubscribe (trừ khi --keep).
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';
import ece from 'http_ece';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const api = String(arg('api', 'http://127.0.0.1:3080')).replace(/\/$/, '');
const token = arg('token', '');
const waitSec = Number(arg('wait', 0));
const keep = Boolean(arg('keep', false));
const b64u = (b) => Buffer.from(b).toString('base64url');
const call = async (p, method = 'GET', body) => {
  const r = await fetch(api + p, { method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const key = await call('/api/push/key');
if (key.status !== 200) { console.error('không lấy được VAPID key', key); process.exit(1); }

const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);
const channelID = crypto.randomUUID();
const ws = new WebSocket('wss://push.services.mozilla.com/', { headers: { Origin: 'http://localhost' } });
const got = [];
let endpoint = null;
const reg = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout đăng ký push')), 20000);
  ws.on('open', () => ws.send(JSON.stringify({ messageType: 'hello', use_webpush: true })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.messageType === 'hello') ws.send(JSON.stringify({ messageType: 'register', channelID, key: key.body.publicKey }));
    else if (m.messageType === 'register') { clearTimeout(t); m.status === 200 ? resolve(m.pushEndpoint) : reject(new Error('register ' + m.status)); }
    else if (m.messageType === 'notification') {
      try {
        const plain = ece.decrypt(Buffer.from(m.data, 'base64url'), { version: 'aes128gcm', privateKey: ecdh, authSecret });
        const p = JSON.parse(plain.toString());
        got.push(p);
        console.log('NHẬN:', JSON.stringify(p));
      } catch (e) { console.error('giải mã lỗi', e.message); }
      ws.send(JSON.stringify({ messageType: 'ack', updates: [{ channelID: m.channelID, version: m.version }] }));
    }
  });
  ws.on('error', reject);
});
endpoint = await reg;
console.log('endpoint:', new URL(endpoint).host);

const sub = await call('/api/push/subscribe', 'POST', { subscription: { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(authSecret) } } });
console.log('subscribe', sub.status, JSON.stringify(sub.body));
if (sub.status !== 200) process.exit(1);

const test = await call('/api/push/test', 'POST', {});
console.log('test', test.status, JSON.stringify(test.body));
const until = (cond, ms) => new Promise((r) => { const t0 = Date.now(); const i = setInterval(() => { if (cond() || Date.now() - t0 > ms) { clearInterval(i); r(); } }, 200); });
await until(() => got.length > 0, 20000);
const testOk = got.some((g) => g.tag === 'test');
console.log(testOk ? 'PASS push thử tới được thiết bị' : 'FAIL không nhận được push thử');

if (waitSec > 0) { console.log(`lắng nghe ${waitSec}s…`); await new Promise((r) => setTimeout(r, waitSec * 1000)); }
console.log('tổng thông báo nhận:', got.length, got.map((g) => g.b));
if (!keep) console.log('unsubscribe', (await call('/api/push/unsubscribe', 'POST', { endpoint })).status);
ws.close();
process.exit(testOk ? 0 : 1);
