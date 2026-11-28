#!/usr/bin/env node
// Lệnh nhanh cho board (cmdSign.js "mac"): tương thích ngược + board tính lại được mac từ khoá riêng của mình.
// Hàm thuần — không DB, không MQTT, không đụng ACL. Khoá lệnh server dùng khoá tạm (DATA_DIR tạm).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdmac-'));
delete process.env.CMD_SIGN_KEY_PEM;
const { signCmd, verifySignedCmd, setMacPeerResolver, cmdPublicKey, cmdMessage, macInfo } = await import('../src/cmdSign.js');

let fails = 0;
const ok = (c, m) => { if (c) console.log('OK  ', m); else { fails++; console.error('FAIL', m); } };

const MQ = 'ab12cd34ef56ab78';
const board = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const boardSpki = board.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const cmd = { id: 'c1', ts: 1795800000000, child: 'pump1', key: 'run', v: 1 };

// 1) chưa biết khoá gateway → như cũ (không mac)
setMacPeerResolver(() => null);
const plain = signCmd(MQ, cmd);
ok(!plain.includes('"mac"') && verifySignedCmd(MQ, plain), 'không có khoá gateway: chỉ sig, kiểm được');

// 2) biết khoá gateway → có mac, sig vẫn đúng (gateway cũ không đổi gì)
setMacPeerResolver((id) => (id === MQ ? boardSpki : null));
const raw = signCmd(MQ, cmd);
ok(/,"mac":"[A-Za-z0-9_-]{43}","sig":"/.test(raw), 'có mac đứng ngay trước sig');
ok(verifySignedCmd(MQ, raw), 'gateway cũ: sig (trên chuỗi có mac) vẫn hợp lệ');
const parsedOld = JSON.parse(raw);
ok(parsedOld.v === 1 && parsedOld.child === 'pump1', 'gateway cũ: JSON vẫn đọc được (mac là trường thừa)');

// 3) board tính mac giống firmware (crypto.cpp verifyMac): Z = ECDH(khoá riêng board, khoá lệnh server)
function boardVerify(r, mqttId, boardPriv, serverSpki) {
  const im = r.lastIndexOf(',"mac":"'), is = r.lastIndexOf(',"sig":"');
  if (im < 0 || is <= im) return null;
  const mac = r.slice(im + 8, is - 1);
  const json = `${r.slice(0, im)}}`;
  const z = crypto.diffieHellman({ privateKey: boardPriv, publicKey: crypto.createPublicKey({ key: Buffer.from(serverSpki, 'base64url'), format: 'der', type: 'spki' }) });
  const k = crypto.createHmac('sha256', z).update(macInfo(mqttId)).digest();
  const want = crypto.createHmac('sha256', k).update(cmdMessage(mqttId, json)).digest();
  const got = Buffer.from(mac, 'base64url');
  return got.length === 32 && crypto.timingSafeEqual(want, got) ? json : null;
}
const json = boardVerify(raw, MQ, board.privateKey, cmdPublicKey());
ok(json === JSON.stringify(cmd), 'board tính lại đúng mac → JSON lệnh gốc (không mac)');

// 4) giả mạo / phát lại sang gateway khác
const tampered = raw.replace('"v":1', '"v":0');
ok(boardVerify(tampered, MQ, board.privateKey, cmdPublicKey()) === null && !verifySignedCmd(MQ, tampered), 'sửa lệnh → mac và sig đều hỏng');
ok(boardVerify(raw, 'ffffffffffffffff', board.privateKey, cmdPublicKey()) === null, 'mqttId khác → mac hỏng (không phát lại sang gateway khác)');
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
ok(boardVerify(raw, MQ, other.privateKey, cmdPublicKey()) === null, 'board khác (khoá riêng khác) không tính được mac');

// 5) khoá gateway không phải P-256 → bỏ mac, vẫn ký như cũ
const ed = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
setMacPeerResolver(() => ed);
const r5 = signCmd('1111222233334444', cmd);
ok(!r5.includes('"mac"') && verifySignedCmd('1111222233334444', r5), 'khoá gateway lạ → không mac, sig như cũ');

console.log(fails ? `FAILED ${fails}` : 'cmd-mac smoke OK');
process.exit(fails ? 1 : 0);
