#!/usr/bin/env node
/**
 * Ký gói cập nhật GatewayApp (ECDSA P-256, SHA-256, IEEE P1363) — GatewayApp chỉ cài gói có chữ ký khớp khoá công khai gắn cứng
 * trong app (tools/GatewayApp/UpdateSignature.cs). Thông điệp ký: `gw1|<sha256 hex của file zip>|<version>|<apiLevel>`.
 * Cùng kiểu với firmware board (sign-mcu-firmware.js) nhưng KHOÁ RIÊNG và tiền tố khác: chữ ký firmware không dùng được cho gateway.
 *
 * Khoá riêng NẰM NGOÀI REPO: env GW_SIGN_KEY (đường dẫn PEM) hoặc %USERPROFILE%/.plciot/gw-sign.pem. Máy nào chạy sync-vps (publish-gateway.ps1)
 * cần có khoá này (chép tay qua USB, không qua git). Mất khoá → gateway đang chạy không nhận bản mới nữa (phải cài tay); lộ khoá → ai cũng ký được.
 *
 *   node scripts/sign-gateway-release.js --genkey                         tạo khoá (nếu chưa có), in khoá công khai cho UpdateSignature.cs
 *   node scripts/sign-gateway-release.js --pub                            in khoá công khai của khoá đang có
 *   node scripts/sign-gateway-release.js sign <zip> <version> <apiLevel>  in JSON { sha256, sig, pub }
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const keyFile = process.env.GW_SIGN_KEY || path.join(os.homedir(), '.plciot', 'gw-sign.pem');
const args = process.argv.slice(2);

function loadKey() {
  if (!fs.existsSync(keyFile)) throw new Error(`Không thấy khoá ký gateway ${keyFile} — chạy --genkey trước, hoặc chép khoá từ máy phát hành (đặt GW_SIGN_KEY)`);
  return crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
}
const spkiOf = (priv) => crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64url');

function gatewaySignMessage(sha256, version, apiLevel) {
  return Buffer.from(`gw1|${String(sha256).toLowerCase()}|${version}|${Number(apiLevel) | 0}`, 'utf8');
}

if (args[0] === '--genkey') {
  if (!fs.existsSync(keyFile)) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.error(`Đã tạo khoá ký gateway ${keyFile} — SAO LƯU ngoài máy, không đưa vào git.`);
  }
  console.log(spkiOf(loadKey()));
} else if (args[0] === '--pub') {
  console.log(spkiOf(loadKey()));
} else if (args[0] === 'sign' && args[1] && args[2] && args[3]) {
  const [, zip, version, apiLevel] = args;
  if (!/^[0-9a-f]{6,32}$/.test(version)) throw new Error('version phải là hex 6..32 ký tự (như manifest)');
  if (!/^[1-9][0-9]{0,3}$/.test(apiLevel)) throw new Error('apiLevel phải là số nguyên dương');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  const priv = loadKey();
  const sig = crypto.sign('sha256', gatewaySignMessage(sha256, version, apiLevel), { key: priv, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  console.log(JSON.stringify({ sha256, sig, pub: spkiOf(priv) }));
} else {
  console.log('Dùng: --genkey | --pub | sign <zip> <version> <apiLevel>');
  process.exit(1);
}
