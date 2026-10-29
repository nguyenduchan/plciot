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
    CREATE TABLE IF NOT EXISTS login_attempts (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, device_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS app_sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, device_id TEXT NOT NULL,
      last_seen INTEGER NOT NULL, background_at INTEGER, locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS otp_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL, password_hash TEXT, expires_at INTEGER NOT NULL,
      fails INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_challenges(phone, purpose);
    CREATE TABLE IF NOT EXISTS email_challenges (
      user_id INTEGER PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, fails INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS phone_changes (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
      old_phone TEXT NOT NULL, new_phone TEXT NOT NULL, new_contact TEXT,
      status TEXT NOT NULL, new_otp_hash TEXT, old_otp_hash TEXT, old_channel TEXT,
      otp_expires_at INTEGER, new_fails INTEGER NOT NULL DEFAULT 0, old_fails INTEGER NOT NULL DEFAULT 0,
      new_verified INTEGER NOT NULL DEFAULT 0, old_verified INTEGER NOT NULL DEFAULT 0,
      recovery_code_ok INTEGER NOT NULL DEFAULT 0, plc_ok INTEGER NOT NULL DEFAULT 0,
      plc_bit INTEGER, plc_base INTEGER, plc_expires_at INTEGER, note TEXT,
      execute_at INTEGER, reviewed_by TEXT, created_ip TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_phone_changes_user ON phone_changes(user_id, status);
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
    CREATE TABLE IF NOT EXISTS auth_devices (
      user_id INTEGER NOT NULL, device_id TEXT NOT NULL, public_key TEXT NOT NULL,
      label TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS device_proof_nonces (
      nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recovery_enrollments (
      user_id INTEGER PRIMARY KEY, change_id TEXT NOT NULL, device_id TEXT NOT NULL,
      public_key TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    );
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
  addColumns(db, 'control_sessions', {
    login_id: 'login_id TEXT',
    command_id: 'command_id TEXT',
    device_id: 'device_id TEXT',
  });
  addColumns(db, 'passkeys', { device_id: 'device_id TEXT' });
  addColumns(db, 'device_requests', {
    device_id: 'device_id TEXT', public_key: 'public_key TEXT', approval_code: 'approval_code TEXT',
    kind: "kind TEXT NOT NULL DEFAULT 'add'", notification_state: "notification_state TEXT NOT NULL DEFAULT 'pending'",
  });
  addColumns(db, 'app_sessions', { background_at: 'background_at INTEGER' });
  addColumns(db, 'otp_challenges', { contact_id: 'contact_id TEXT' });
  addColumns(db, 'phone_changes', {
    new_contact: 'new_contact TEXT',
    notification_state: "notification_state TEXT NOT NULL DEFAULT 'pending'",
    recovery_device: 'recovery_device TEXT',
    recovery_public_key: 'recovery_public_key TEXT',
    session_id: 'session_id TEXT',
    review_evidence: 'review_evidence TEXT',
  });
  const changeColumns = db.prepare('PRAGMA table_info(phone_changes)').all();
  if (changeColumns.some((column) => column.name === 'new_chat_id')) {
    db.exec('UPDATE phone_changes SET new_contact = CAST(new_chat_id AS TEXT) WHERE new_contact IS NULL AND new_chat_id IS NOT NULL');
  }
  addColumns(db, 'users', {
    phone: 'phone TEXT',
    primary_contact: 'primary_contact TEXT',
    recovery_required: 'recovery_required INTEGER NOT NULL DEFAULT 0',
    email: 'email TEXT',
    email_verified: 'email_verified INTEGER NOT NULL DEFAULT 0',
    email_verified_at: 'email_verified_at INTEGER',
    token_version: 'token_version INTEGER NOT NULL DEFAULT 0',
    // TOTP cho điều khiển: bí mật đã mã hoá + step đã dùng (chống phát lại); totp_pending chờ nhập đúng mã đầu tiên
    totp_secret: 'totp_secret TEXT',
    totp_enabled: 'totp_enabled INTEGER NOT NULL DEFAULT 0',
    totp_last_step: 'totp_last_step INTEGER NOT NULL DEFAULT 0',
    totp_pending: 'totp_pending TEXT',
    totp_device_id: 'totp_device_id TEXT',
    // Hạn phải bật vân tay/Authenticator (đặt lười khi lần đầu cần); quá hạn mà chưa có yếu tố → khoá điều khiển
    enroll_deadline: 'enroll_deadline INTEGER',
  });
}
