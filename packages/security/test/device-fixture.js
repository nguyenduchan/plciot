import crypto from 'node:crypto';

const keys = new Map();
export function signedDevice(subject, action, deviceId = 'test-device-aaaaaaaaaaaaaaaa') {
  if (!keys.has(deviceId)) keys.set(deviceId, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }));
  const key = keys.get(deviceId);
  const deviceProof = { timestamp: Date.now(), nonce: crypto.randomBytes(24).toString('base64url') };
  deviceProof.signature = crypto.sign('sha256', Buffer.from(JSON.stringify([String(subject), deviceId, action, deviceProof.timestamp, deviceProof.nonce])),
    { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { deviceId, publicKey: key.publicKey.export({ format: 'jwk' }), deviceProof };
}