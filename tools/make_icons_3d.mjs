/**
 * Sinh bộ icon đại diện cho webapp giám sát + điều khiển: webapp/icon.svg (bo góc) + PNG 180/192/512 + maskable 512 (vùng an toàn).
 *   node tools/make_icons_3d.mjs                       ghi đè icon của webapp
 *   node tools/make_icons_3d.mjs --preview <thư mục>   chỉ xuất ảnh xem thử
 * (cần Chrome/Edge cài sẵn; dùng `ws` của cloud/app để chụp PNG)
 *
 * Ý tưởng: KHÔNG chữ, KHÔNG dùng mô-típ quen thuộc của hệ thống giám sát (màn hình, đường xung, mắt, khiên).
 * Nhìn từ trên xuống, hình chiếm ~80% icon, khối nổi nhẹ (phẳng hiện đại, ít phối cảnh):
 *  GIÁM SÁT   = vòng đo lớn có vạch chia, cung giá trị phát sáng, viên ngọc cảm biến "đang sống" ở đầu cung.
 *  ĐIỀU KHIỂN = núm xoay ở giữa, kim chỉ đúng tới giá trị đang đo.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(HERE, '../cloud/app/package.json'));
const WebSocket = require('ws');
const OUT = path.resolve(HERE, '../webapp');

const f = (n) => Number(n.toFixed(2));
const C = 256;                                       // tâm icon
const R = 168;                                       // bán kính đường vòng đo
const pt = (deg, r) => { const t = (deg * Math.PI) / 180; return [f(C + r * Math.cos(t)), f(C + r * Math.sin(t))]; };
// Góc tính từ phải theo chiều kim đồng hồ (90° = dưới). Vòng đo hở ở phía dưới.
const T0 = 125; const T1 = 415;                      // toàn thang
const V1 = 330;                                      // đầu cung giá trị hiện tại
const arc = (a0, a1, r) => { const [x0, y0] = pt(a0, r); const [x1, y1] = pt(a1, r); return `M${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
function ticks() {
  let out = '';
  for (let a = T0; a <= T1 + 0.1; a += 6) {
    const major = Math.round(a - T0) % 30 === 0; const on = a <= V1;
    const [x1, y1] = pt(a, R + 26); const [x2, y2] = pt(a, R + (major ? 42 : 36));
    out += `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${on ? '#eaf6ff' : '#c7d2fe'}" stroke-opacity="${on ? 0.95 : 0.42}" stroke-width="${major ? 5 : 3.2}" stroke-linecap="round"/>`;
  }
  return out;
}
function notches() {                                 // khía chống trượt quanh rìa núm
  let out = '';
  for (let a = 0; a < 360; a += 12) { const [x1, y1] = pt(a, 101); const [x2, y2] = pt(a, 113); out += `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="#4a3bc4" stroke-opacity=".34" stroke-width="3.4" stroke-linecap="round"/>`; }
  return out;
}
const [vx, vy] = pt(V1, R);                          // vị trí viên ngọc cảm biến
const [pr0x, pr0y] = pt(V1, 16); const [pr1x, pr1y] = pt(V1, 72);   // kim chỉ hướng tới giá trị

/** scale < 1 thu nhỏ phần hình về giữa (vùng an toàn cho maskable); radius > 0 bo góc nền (icon.svg). */
function svg({ radius = 0, scale = 1 } = {}) {
  const t = scale === 1 ? '' : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b7cff"/><stop offset=".5" stop-color="#4d41d4"/><stop offset="1" stop-color="#261d8e"/></linearGradient>
  <radialGradient id="blobA" cx=".18" cy=".92" r=".6"><stop offset="0" stop-color="#2dd4bf" stop-opacity=".55"/><stop offset="1" stop-color="#2dd4bf" stop-opacity="0"/></radialGradient>
  <radialGradient id="blobB" cx=".9" cy=".08" r=".55"><stop offset="0" stop-color="#ff9ad5" stop-opacity=".5"/><stop offset="1" stop-color="#ff9ad5" stop-opacity="0"/></radialGradient>
  <linearGradient id="arc" gradientUnits="userSpaceOnUse" x1="70" y1="0" x2="440" y2="0"><stop offset="0" stop-color="#5eead4"/><stop offset=".5" stop-color="#7dd3fc"/><stop offset="1" stop-color="#ffd37a"/></linearGradient>
  <radialGradient id="knob" cx=".36" cy=".3" r=".9"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#dfe7ff"/><stop offset="1" stop-color="#8d9cf5"/></radialGradient>
  <radialGradient id="cap" cx=".36" cy=".3" r=".95"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#e8eeff"/><stop offset="1" stop-color="#a8b4ff"/></radialGradient>
  <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b4fd8"/><stop offset="1" stop-color="#2b1f96"/></linearGradient>
  <linearGradient id="pointer" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9f3a"/><stop offset="1" stop-color="#ffd27a"/></linearGradient>
  <radialGradient id="orb" cx=".34" cy=".28" r=".85"><stop offset="0" stop-color="#fff"/><stop offset=".22" stop-color="#a5f3ff"/><stop offset=".6" stop-color="#7c8bff"/><stop offset="1" stop-color="#3a2bb5"/></radialGradient>
  <radialGradient id="core" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff7dc"/><stop offset=".45" stop-color="#ffc766"/><stop offset="1" stop-color="#ff7a59" stop-opacity="0"/></radialGradient>
  <linearGradient id="tileGloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="13"/></filter>
  <filter id="dotglow" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="5"/></filter>
  <clipPath id="tile"><rect width="512" height="512" rx="${radius}"/></clipPath>
</defs>
<g clip-path="url(#tile)">
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#blobA)"/><rect width="512" height="512" fill="url(#blobB)"/>
  <g${t}>
    <!-- GIÁM SÁT: vòng đo lớn -->
    <path d="${arc(T0, T1, R)}" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="32" stroke-linecap="round"/>
    ${ticks()}
    <path d="${arc(T0, V1, R)}" fill="none" stroke="url(#arc)" stroke-opacity=".6" stroke-width="40" stroke-linecap="round" filter="url(#glow)"/>
    <path d="${arc(T0, V1, R)}" fill="none" stroke="url(#arc)" stroke-width="32" stroke-linecap="round"/>
    <path d="${arc(T0 + 2, V1 - 2, R - 8)}" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="4" stroke-linecap="round"/>
    <!-- viên ngọc cảm biến "đang sống" ở đầu cung -->
    <circle cx="${vx}" cy="${vy}" r="40" fill="#ffd37a" opacity=".65" filter="url(#dotglow)"/>
    <circle cx="${vx}" cy="${vy}" r="25" fill="url(#orb)"/>
    <circle cx="${f(vx + 1.5)}" cy="${f(vy + 3)}" r="13" fill="url(#core)"/>
    <ellipse cx="${f(vx - 8)}" cy="${f(vy - 9)}" rx="9" ry="5" transform="rotate(-35 ${f(vx - 8)} ${f(vy - 9)})" fill="#fff" opacity=".9"/>
    <circle cx="${vx}" cy="${vy}" r="24.5" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.6"/>
    <!-- ĐIỀU KHIỂN: núm xoay -->
    <circle cx="${C}" cy="${C + 22}" r="122" fill="#0b0640" opacity=".5" filter="url(#soft)"/>
    <circle cx="${C}" cy="${C + 10}" r="120" fill="url(#edge)"/>
    <circle cx="${C}" cy="${C}" r="120" fill="url(#knob)"/>
    <circle cx="${C}" cy="${C}" r="120" fill="none" stroke="#fff" stroke-width="2.4"/>
    ${notches()}
    <circle cx="${C}" cy="${C}" r="92" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="2"/>
    <circle cx="${C}" cy="${C + 2}" r="92" fill="none" stroke="#4a3bc4" stroke-opacity=".22" stroke-width="2"/>
    <circle cx="${C}" cy="${C + 5}" r="78" fill="#2b1f96" opacity=".28"/>
    <circle cx="${C}" cy="${C}" r="78" fill="url(#cap)"/>
    <circle cx="${C}" cy="${C}" r="78" fill="none" stroke="#fff" stroke-width="2"/>
    <ellipse cx="${C - 28}" cy="${C - 42}" rx="34" ry="13" transform="rotate(-32 ${C - 28} ${C - 42})" fill="#fff" opacity=".85"/>
    <!-- kim chỉ phát sáng: hướng đúng tới giá trị đang đo -->
    <path d="M${pr0x} ${pr0y}L${pr1x} ${pr1y}" stroke="#ff9f3a" stroke-opacity=".7" stroke-width="22" stroke-linecap="round" filter="url(#glow)"/>
    <path d="M${pr0x} ${pr0y}L${pr1x} ${pr1y}" stroke="url(#pointer)" stroke-width="13" stroke-linecap="round"/>
    <circle cx="${C}" cy="${C}" r="9" fill="#6d5fe6"/><circle cx="${C - 2}" cy="${C - 2}" r="3.6" fill="#fff"/>
  </g>
  <path d="M0 0h512v176C400 214 120 214 0 176z" fill="url(#tileGloss)" opacity=".45"/>
</g>
</svg>`;
}

async function render(svgText, size) {
  const port = 9150 + Math.floor(Math.random() * 90); const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-ic-'));
  const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const chrome = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--headless=new', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let ws, id = 0; const pend = new Map();
  try {
    let v; for (let i = 0; i < 40 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(400); } }
    ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false }, sessionId);
    const html = `<html><body style="margin:0;background:#000"><img style="width:${size}px;height:${size}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}"></body></html>`;
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') }, sessionId); await sleep(1500);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } }, sessionId);
    return Buffer.from(shot.data, 'base64');
  } finally { try { ws.close(); chrome.kill(); } catch { /* */ } await sleep(800); try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* */ } }
}

const preview = process.argv.includes('--preview');
const dest = preview ? process.argv[process.argv.indexOf('--preview') + 1] : OUT;
if (!preview) { fs.writeFileSync(path.join(OUT, 'icon.svg'), svg({ radius: 112 })); console.log('wrote icon.svg'); }
const jobs = preview ? [['preview-512.png', 512, {}], ['preview-180.png', 180, {}], ['preview-maskable.png', 512, { scale: 0.8 }]]
  : [['icon-180.png', 180, {}], ['icon-192.png', 192, {}], ['icon-512.png', 512, {}], ['icon-maskable-512.png', 512, { scale: 0.8 }]];
for (const [name, size, opt] of jobs) {
  fs.writeFileSync(path.join(dest, name), await render(svg(opt), size));   // PNG full-bleed vuông: iOS/Android tự bo góc
  console.log('wrote', name);
}
