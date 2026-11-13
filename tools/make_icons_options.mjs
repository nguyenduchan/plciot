/**
 * Icon ứng dụng theo ĐÚNG phong cách 3D của chính app (bộ "Đẹp (3D)" trong webapp/icons-3d.js + icons-3d-more.js):
 * thiết bị công nghiệp khối kim loại (gradient kim loại/thép/tối, viền mảnh tối, tô nhẹ màu nhấn), đặt trên ô nền xanh chuyển sắc
 * có ánh bóng, kèm sóng wifi (thiết bị nối mạng). KHÔNG chữ trên icon. Hình thiết bị lấy trực tiếp từ bộ icon của app nên luôn đồng bộ.
 *
 *   node tools/make_icons_options.mjs --sheet <thư mục>   xuất ảnh xem thử các phương án (sheet.png + từng file svg)
 *   node tools/make_icons_options.mjs --apply <khoá>      ghi phương án đã chọn vào webapp (icon.svg + PNG 180/192/512 + maskable)
 * (cần Chrome/Edge cài sẵn; dùng `ws` của cloud/app để chụp PNG)
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(HERE, '../cloud/app/package.json'));
const WebSocket = require('ws');
const WEB = path.resolve(HERE, '../webapp');
const OUT = WEB;

// --- nạp bộ icon 3D của app (chạy file gốc trong sandbox, không sao chép hình) ---
const sandbox = { window: {}, document: { body: null, addEventListener() {}, getElementById() { return null; } } };
vm.createContext(sandbox);
const src3d = fs.readFileSync(path.join(WEB, 'icons-3d.js'), 'utf8');
vm.runInContext(src3d, sandbox); vm.runInContext(fs.readFileSync(path.join(WEB, 'icons-3d-more.js'), 'utf8'), sandbox);
const ICONS = sandbox.window.PlcIcons3D;
const DEFS = (src3d.match(/const defs = `<svg[^>]*><defs>([\s\S]*?)<\/defs>/) || [])[1] || '';   // gradient g3-* dùng chung (khối trong chuỗi `defs`)
if (!DEFS.includes('g3-metal')) throw new Error('Không tách được gradient g3-* từ icons-3d.js');
const ACC = '#8dbbff';                                                           // màu nhấn tô lên thiết bị (sáng hơn mặc định #3b82f6 của app để nổi trên nền xanh)
const inner = (key) => ICONS[key]().replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').replaceAll('var(--acc,#3b82f6)', ACC);

// Các thiết bị điều khiển / giám sát để chọn
const OPTS = {
  a: { icon: 'plc', name: 'Bộ điều khiển PLC' },
  b: { icon: 'vfd', name: 'Biến tần' },
  c: { icon: 'valve', name: 'Van điều khiển' },
  d: { icon: 'pump', name: 'Bơm công nghiệp' },
  e: { icon: 'tank', name: 'Bồn chứa' },
  f: { icon: 'conveyor', name: 'Băng tải' },
  g: { icon: 'gauge', name: 'Đồng hồ đo' },
  h: { icon: 'crane', name: 'Cầu trục' },
};

const f = (n) => Number(n.toFixed(2));
/** Sóng wifi trắng nổi (thiết bị nối mạng), tâm (cx,cy). */
function wifi(cx, cy, rs = [24, 46, 68]) {
  const arcs = rs.map((r) => {
    const a0 = (-135 * Math.PI) / 180; const a1 = (-45 * Math.PI) / 180;
    return `<path d="M${f(cx + r * Math.cos(a0))} ${f(cy + r * Math.sin(a0))}A${r} ${r} 0 0 1 ${f(cx + r * Math.cos(a1))} ${f(cy + r * Math.sin(a1))}"/>`;
  }).join('');
  return `<g filter="url(#ds)"><g fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round">${arcs}</g><circle cx="${cx}" cy="${cy}" r="9" fill="#fff"/></g>`;
}

/** radius > 0: bo góc nền (icon.svg / ảnh xem thử); scale < 1: thu nhỏ vào vùng an toàn (maskable). */
function svg(key, { radius = 0, scale = 1 } = {}) {
  const o = OPTS[key]; const S = 7.8;
  const t = scale === 1 ? '' : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>${DEFS}
  <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5e98f8"/><stop offset="1" stop-color="#224b8f"/></linearGradient>
  <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <filter id="ds" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="6" stdDeviation="5" flood-color="#0a1f4a" flood-opacity=".5"/></filter>
  <filter id="soft" x="-30%" y="-100%" width="160%" height="300%"><feGaussianBlur stdDeviation="9"/></filter>
  <clipPath id="tl"><rect width="512" height="512" rx="${radius}"/></clipPath>
</defs>
<g clip-path="url(#tl)">
  <rect width="512" height="512" fill="url(#tile)"/>
  <path d="M0 0h512v200C380 250 130 250 0 200z" fill="url(#gloss)"/>
  <g${t}>
    <ellipse cx="236" cy="452" rx="170" ry="16" fill="#0a1f4a" opacity=".55" filter="url(#soft)"/>
    <g filter="url(#ds)"><g transform="translate(${f(236 - 24 * S)} ${f(296 - 24 * S)}) scale(${S})">${inner(o.icon)}</g></g>
    ${wifi(414, 124)}
  </g>
</g></svg>`;
}

async function withChrome(fn) {
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
    const shot = async (html, w, h) => {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send('Page.navigate', { url: 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64') }, sessionId); await sleep(1500);
      const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }, sessionId);
      return Buffer.from(r.data, 'base64');
    };
    return await fn(shot);
  } finally { try { ws.close(); chrome.kill(); } catch { /* */ } await sleep(800); try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* */ } }
}
const img = (svgText, size) => `<img style="width:${size}px;height:${size}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}">`;

const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
if (arg('--sheet')) {
  const dir = arg('--sheet'); fs.mkdirSync(dir, { recursive: true });
  const cells = Object.keys(OPTS).map((k) => {
    fs.writeFileSync(path.join(dir, `icon-${k}.svg`), svg(k, { radius: 112 }));
    return `<div style="text-align:center"><div style="width:270px;height:270px;border-radius:61px;overflow:hidden;box-shadow:0 22px 34px -12px rgba(30,45,90,.45);margin:0 auto">${img(svg(k), 270)}</div><div style="margin-top:18px;font:600 19px system-ui,'Segoe UI',sans-serif;color:#2b3350">${k.toUpperCase()} · ${OPTS[k].name}</div></div>`;
  }).join('');
  const html = `<html><head><meta charset="utf-8"></head><body style="margin:0;background:#eef0f4;padding:44px 40px"><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:42px 16px;width:1200px">${cells}</div></body></html>`;
  const png = await withChrome((shot) => shot(html, 1280, 780));
  fs.writeFileSync(path.join(dir, 'sheet.png'), png);
  console.log('wrote', path.join(dir, 'sheet.png'));
} else if (arg('--apply')) {
  const k = arg('--apply').toLowerCase();
  if (!OPTS[k]) { console.error('Phương án không có:', k); process.exit(1); }
  fs.writeFileSync(path.join(OUT, 'icon.svg'), svg(k, { radius: 112 })); console.log('wrote icon.svg');
  await withChrome(async (shot) => {
    for (const [name, size, opt] of [['icon-180.png', 180, {}], ['icon-192.png', 192, {}], ['icon-512.png', 512, {}], ['icon-maskable-512.png', 512, { scale: 0.8 }]]) {
      fs.writeFileSync(path.join(OUT, name), await shot(`<html><body style="margin:0;background:#fff">${img(svg(k, opt), size)}</body></html>`, size, size));
      console.log('wrote', name);
    }
  });
} else { console.log('Dùng: --sheet <thư mục> | --apply <khoá>'); }
