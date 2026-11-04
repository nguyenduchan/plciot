import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { initHistoryTables } from './historyStore.js';
import { initPolicyTables } from './policy.js';
import { initHomePcTable } from './homePc.js';
import { initOpsFlagsTable, loadOpsFlags } from './opsFlags.js';
import { migrateSecurity } from '@plciot/security';

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  };
  add('notify_site', "notify_site TEXT NOT NULL DEFAULT 'factory1'");
  add('notify_device', "notify_device TEXT NOT NULL DEFAULT 'plc01'");
  add('mqtt_user', 'mqtt_user TEXT');
  add('mqtt_pass', 'mqtt_pass TEXT');
  // NULL = default plan (3 days); 0 = unlimited; N>=4 = N days. See retention.js
  add('retention_days', 'retention_days INTEGER');
  // Bumped on revoke → every older JWT stops working.
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
  // Multi-tenant platform (docs/PARTNER-INTEGRATION.md)
  add('tenant_id', "tenant_id TEXT NOT NULL DEFAULT 'default'");
  // Gói đăng ký tay (không thanh toán online) — docs/SUBSCRIPTION-OPS.md
  add('sub_plan', 'sub_plan TEXT');
  add('sub_expires_at', 'sub_expires_at INTEGER');
  add('remote_control', 'remote_control INTEGER NOT NULL DEFAULT 1');
}

function migratePlatform(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      profile TEXT NOT NULL DEFAULT 'conveyor-v1',
      api_key_hash TEXT,
      sub_plan TEXT,
      sub_expires_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      mqtt_user TEXT,
      mqtt_pass TEXT,
      topic_ns TEXT NOT NULL DEFAULT 'iot',
      profile TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, site, device)
    );
    CREATE INDEX IF NOT EXISTS idx_devices_mqtt ON devices(mqtt_user);
    CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id, status);
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT 'status,alarm',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_tenant ON webhooks(tenant_id, enabled);
  `);
  // tenants tạo trước khi có cột gói → ALTER an toàn
  const tcols = db.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
  if (!tcols.includes('sub_plan')) db.exec('ALTER TABLE tenants ADD COLUMN sub_plan TEXT');
  if (!tcols.includes('sub_expires_at')) db.exec('ALTER TABLE tenants ADD COLUMN sub_expires_at INTEGER');
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
      notify_site TEXT NOT NULL DEFAULT 'factory1',
      notify_device TEXT NOT NULL DEFAULT 'plc01',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_invites (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      invited_by INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_site_invites_phone ON site_invites(phone, status);
  `);
  {
    const invCols = db.prepare('PRAGMA table_info(site_invites)').all().map((c) => c.name);
    if (!invCols.includes('invite_token')) {
      db.exec('ALTER TABLE site_invites ADD COLUMN invite_token TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_site_invites_token ON site_invites(invite_token, status)');
    }
  }
  migrate(db);
  migratePlatform(db);
  migrateSecurity(db); // bảng/cột của lõi bảo mật (passkey, phiên điều khiển, thiết bị, trạm…)
  initHistoryTables(db);
  initPolicyTables(db);
  initHomePcTable(db);
  initOpsFlagsTable(db);
  loadOpsFlags(db);
  // Tránh import vòng: seed tenant mặc định bằng SQL thuần
  const def = db.prepare("SELECT id FROM tenants WHERE id = 'default'").get();
  if (!def) {
    db.prepare("INSERT INTO tenants (id, name, profile, created_at) VALUES ('default', 'Default', 'conveyor-v1', ?)")
      .run(Date.now());
  }
  return db;
}

export function findUserByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

export function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function upsertUser(db, {
  username, passwordHash, folderPath, version,
  notifySite = 'factory1', notifyDevice = 'plc01',
}) {
  const existing = findUserByUsername(db, username);
  if (existing) {
    db.prepare(`
      UPDATE users
      SET password_hash = ?, folder_path = ?, version = ?,
          notify_site = COALESCE(?, notify_site),
          notify_device = COALESCE(?, notify_device)
      WHERE id = ?
    `).run(
      passwordHash, folderPath, version,
      notifySite, notifyDevice,
      existing.id,
    );
    return findUserById(db, existing.id);
  }
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, folder_path, version, notify_site, notify_device)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    username, passwordHash, folderPath, version,
    notifySite, notifyDevice,
  );
  return findUserById(db, info.lastInsertRowid);
}

export function bumpVersion(db, username, version) {
  db.prepare('UPDATE users SET version = ? WHERE username = ? COLLATE NOCASE')
    .run(version, username);
  return findUserByUsername(db, username);
}

export function findNotifyUsers(db, site, device) {
  return db.prepare(`
    SELECT * FROM users
    WHERE disabled = 0
      AND notify_site = ?
      AND notify_device = ?
  `).all(site, device);
}
