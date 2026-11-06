#!/usr/bin/env node
/**
 * Đăng ký phần cứng + in payload QR (ký Ed25519).
 *
 *   # Sinh cặp khoá gốc (một lần / môi trường):
 *   node scripts/provision-device-qr.js gen-keys
 *
 *   # Đăng ký thiết bị (cần CLAIM_ROOT_PRIVATE_KEY + APP_JWT_SECRET, DB):
 *   CLAIM_ROOT_PRIVATE_KEY="..." CLAIM_ROOT_PUBLIC_KEY="..." \
 *     node scripts/provision-device-qr.js provision factory1 plc01
 *
 *   # Hub nhiều thiết bị con + giới hạn giá trị + lệnh nguy hiểm (đặt LÚC PROVISIONING, đi theo tem/QR):
 *   node scripts/provision-device-qr.js provision plctest gw02 --profile iot-hub --label "Hub test" --meta hub.json
 *   # hub.json: { "seed": [ { "childId": "pump1", "type": "pump", "limits": { "run": {"min":0,"max":1} }, "critical": ["run"] } ] }
 *
 *   # Chỉ ký lại (không ghi DB) — kiểm tra chữ ký:
 *   node scripts/provision-device-qr.js sign factory1 plc01 <claimSecret>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateClaimRootKeyPair, provisionHardwareDevice, signClaimPayload, encodeClaimQr, verifyClaimSignature,
} from '@plciot/security';
import { openDb } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [cmd, ...args] = process.argv.slice(2);

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

if (cmd === 'gen-keys') {
  const pair = generateClaimRootKeyPair();
  console.log('# CLAIM_ROOT_PUBLIC_KEY (PEM, một dòng \\n được giữ)');
  console.log(pair.publicKey.trim());
  console.log('\n# CLAIM_ROOT_PRIVATE_KEY (PEM — chỉ máy provision)');
  console.log(pair.privateKey.trim());
  process.exit(0);
}

if (cmd === 'sign') {
  const [site, device, claim] = args;
  if (!site || !device || !claim) die('usage: sign <site> <device> <claimSecret>');
  if (!process.env.CLAIM_ROOT_PRIVATE_KEY) die('CLAIM_ROOT_PRIVATE_KEY required');
  const payload = signClaimPayload({ site, device, claim });
  const qr = encodeClaimQr(payload);
  const check = verifyClaimSignature(payload);
  if (check.error) die(check.error);
  console.log(JSON.stringify({ payload, qr }, null, 2));
  process.exit(0);
}

if (cmd === 'provision') {
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const [site, device, claim] = positional;
  if (!site || !device) die('usage: provision <site> <device> [claimSecret] [--profile iot-hub] [--label text] [--meta file.json]');
  let uiMeta = null;
  if (opt('--meta')) {
    try { uiMeta = JSON.parse(fs.readFileSync(opt('--meta'), 'utf8')); } catch (e) { die(`--meta không đọc được: ${e.message}`); }
  }
  if (!process.env.CLAIM_ROOT_PRIVATE_KEY) die('CLAIM_ROOT_PRIVATE_KEY required');
  if (!process.env.CLAIM_ROOT_PUBLIC_KEY) die('CLAIM_ROOT_PUBLIC_KEY required (server cũng cần)');
  if (!process.env.APP_JWT_SECRET || process.env.APP_JWT_SECRET.length < 16) {
    die('APP_JWT_SECRET (>=16) required for openDb/migrate');
  }
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const db = openDb(dataDir);
  const result = provisionHardwareDevice(db, { site, device, claim: claim || undefined, profile: opt('--profile') || '', label: opt('--label') || '', uiMeta });
  if (result.error) die(result.error);
  console.log(JSON.stringify({
    site: result.site,
    device: result.device,
    qr: result.qr,
    payload: result.payload,
    loginHint: `login.html?claim=${encodeURIComponent(result.qr)}`,
  }, null, 2));
  process.exit(0);
}

die(`usage:
  node scripts/provision-device-qr.js gen-keys
  node scripts/provision-device-qr.js provision <site> <device> [claimSecret]
  node scripts/provision-device-qr.js sign <site> <device> <claimSecret>`);
