#!/usr/bin/env node
/**
 * E2E thật: trình duyệt Chrome (headless, profile tạm) đăng ký Web Push, rồi ĐÓNG HẾT tab/trang → server gửi cảnh báo
 * → kiểm tra service worker vẫn nhận và hiện thông báo khi không có trang webapp nào đang mở.
 *   node scripts/e2e-push-browser.js --api https://plc.example --token <jwt> [--chrome <path>] [--trigger "<lệnh in ra rồi chạy>"]
 * Cần Chrome/Edge cài sẵn. Dùng CDP qua `ws`, không cần puppeteer.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const api = String(arg('api', 'http://127.0.0.1:3080')).replace(/\/$/, '');
const token = arg('token', '');
const chromePath = arg('chrome', ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p)));
const extraTrigger = arg('trigger', '');
const origin = new URL(api).origin;
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-push-chrome-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { if (c) console.log('OK  ', m); else { fails++; console.error('FAIL', m); } };

const chrome = spawn(chromePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let ws; let id = 0; const pending = new Map(); const events = [];
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
async function cleanup() { try { ws?.close(); } catch {} try { chrome.kill(); } catch {} await sleep(1500); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }

try {
  let ver;
  for (let i = 0; i < 40 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(500); } }
  if (!ver) throw new Error('Chrome không khởi động');
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else events.push(m); });

  await send('Browser.grantPermissions', { origin, permissions: ['notifications'] });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Page.navigate', { url: origin + '/login.html' }, sessionId);
  await sleep(3000);

  const subResult = await ev(`(async () => {
    const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ${JSON.stringify(token)} };
    const k = await (await fetch('/api/push/key', { headers: H })).json();
    const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.publicKey) });
    const r = await fetch('/api/push/subscribe', { method: 'POST', headers: H, body: JSON.stringify({ subscription: sub.toJSON() }) });
    return { perm: Notification.permission, endpointHost: new URL(sub.endpoint).host, status: r.status, body: await r.json() };
  })()`);
  console.log('đăng ký:', JSON.stringify(subResult));
  ok(subResult.status === 200, 'trình duyệt đăng ký push với server');

  // ĐÓNG TRANG webapp — không còn tab nào
  await send('Target.closeTarget', { targetId });
  await sleep(1500);
  const { targetInfos } = await send('Target.getTargets');
  const pages = targetInfos.filter((t) => t.type === 'page' && !t.url.startsWith('about:blank') && t.url.startsWith('http'));
  console.log('target còn lại:', targetInfos.map((t) => `${t.type}:${t.url.slice(0, 60)}`).join(' | '));
  ok(pages.length === 0, 'không còn trang webapp nào đang mở');

  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const t0 = Date.now();
  const test = await (await fetch(api + '/api/push/test', { method: 'POST', headers: H, body: '{}' })).json();
  console.log('server gửi:', JSON.stringify(test));
  ok(test.sent === 1, 'server gửi push thành công tới push service');
  if (extraTrigger) console.log('trigger ngoài:', extraTrigger);

  // Chờ service worker nhận push: hỏi registration.getNotifications() qua một trang about:blank-origin? Dùng SW target.
  let shown = null;
  for (let i = 0; i < 40 && !shown; i++) {
    await sleep(1000);
    const { targetInfos: ts } = await send('Target.getTargets');
    const sw = ts.find((t) => t.type === 'service_worker' && t.url.startsWith(origin));
    if (!sw) continue;
    try {
      const a = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
      const r = await send('Runtime.evaluate', { expression: `self.registration.getNotifications().then(l => JSON.stringify(l.map(n => ({ title: n.title, body: n.body, tag: n.tag, ts: n.timestamp }))))`, awaitPromise: true, returnByValue: true }, a.sessionId);
      const list = JSON.parse(r.result.value || '[]');
      const mine = list.filter((n) => n.ts >= t0 - 5000);
      if (mine.length) shown = mine;
      await send('Target.detachFromTarget', { sessionId: a.sessionId }).catch(() => {});
    } catch { /* SW đang khởi động lại */ }
  }
  console.log('thông báo đang hiển thị:', JSON.stringify(shown));
  ok(Boolean(shown && shown.some((n) => n.tag === 'test')), 'service worker nhận push và hiện thông báo khi webapp đóng');

} catch (e) {
  fails++; console.error('LỖI:', e.message);
}
// gỡ đăng ký phía server
try { await fetch(api + '/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ endpoint: '' }) }); } catch {}
await cleanup();
console.log(fails ? `\n${fails} lỗi` : '\ne2e-push-browser OK');
process.exit(fails ? 1 : 0);
