import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { migrateSecurity } from '../src/schema.js';
import { canonicalDeviceKey, verifyDeviceProof } from '../src/deviceProof.js';
import { canBindVerifiedContact } from '../src/accounts.js';

const require = createRequire(new URL('../../../cloud/app/package.json', import.meta.url));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, disabled INTEGER DEFAULT 0)');
migrateSecurity(db);
const identity = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKey = identity.publicKey.export({ format: 'jwk' });
const deviceId = 'test-device-aaaaaaaaaaaaaaaa';
function proofFor(subject, action) {
  const proof = { timestamp: Date.now(), nonce: crypto.randomBytes(24).toString('base64url') };
  proof.signature = crypto.sign('sha256', Buffer.from(JSON.stringify([String(subject), deviceId, action, proof.timestamp, proof.nonce])),
    { key: identity.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return proof;
}
const proof = proofFor(7, '/api/devices/request');
const input = { subject: 7, deviceId, action: '/api/devices/request', publicKey, proof };
assert.ok(verifyDeviceProof(db, input));
assert.equal(verifyDeviceProof(db, input), false, 'A proof is single-use');
assert.equal(verifyDeviceProof(db, { ...input, subject: 8, proof: proofFor(7, input.action) }), false);
assert.equal(verifyDeviceProof(db, { ...input, action: 'different-action', proof: proofFor(7, input.action) }), false);
assert.equal(verifyDeviceProof(db, { ...input, deviceId: 'other-device-bbbbbbbbbbbbbbbb', proof: proofFor(7, input.action) }), false);
assert.equal(canonicalDeviceKey({ ...publicKey, d: 'private-key' }), null);
assert.equal(canonicalDeviceKey({ kty: 'RSA' }), null);
const contact = { actorId: 7, contactOwnerId: 7, isPrivate: true, newContact: 7 };
assert.ok(canBindVerifiedContact(contact));
assert.equal(canBindVerifiedContact({ ...contact, contactOwnerId: undefined }), false);
assert.equal(canBindVerifiedContact({ ...contact, contactOwnerId: 8 }), false);
assert.equal(canBindVerifiedContact({ ...contact, isPrivate: false }), false);
assert.equal(canBindVerifiedContact({ ...contact, currentContact: 9 }), false);
assert.ok(canBindVerifiedContact({ ...contact, currentContact: '7' }));
db.close();
console.log('Device proof: key binding, account/action/device binding and replay protection passed');