// Gateway giả cho test: cặp khoá ECDSA P-256, gửi khoá công khai và ký như GatewayApp (C#).
import crypto from 'node:crypto';
import { normalizeCode } from '../src/gatewayPairing.js';
import { parsePubkey } from '../src/gatewayKey.js';

export function makeGateway() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const sign = (msg) => crypto.sign('sha256', Buffer.from(msg, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return {
    pubkey,
    hw: parsePubkey(pubkey).hw,
    sign,
    /** Thân /pair kèm chứng minh giữ khoá riêng. */
    pairBody(code, extra = {}) {
      const ts = Date.now();
      return { code, pubkey, ts, sig: sign(`pair|${normalizeCode(code)}|${ts}`), ...extra };
    },
    /** Chứng minh cho enroll/config (kind = 'enroll' | 'config'). */
    proof(kind, site, device) {
      const ts = Date.now();
      return { ts, sig: sign(`${kind}|${site}|${device}|${ts}`) };
    },
  };
}
