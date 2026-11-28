/**
 * Ký lệnh server → gateway (ECDSA P-256, SHA-256, IEEE P1363) — gateway KHÔNG cần OTP riêng để nhận lệnh điều khiển từ cloud.
 *
 * Vì sao: người dùng đã qua step-up (Face ID / TOTP) ở /api/control/cmd; server là nơi duy nhất ký. Gateway chỉ cần
 * biết khoá công khai của server (nhận lúc enroll qua HTTPS) rồi kiểm chữ ký. Ai khác có quyền ghi MQTT cũng không giả được lệnh.
 *
 * Định dạng: JSON lệnh + thuộc tính CUỐI CÙNG `"sig":"<base64url>"`.
 *   thông điệp ký = `cmd1|<mqttId>|` + JSON lệnh (đúng chuỗi byte đứng trước `,"sig":"`, đóng bằng `}`)
 * mqttId nằm trong thông điệp → lệnh của gateway này không phát lại sang gateway khác. `ts` + `id` trong JSON chống phát lại (gateway kiểm).
 *
 * Khoá riêng: env CMD_SIGN_KEY_PEM, hoặc file DATA_DIR/cmd-sign.pem (tự sinh lần đầu, quyền 0600). Mất khoá → gateway cũ báo bad_sig
 * cho tới khi enroll/config lại (kit luôn mang khoá công khai hiện hành).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let cached = null;

function load() {
  if (cached) return cached;
  let pem = process.env.CMD_SIGN_KEY_PEM || '';
  if (!pem) {
    const file = path.join(path.resolve(process.env.DATA_DIR || './data'), 'cmd-sign.pem');
    try { pem = fs.readFileSync(file, 'utf8'); } catch { pem = ''; }
    if (!pem) {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, pem, { mode: 0o600 }); } catch { /* chỉ ở RAM: khoá đổi mỗi lần chạy */ }
    }
  }
  const priv = crypto.createPrivateKey(pem);
  const pub = crypto.createPublicKey(priv);
  cached = { priv, spki: pub.export({ type: 'spki', format: 'der' }).toString('base64url') };
  return cached;
}

/** Khoá công khai (SPKI DER base64url) đưa cho gateway trong kit. */
export function cmdPublicKey() { return load().spki; }

export const cmdMessage = (mqttId, json) => `cmd1|${mqttId}|${json}`;

// ---- "mac": lệnh nhanh cho board Waveshare ----
// Board kiểm ECDSA bằng phần mềm mất ~228 ms / lệnh (ESP32-S3). Có khoá danh tính của gateway (hardware_devices.gw_pubkey) → thêm
// "mac" = HMAC-SHA256(K, cmdMessage(mqttId, json không mac)), K = HMAC-SHA256(Z, "plciot-cmdmac1|<mqttId>"), Z = ECDH(khoá riêng lệnh,
// khoá danh tính gateway). "sig" vẫn ký trên chuỗi CÓ mac → gateway cũ (board cũ, GatewayApp) kiểm sig như trước, bỏ qua mac.
// Firmware mới (gateway-mcu/src/crypto.cpp verifyMac) kiểm mac (< 1 ms); mac sai/thiếu → kiểm sig như cũ.
let macPeer = null;                 // (mqttId) => spki base64url khoá danh tính gateway | null — server.js gắn (tra DB)
const macCache = new Map();         // mqttId → { spki, key, at }
const MAC_TTL = 5 * 60_000;         // đổi khoá gateway (ghép lại) → hết hạn cache trong 5 phút
export function setMacPeerResolver(fn) { macPeer = typeof fn === 'function' ? fn : null; macCache.clear(); }
export const macInfo = (mqttId) => `plciot-cmdmac1|${mqttId}`;
/** K của gateway (Buffer 32 byte) hoặc null (không biết khoá gateway / khoá không phải P-256). */
export function cmdMacKey(mqttId, spki = null) {
  const now = Date.now();
  if (!spki) {
    const c = macCache.get(mqttId);
    if (c && now - c.at < MAC_TTL) return c.key;
    try { spki = macPeer ? macPeer(mqttId) : null; } catch { spki = null; }
  }
  let key = null;
  if (spki) {
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' });
      if (pub.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
        const z = crypto.diffieHellman({ privateKey: load().priv, publicKey: pub });
        key = crypto.createHmac('sha256', z).update(macInfo(mqttId), 'utf8').digest();
      }
    } catch { key = null; }
  }
  if (macCache.size > 5000) macCache.clear();
  macCache.set(mqttId, { key, at: now });
  return key;
}

/** Trả chuỗi JSON đã ký (`...,"mac":"…","sig":"…"}` — mac chỉ khi biết khoá gateway) để publish. */
export function signCmd(mqttId, payload) {
  if (!mqttId) return JSON.stringify(payload);
  let json = JSON.stringify(payload);
  const k = cmdMacKey(mqttId);
  if (k) json = `${json.slice(0, -1)},"mac":"${crypto.createHmac('sha256', k).update(cmdMessage(mqttId, json), 'utf8').digest('base64url')}"}`;
  const sig = crypto.sign('sha256', Buffer.from(cmdMessage(mqttId, json), 'utf8'), { key: load().priv, dsaEncoding: 'ieee-p1363' });
  return `${json.slice(0, -1)},"sig":"${sig.toString('base64url')}"}`;
}

/** Yêu cầu cài đặt từ xa (remoteAdmin.js) — tiền tố khác `cmd1` để chữ ký của loại gói này không dùng được cho loại kia. */
export const rpcMessage = (mqttId, json) => `rpc1|${mqttId}|${json}`;
export function signRpc(mqttId, payload) {
  const json = JSON.stringify(payload);
  const sig = crypto.sign('sha256', Buffer.from(rpcMessage(mqttId, json), 'utf8'), { key: load().priv, dsaEncoding: 'ieee-p1363' });
  return `${json.slice(0, -1)},"sig":"${sig.toString('base64url')}"}`;
}

/** Dùng trong test: kiểm một chuỗi đã ký (giống việc gateway làm). */
export function verifySignedCmd(mqttId, raw, spki = cmdPublicKey()) {
  const i = raw.lastIndexOf(',"sig":"');
  if (i < 0 || !raw.endsWith('"}')) return false;
  const json = `${raw.slice(0, i)}}`;
  const sig = Buffer.from(raw.slice(i + 8, -2), 'base64url');
  const key = crypto.createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' });
  return crypto.verify('sha256', Buffer.from(cmdMessage(mqttId, json), 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig);
}
