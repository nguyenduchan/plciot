#!/usr/bin/env node
/**
 * Sinh QR mẫu CHO MỌI device type (+ PNG).
 *   cd cloud/app && node scripts/gen-sample-device-qrs.js
 *   node scripts/gen-sample-device-qrs.js --seed ./data/app.db
 *   node scripts/gen-sample-device-qrs.js --png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import {
  configure, migrateSecurity, generateClaimRootKeyPair, provisionHardwareDevice,
} from '@plciot/security';
import { DEVICE_TYPES } from '../src/uiContract.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../../../tools/sample-qrs');
const seedIdx = process.argv.indexOf('--seed');
const seedArg = seedIdx >= 0 ? process.argv[seedIdx + 1] : null;
const wantPng = process.argv.includes('--png');

let keys;
if (process.env.CLAIM_ROOT_PRIVATE_KEY && process.env.CLAIM_ROOT_PUBLIC_KEY) {
  keys = {
    privateKey: process.env.CLAIM_ROOT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    publicKey: process.env.CLAIM_ROOT_PUBLIC_KEY.replace(/\\n/g, '\n'),
  };
  console.log('Dùng CLAIM_ROOT_* từ env');
} else {
  keys = generateClaimRootKeyPair();
  console.log('Sinh cặp khoá demo → tools/sample-qrs/claim-root.env');
}

process.env.CLAIM_ROOT_PUBLIC_KEY = keys.publicKey;
process.env.CLAIM_ROOT_PRIVATE_KEY = keys.privateKey;
process.env.APP_JWT_SECRET = process.env.APP_JWT_SECRET || 'sample-qr-secret-16c';
configure({ secret: () => process.env.APP_JWT_SECRET });

const SITE = 'demo_home';

/** Một tem / type — đủ catalog DEVICE_TYPES. */
const TYPE_SAMPLES = Object.keys(DEVICE_TYPES).map((type) => ({
  device: type === 'iot-hub' ? 'gw01' : type === 'conveyor' ? 'plc01' : `${type}1`,
  label: DEVICE_TYPES[type].title,
  profile: type,
  note: `QR mẫu type=${type}`,
}));

const HUB_SEED = {
  device: 'gw01',
  label: 'Gateway nhà (seed all)',
  profile: 'iot-hub',
  note: 'QR tổng — seed mọi loại thiết bị con',
  uiMeta: {
    seed: Object.keys(DEVICE_TYPES)
      .filter((t) => t !== 'iot-hub')
      .map((t) => ({
        childId: t === 'conveyor' ? 'plc01' : `${t}1`,
        type: t,
        title: DEVICE_TYPES[t].title,
      })),
  },
};

// Hub trước, rồi từng type (gw01 trùng profile iot-hub — provision lần 2 cập nhật seed)
const SAMPLES = [HUB_SEED, ...TYPE_SAMPLES.filter((s) => s.device !== 'gw01')];

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'claim-root.env'),
  `CLAIM_ROOT_PUBLIC_KEY="${keys.publicKey.replace(/\n/g, '\\n')}"\n`
  + `CLAIM_ROOT_PRIVATE_KEY="${keys.privateKey.replace(/\n/g, '\\n')}"\n`);

function openSeedDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT 'x',
      folder_path TEXT NOT NULL DEFAULT 'f',
      version TEXT DEFAULT '1',
      notify_site TEXT DEFAULT 'factory1',
      notify_device TEXT DEFAULT 'plc01',
      site_owner INTEGER DEFAULT 0,
      role TEXT DEFAULT 'operator',
      disabled INTEGER DEFAULT 0,
      setup_complete INTEGER DEFAULT 1
    );
  `);
  migrateSecurity(db);
  return db;
}

const dbPath = seedArg ? path.resolve(seedArg) : path.join(outDir, '_tmp.db');
if (seedArg) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = openSeedDb(dbPath);
if (seedArg) console.log('Seed DB:', dbPath);

let QRCode = null;
if (wantPng) {
  try {
    QRCode = require('qrcode');
  } catch {
    console.warn('Chưa có package qrcode — chạy: npm i qrcode --no-save (trong cloud/app)');
  }
}

const index = [];
const seen = new Set();
for (const s of SAMPLES) {
  const key = `${SITE}/${s.device}`;
  if (seen.has(key) && s.device !== 'gw01') continue;
  seen.add(key);
  const r = provisionHardwareDevice(db, {
    site: SITE,
    device: s.device,
    label: s.label,
    note: s.note || '',
    profile: s.profile,
    uiMeta: s.uiMeta || null,
    privateKeyPem: keys.privateKey,
    rotate: true,
  });
  if (r.error) {
    console.error('FAIL', s.device, r);
    process.exit(1);
  }
  const file = `${SITE}_${s.device}.txt`;
  fs.writeFileSync(path.join(outDir, file), `${r.qr}\n`);
  fs.writeFileSync(path.join(outDir, `${SITE}_${s.device}.json`), JSON.stringify({
    site: r.site, device: r.device, label: s.label, profile: s.profile,
    loginUrl: r.loginUrl, qr: r.qr, uiMeta: s.uiMeta || null,
  }, null, 2));
  if (QRCode) {
    const png = path.join(outDir, `${SITE}_${s.device}.png`);
    await QRCode.toFile(png, r.qr, { width: 320, margin: 2 });
    console.log('png', path.basename(png));
  }
  index.push({
    file, site: SITE, device: s.device, profile: s.profile, label: s.label, loginUrl: r.loginUrl,
  });
  console.log('ok', s.device, s.profile, '→', file);
}

// Đảm bảo đủ mọi type trong index (kể cả chỉ có qua seed)
const profiles = new Set(index.map((i) => i.profile));
for (const t of Object.keys(DEVICE_TYPES)) {
  if (!profiles.has(t)) console.warn('WARN missing type sample:', t);
}

fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({
  site: SITE,
  types: Object.keys(DEVICE_TYPES),
  items: index,
}, null, 2));

fs.writeFileSync(path.join(outDir, 'README.md'), `# QR mẫu — mọi loại thiết bị

Site: \`${SITE}\`  
Types: ${Object.keys(DEVICE_TYPES).map((t) => `\`${t}\``).join(', ')}

## Test nhanh

\`\`\`bash
cd cloud/app
node scripts/e2e-add-devices-qr.js
\`\`\`

Webapp: đăng nhập → Tổng quan → **+ Thêm thiết bị** → dán \`.txt\` (hoặc quét \`.png\` nếu có).

Khuyến nghị: \`demo_home_gw01.txt\` trước (seed all).

## Danh sách

${index.map((i) => `- **${i.device}** (\`${i.profile}\`) — ${i.label} → \`${i.file}\``).join('\n')}
`);

if (!seedArg) {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(path.join(outDir, `_tmp.db${ext}`)); } catch { /* ignore */ }
  }
}
db.close();
console.log('\nĐã ghi', outDir, `| ${index.length} QR | types catalog=${Object.keys(DEVICE_TYPES).length}`);
