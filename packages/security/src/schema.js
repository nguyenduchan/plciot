/**
 * Lược đồ SQLite của lõi bảo mật. App gọi migrateSecurity(db) sau khi đã có bảng `users`.
 *
 * Hợp đồng bảng users (app tự tạo): id INTEGER PK, username TEXT, role TEXT, disabled INTEGER.
 * Lõi thêm các cột: totp_secret, totp_enabled, totp_last_step, totp_pending, enroll_deadline, token_version.
 * Cột `notify_site` / `notify_device` (phạm vi thiết bị của người dùng) chỉ app điều khiển dùng, lõi không đòi.
 */

function addColumns(db, table, defs) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, ddl] of Object.entries(defs)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function migrateSecurity(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id INTEGER,
      event TEXT NOT NULL,
      ip TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, event, ts);
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);
    -- Passkeys (WebAuthn): khoá công khai SPKI DER base64url.
    CREATE TABLE IF NOT EXISTS passkeys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cred_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      alg INTEGER NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);
    -- Phiên điều khiển (step-up): chỉ lưu băm của token. method: passkey | totp
    CREATE TABLE IF NOT EXISTS control_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL,
      net TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ctl_sess_user ON control_sessions(user_id);
    -- Yêu cầu thêm thiết bị mới: pending → cooling → approved → done | denied | cancelled | expired
    CREATE TABLE IF NOT EXISTS device_requests (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      method TEXT,
      poll_hash TEXT NOT NULL,
      label TEXT,
      created_ip TEXT,
      email_otp_hash TEXT,
      email_otp_expires INTEGER,
      email_fails INTEGER NOT NULL DEFAULT 0,
      execute_at INTEGER,
      ticket_hash TEXT,
      ticket_expires INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_device_req_user ON device_requests(user_id, status);
    CREATE TABLE IF NOT EXISTS known_devices (
      user_id INTEGER NOT NULL,
      dev_hash TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      last_ip TEXT,
      PRIMARY KEY (user_id, dev_hash)
    );
    CREATE TABLE IF NOT EXISTS pair_codes (
      code_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      name TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    -- PC/trạm: kind = legacy (admin cấp khoá, kèm IP) | paired (ghép bằng mã + khoá thiết bị ECDSA)
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
  `);
  addColumns(db, 'stations', {
    kind: "kind TEXT NOT NULL DEFAULT 'legacy'",
    public_key: 'public_key TEXT',
    hwid: 'hwid TEXT',
    site: 'site TEXT',
    device: 'device TEXT',
    last_ip: 'last_ip TEXT',
  });
  addColumns(db, 'users', {
    token_version: 'token_version INTEGER NOT NULL DEFAULT 0',
    // TOTP cho điều khiển: bí mật đã mã hoá + step đã dùng (chống phát lại); totp_pending chờ nhập đúng mã đầu tiên
    totp_secret: 'totp_secret TEXT',
    totp_enabled: 'totp_enabled INTEGER NOT NULL DEFAULT 0',
    totp_last_step: 'totp_last_step INTEGER NOT NULL DEFAULT 0',
    totp_pending: 'totp_pending TEXT',
    // Hạn phải bật vân tay/Authenticator (đặt lười khi lần đầu cần); quá hạn mà chưa có yếu tố → khoá điều khiển
    enroll_deadline: 'enroll_deadline INTEGER',
  });
}
