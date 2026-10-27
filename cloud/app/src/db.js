import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { normalizePhone, phoneVariants } from './phone.js';
import { initHistoryTables } from './historyStore.js';
import { migrateSecurity } from '@plciot/security';

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  };
  add('phone', 'phone TEXT');
  add('chat_id', 'chat_id INTEGER');
  add('notify_site', "notify_site TEXT NOT NULL DEFAULT 'factory1'");
  add('notify_device', "notify_device TEXT NOT NULL DEFAULT 'plc01'");
  add('mqtt_user', 'mqtt_user TEXT');
  add('mqtt_pass', 'mqtt_pass TEXT');
  // NULL = default plan (3 days); 0 = unlimited; N>=4 = N days. See retention.js
  add('retention_days', 'retention_days INTEGER');
  add('email', 'email TEXT');
  add('email_verified', 'email_verified INTEGER NOT NULL DEFAULT 0');
  add('email_verified_at', 'email_verified_at INTEGER');
  // Bumped on phone change / recovery → every older JWT stops working.
  add('token_version', 'token_version INTEGER NOT NULL DEFAULT 0');
  // Phân quyền: admin | operator | viewer (xem roles.js). Người dùng cũ = operator như trước.
  add('role', "role TEXT NOT NULL DEFAULT 'operator'");
  add('disabled', 'disabled INTEGER NOT NULL DEFAULT 0');
  add('created_by', 'created_by INTEGER');
  // Các nhóm topic được đọc, ví dụ 'telemetry,status'. NULL = tất cả. Xem roles.js
  add('monitor_scopes', 'monitor_scopes TEXT');
  // Chủ site: được mời thành viên, ghép/thu hồi PC. Lần đầu thêm cột: người dùng id nhỏ nhất mỗi site thành chủ.
  const hadOwner = cols.includes('site_owner');
  add('site_owner', 'site_owner INTEGER NOT NULL DEFAULT 0');
  if (!hadOwner) {
    db.exec("UPDATE users SET site_owner = 1 WHERE disabled = 0 AND role IN ('admin','operator') AND id IN (SELECT MIN(id) FROM users WHERE disabled = 0 AND role IN ('admin','operator') GROUP BY notify_site, notify_device)");
  }
}

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'bundles'), { recursive: true });
  const dbPath = path.join(dataDir, 'app.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1',
      phone TEXT,
      chat_id INTEGER,
      notify_site TEXT NOT NULL DEFAULT 'factory1',
      notify_device TEXT NOT NULL DEFAULT 'plc01',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS telegram_users (
      phone TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS otp_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      password_hash TEXT,
      expires_at INTEGER NOT NULL,
      fails INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_challenges(phone, purpose);
    CREATE TABLE IF NOT EXISTS email_challenges (
      user_id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      fails INTEGER NOT NULL DEFAULT 0
    );
    -- One row per "đổi số điện thoại" request (self-service or recovery ticket).
    -- status: pending_otp → (pending_review) → cooling → applied | cancelled | rejected | expired
    CREATE TABLE IF NOT EXISTS phone_changes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,                 -- 'self' | 'recovery'
      old_phone TEXT NOT NULL,
      new_phone TEXT NOT NULL,
      new_chat_id INTEGER,
      status TEXT NOT NULL,
      new_otp_hash TEXT,
      old_otp_hash TEXT,
      old_channel TEXT,                   -- 'telegram' | 'email'
      otp_expires_at INTEGER,
      new_fails INTEGER NOT NULL DEFAULT 0,
      old_fails INTEGER NOT NULL DEFAULT 0,
      new_verified INTEGER NOT NULL DEFAULT 0,
      old_verified INTEGER NOT NULL DEFAULT 0,
      recovery_code_ok INTEGER NOT NULL DEFAULT 0,
      plc_ok INTEGER NOT NULL DEFAULT 0,
      plc_bit INTEGER,
      plc_base INTEGER,
      plc_expires_at INTEGER,
      note TEXT,
      execute_at INTEGER,
      reviewed_by TEXT,
      created_ip TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_phone_changes_user ON phone_changes(user_id, status);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_invites (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      invited_by INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_site_invites_phone ON site_invites(phone, status);
  `);
  migrate(db);
  migrateSecurity(db); // bảng/cột của lõi bảo mật (passkey, phiên điều khiển, thiết bị, trạm…)
  initHistoryTables(db);
  return db;
}

export function findUserByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

export function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function findUserByPhone(db, phone) {
  const n = normalizePhone(phone);
  return db.prepare('SELECT * FROM users WHERE phone = ? OR username = ? COLLATE NOCASE').get(n, n);
}

export function upsertUser(db, {
  username, passwordHash, folderPath, version,
  phone = null, chatId = null, notifySite = 'factory1', notifyDevice = 'plc01',
}) {
  const existing = findUserByUsername(db, username);
  if (existing) {
    db.prepare(`
      UPDATE users
      SET password_hash = ?, folder_path = ?, version = ?,
          phone = COALESCE(?, phone),
          chat_id = COALESCE(?, chat_id),
          notify_site = COALESCE(?, notify_site),
          notify_device = COALESCE(?, notify_device)
      WHERE id = ?
    `).run(
      passwordHash, folderPath, version,
      phone, chatId, notifySite, notifyDevice,
      existing.id,
    );
    return findUserById(db, existing.id);
  }
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, folder_path, version, phone, chat_id, notify_site, notify_device)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    username, passwordHash, folderPath, version,
    phone || normalizePhone(username), chatId, notifySite, notifyDevice,
  );
  return findUserById(db, info.lastInsertRowid);
}

export function bumpVersion(db, username, version) {
  db.prepare('UPDATE users SET version = ? WHERE username = ? COLLATE NOCASE')
    .run(version, username);
  return findUserByUsername(db, username);
}

export function upsertTelegramUser(db, phone, chatId) {
  const p = normalizePhone(phone);
  // Same Telegram account moving to a new number: chat_id is UNIQUE, so drop the stale link first.
  db.prepare('DELETE FROM telegram_users WHERE chat_id = ? AND phone != ?').run(chatId, p);
  db.prepare(`
    INSERT INTO telegram_users (phone, chat_id) VALUES (?, ?)
    ON CONFLICT(phone) DO UPDATE SET chat_id = excluded.chat_id
  `).run(p, chatId);
  // Keep chat_id in sync for app users with this phone
  db.prepare('UPDATE users SET chat_id = ? WHERE phone = ? OR username = ?')
    .run(chatId, p, p);
  return db.prepare('SELECT * FROM telegram_users WHERE phone = ?').get(p);
}

export function findTelegramByPhone(db, phone) {
  for (const v of phoneVariants(phone)) {
    const n = normalizePhone(v);
    const row = db.prepare('SELECT * FROM telegram_users WHERE phone = ?').get(n);
    if (row) return row;
    // legacy rows stored with +
    const raw = db.prepare('SELECT * FROM telegram_users WHERE phone = ?').get(v);
    if (raw) return raw;
  }
  return null;
}

export function createOtpChallenge(db, { phone, purpose, codeHash, passwordHash, ttlSec = 300 }) {
  const p = normalizePhone(phone);
  db.prepare('DELETE FROM otp_challenges WHERE phone = ? AND purpose = ?').run(p, purpose);
  const expiresAt = Date.now() + ttlSec * 1000;
  const info = db.prepare(`
    INSERT INTO otp_challenges (phone, purpose, code_hash, password_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(p, purpose, codeHash, passwordHash || null, expiresAt);
  return { id: info.lastInsertRowid, expiresAt };
}

export function getOtpChallenge(db, phone, purpose) {
  const p = normalizePhone(phone);
  return db.prepare(`
    SELECT * FROM otp_challenges
    WHERE phone = ? AND purpose = ?
    ORDER BY id DESC LIMIT 1
  `).get(p, purpose);
}

export function bumpOtpFail(db, id) {
  db.prepare('UPDATE otp_challenges SET fails = fails + 1 WHERE id = ?').run(id);
}

export function deleteOtpChallenge(db, id) {
  db.prepare('DELETE FROM otp_challenges WHERE id = ?').run(id);
}

export function findNotifyUsers(db, site, device) {
  return db.prepare(`
    SELECT * FROM users
    WHERE chat_id IS NOT NULL
      AND disabled = 0
      AND notify_site = ?
      AND notify_device = ?
  `).all(site, device);
}
