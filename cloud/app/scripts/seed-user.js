#!/usr/bin/env node
/**
 * Tạo/cập nhật user ẩn danh gắn site/device (không SĐT).
 *   node scripts/seed-user.js <username> [site] [device] [version]
 */
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { openDb, upsertUser, findUserByUsername } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { copyDir, resolveBundleRoot } from '../src/bundle.js';
import { provisionUserMqtt } from '../src/mqttProvision.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const WEBAPP_SRC = path.resolve(process.env.WEBAPP_SRC || path.join(DATA_DIR, '..', '..', '..', 'webapp'));

const [username, siteArg, deviceArg = 'plc01', version = '1'] = process.argv.slice(2);
if (!username || !/^[a-zA-Z0-9_]{3,48}$/.test(username)) {
  console.error('Usage: node scripts/seed-user.js <username> [site] [device] [version]');
  process.exit(1);
}
const site = siteArg || `d_${username}`;
const folder = `u_${username}`;
if (!fs.existsSync(WEBAPP_SRC)) {
  console.error('WEBAPP_SRC not found:', WEBAPP_SRC);
  process.exit(1);
}

const db = openDb(DATA_DIR);
const dest = resolveBundleRoot(DATA_DIR, folder);
console.log('Copying', WEBAPP_SRC, '->', dest);
copyDir(WEBAPP_SRC, dest);

const password = crypto.randomBytes(24).toString('hex');
let user = upsertUser(db, {
  username,
  passwordHash: hashPassword(password),
  folderPath: folder,
  version,
  phone: null,
  notifySite: site,
  notifyDevice: deviceArg,
});
db.prepare('UPDATE users SET setup_complete = 1, phone = NULL, chat_id = NULL WHERE id = ?').run(user.id);
user = provisionUserMqtt(db, findUserByUsername(db, username), { site, device: deviceArg }).user;
console.log('OK', { id: user.id, username: user.username, site: user.notify_site, device: user.notify_device });
