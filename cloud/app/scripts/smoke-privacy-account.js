/**
 * Smoke: privacy consent helpers + account export/purge + mqtt seal.
 * Chạy: node scripts/smoke-privacy-account.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { configure, sealSecret, openSecret, migrateSecurity, PRIVACY_NOTICE_VERSION,
  requirePrivacyConsent, recordPrivacyConsent, privacyConsentStatus, purgeExpiredAudit,
  hashPassword } from '@plciot/security';
import { openDb } from '../src/db.js';
import { exportAccountData, purgeUserAccount } from '../src/accountData.js';
import { sealMqttPass, openMqttPass } from '../src/mqttProvision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_JWT_SECRET = process.env.APP_JWT_SECRET || 'smoke-privacy-secret-32b!!';
configure({ secret: () => process.env.APP_JWT_SECRET });

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log('ok', msg);
  else { failed++; console.error('FAIL', msg); }
};

ok(requirePrivacyConsent({}).error === 'privacy_consent_required', 'thiếu consent → lỗi');
ok(requirePrivacyConsent({ consent: true }).ok === true, 'consent true → ok');
ok(requirePrivacyConsent({ consent: true, privacyVersion: 'old' }).error === 'privacy_version_mismatch', 'sai version');

const sealed = sealMqttPass('mqtt-secret-xyz');
ok(String(sealed).startsWith('v1.'), 'mqtt_pass sealed v1');
ok(openMqttPass(sealed) === 'mqtt-secret-xyz', 'mở mqtt_pass');
ok(openMqttPass('legacy-plain') === 'legacy-plain', 'plaintext cũ vẫn đọc');
ok(sealMqttPass(sealed) === sealed, 'reseal idempotent');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plciot-privacy-'));
const db = openDb(dir);
const info = db.prepare(`
  INSERT INTO users (username, password_hash, folder_path, role, notify_site, notify_device, setup_complete, site_owner)
  VALUES ('u_smoke', ?, 'u_smoke', 'operator', 's1', 'd1', 1, 1)
`).run(hashPassword('password12'));
const uid = Number(info.lastInsertRowid);
recordPrivacyConsent(db, uid, { version: PRIVACY_NOTICE_VERSION });
const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
ok(privacyConsentStatus(user).needsConsent === false, 'đã consent → không cần lại');

db.prepare('INSERT INTO audit_log (ts, user_id, event, ip, detail) VALUES (?, ?, ?, ?, ?)')
  .run(Date.now(), uid, 'login_ok', '127.0.0.1', 'test');
const exp = exportAccountData(db, user);
ok(exp.ok && exp.profile.username === 'u_smoke' && exp.audit.length >= 1, 'export có profile + audit');

const purged = purgeUserAccount(db, user, { wipeHistory: false, removeBundle: false, reason: 'smoke_purge' });
ok(purged.ok && !db.prepare('SELECT id FROM users WHERE id = ?').get(uid), 'purge xoá user');

ok(typeof purgeExpiredAudit(db) === 'number', 'purge audit chạy');
ok(typeof migrateSecurity === 'function' && openSecret(sealSecret('x')) === 'x', 'seal core');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('smoke-privacy-account OK');
