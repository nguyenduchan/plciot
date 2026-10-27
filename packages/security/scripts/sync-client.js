#!/usr/bin/env node
/**
 * Sao chép client dùng chung vào thư mục webapp của một app (mặc định ../../webapp/security) để nó được phục vụ
 * và đóng gói offline cùng webapp. Bản sao có dòng cảnh báo "GENERATED"; --check chỉ so sánh (dùng trong test/CI).
 *   node scripts/sync-client.js [thư-mục-đích] [--check]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'client');
const args = process.argv.slice(2);
const check = args.includes('--check');
const dest = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(here, '..', '..', '..', 'webapp', 'security'));
const banner = (f) => `/* GENERATED từ packages/security/client/${f} bằng "npm run sync-client". KHÔNG sửa ở đây. */\n`;

let drift = 0;
for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js'))) {
  const want = banner(f) + fs.readFileSync(path.join(srcDir, f), 'utf8').replace(/\r\n/g, '\n');
  const target = path.join(dest, f);
  const have = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
  if (have === want) continue;
  if (check) { drift++; console.error(`DRIFT ${path.relative(process.cwd(), target)}`); continue; }
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(target, want);
  console.log(`đã ghi ${path.relative(process.cwd(), target)}`);
}
if (check) { if (drift) process.exit(1); console.log('client khớp bản sao trong app'); }
