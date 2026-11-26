#!/usr/bin/env node
/**
 * Ký firmware board Waveshare (ECDSA P-256, SHA-256, IEEE P1363) — board chỉ cài bản có chữ ký khớp khoá công khai gắn cứng
 * trong firmware (gateway-mcu/src/fwkey.h). Thông điệp ký: `fw1|<sha256 hex của file .bin>|<phiên bản>`.
 *
 * Khoá riêng NẰM NGOÀI REPO: env FW_SIGN_KEY (đường dẫn PEM) hoặc %USERPROFILE%/.plciot/fw-sign.pem. Mất khoá → board cũ không nhận
 * bản mới nữa (phải nạp lại qua USB); lộ khoá → ai cũng ký được: giữ như mật khẩu, sao lưu ngoài máy.
 *
 *   node scripts/sign-mcu-firmware.js --genkey                       tạo khoá (nếu chưa có), in khoá công khai cho fwkey.h
 *   node scripts/sign-mcu-firmware.js sign <firmware.bin> <phiên-bản> [--notes "…"] [--out <thư-mục releases/mcu>]
 *       → <firmware.bin>.json (GatewayApp nạp qua LAN đọc file này) + releases/mcu/{manifest.json, firmware-<phiên-bản>.bin}
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const keyFile = process.env.FW_SIGN_KEY || path.join(os.homedir(), '.plciot', 'fw-sign.pem');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

function loadKey() {
  if (!fs.existsSync(keyFile)) throw new Error(`Không thấy khoá ký ${keyFile} — chạy --genkey trước (hoặc đặt FW_SIGN_KEY)`);
  return crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
}
const spkiOf = (priv) => crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64url');

if (args[0] === '--genkey') {
  if (!fs.existsSync(keyFile)) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.error(`Đã tạo khoá ký ${keyFile} — SAO LƯU ngoài máy, không đưa vào git.`);
  }
  console.log(spkiOf(loadKey()));
} else if (args[0] === 'sign' && args[1] && args[2]) {
  const bin = args[1], version = args[2];
  if (!/^[0-9A-Za-z._-]{1,32}$/.test(version)) throw new Error('phiên bản chỉ gồm chữ, số, . _ -');
  const data = fs.readFileSync(bin);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const priv = loadKey();
  const sig = crypto.sign('sha256', Buffer.from(`fw1|${sha256}|${version}`, 'utf8'), { key: priv, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const builtAt = new Date().toISOString();
  fs.writeFileSync(`${bin}.json`, JSON.stringify({ Version: version, Sha256: sha256, Sig: sig, Size: data.length, BuiltAt: builtAt }, null, 2));
  const out = opt('--out');
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    const file = `firmware-${version}.bin`;
    for (const f of fs.readdirSync(out)) if (/^firmware-.*\.bin$/.test(f) && f !== file) fs.unlinkSync(path.join(out, f));   // chỉ giữ bản mới nhất
    fs.copyFileSync(bin, path.join(out, file));
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ version, file, sha256, sig, size: data.length, builtAt, notes: String(opt('--notes') || '').slice(0, 2000), pub: spkiOf(priv) }, null, 2));
  }
  console.log(JSON.stringify({ version, sha256, size: data.length, sig: `${sig.slice(0, 16)}…`, out: out || null }));
} else {
  console.log('Dùng: --genkey | sign <firmware.bin> <phiên-bản> [--notes "…"] [--out releases/mcu]');
  process.exit(1);
}
