#!/usr/bin/env node
/**
 * Sao chép client dùng chung vào thư mục webapp của một app (mặc định ../../webapp/security) để nó được phục vụ
 * và đóng gói offline cùng webapp. Bản sao có dòng cảnh báo "GENERATED"; --check chỉ so sánh (dùng trong test/CI).
 *   node scripts/sync-client.js [thư-mục-đích] [--check]
 *
 * Trang đăng nhập cũng dùng chung: client/login.template.html + client/login.css. Nếu cạnh thư mục đích có login.config.json
 * (thương hiệu của app: title, subtitle, icon, themeColor, stylesheet, appScripts, demoButton...) thì sinh ra login.html cho app đó.
 * App mới chỉ cần viết login.config.json rồi chạy lệnh này, không tự viết lại HTML/CSS/luồng các bước đăng nhập.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'client');
const args = process.argv.slice(2);
const check = args.includes('--check');
const dest = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(here, '..', '..', '..', 'webapp', 'security'));
const appDir = path.dirname(dest);
const banner = (f) => `/* GENERATED từ packages/security/client/${f} bằng "npm run sync-client". KHÔNG sửa ở đây. */\n`;
const norm = (s) => s.replace(/\r\n/g, '\n');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

let drift = 0;
function write(target, want) {
  const have = fs.existsSync(target) ? norm(fs.readFileSync(target, 'utf8')) : null;
  if (have === want) return;
  if (check) { drift++; console.error(`DRIFT ${path.relative(process.cwd(), target)}`); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, want);
  console.log(`đã ghi ${path.relative(process.cwd(), target)}`);
}

for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js') || x === 'login.css')) {
  write(path.join(dest, f), banner(f) + norm(fs.readFileSync(path.join(srcDir, f), 'utf8')));
}

/** Sinh login.html từ mẫu dùng chung + cấu hình thương hiệu của app. */
const cfgFile = path.join(appDir, 'login.config.json');
if (fs.existsSync(cfgFile)) {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const d = { themeColor: '#1a1a1a', manifest: 'manifest.json', icon: 'icon.svg', appleIcon: 'icon-180.png', stylesheet: 'style.css', subtitle: '', appScripts: [], ...cfg };
  if (!d.title) throw new Error('login.config.json cần "title"');
  const parts = {
    appScripts: d.appScripts.map((s) => `<script src="${esc(s)}"></script>\n`).join(''),
    demoButton: d.demoButton ? `        <button type="button" id="demo" class="fit">${esc(d.demoButton)}</button>\n` : '',
  };
  let html = norm(fs.readFileSync(path.join(srcDir, 'login.template.html'), 'utf8'))
    .replace(/\{\{(\w+)\}\}/g, (_, k) => (k in parts ? parts[k] : esc(d[k] ?? '')));
  html = html.replace('<!doctype html>\n', '<!doctype html>\n<!-- GENERATED từ packages/security/client/login.template.html + login.config.json bằng "npm run sync-client". KHÔNG sửa ở đây. -->\n');
  write(path.join(appDir, 'login.html'), html);
}
if (check) { if (drift) process.exit(1); console.log('client khớp bản sao trong app'); }
