#!/usr/bin/env node
/**
 * Create or update a user, copy webapp bundle, provision per-user MQTT ACL.
 *
 * Usage:
 *   node scripts/seed-user.js <username> <password> [site] [device] [version]
 *
 * Example:
 *   node scripts/seed-user.js 84987654321 secret factory1 plc01 1
 */
import path from 'path';
import fs from 'fs';
import { openDb, upsertUser } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { copyDir, resolveBundleRoot } from '../src/bundle.js';
import { normalizePhone, isValidVnPhone, formatVnLocal } from '../src/phone.js';
import { provisionUserMqtt } from '../src/mqttProvision.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const WEBAPP_SRC = path.resolve(process.env.WEBAPP_SRC || path.join(DATA_DIR, '..', '..', '..', 'webapp'));

const [username, password, siteArg, deviceArg = 'plc01', version = '1'] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/seed-user.js <SĐT_VN> <password> [site] [device] [version]');
  console.error('Example: node scripts/seed-user.js 0987654321 secret factory1 plc01');
  process.exit(1);
}

const phone = normalizePhone(username);
if (!isValidVnPhone(phone)) {
  console.error('Username must be a Vietnamese mobile number (09… / 84…). Got:', username, '→', phone);
  process.exit(1);
}
const site = siteArg || `s${phone}`;
const folder = site;
if (!fs.existsSync(WEBAPP_SRC)) {
  console.error('WEBAPP_SRC not found:', WEBAPP_SRC);
  process.exit(1);
}

const db = openDb(DATA_DIR);
const dest = resolveBundleRoot(DATA_DIR, folder);
console.log('Copying', WEBAPP_SRC, '->', dest);
copyDir(WEBAPP_SRC, dest);

let user = upsertUser(db, {
  username: phone, // canonical 84…
  passwordHash: hashPassword(password),
  folderPath: folder,
  version: String(version),
  phone,
  notifySite: site,
  notifyDevice: deviceArg,
});

const prov = provisionUserMqtt(db, user, { site, device: deviceArg, rotate: false });
user = prov.user;

console.log('User ready:', {
  id: user.id,
  username: user.username,
  phoneLocal: formatVnLocal(user.username),
  folder_path: user.folder_path,
  notify_site: user.notify_site,
  notify_device: user.notify_device,
  mqtt_user: user.mqtt_user,
  mqtt_provision: prov.provision,
});
