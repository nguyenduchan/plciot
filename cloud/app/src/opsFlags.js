/**
 * Kill-switch vận hành (SaaS-style): bật/tắt thủ công từ Console, lưu SQLite.
 * Giá trị DB ghi đè env cho đến khi admin đổi lại hoặc xoá flag (= về mặc định env).
 */
import { audit } from '@plciot/security';

/** @typedef {{ key: string, label: string, env?: string, defaultOpen: boolean, danger?: boolean }} FlagDef */

/** @type {FlagDef[]} */
export const OPS_FLAG_DEFS = [
  {
    key: 'registration_open',
    label: 'Đăng ký tài khoản mới',
    env: 'REGISTRATION_OPEN',
    defaultOpen: true,
  },
  {
    key: 'login_open',
    label: 'Đăng nhập (OTP / Passkey)',
    defaultOpen: true,
    danger: true,
  },
  {
    key: 'mqtt_ingest_open',
    label: 'Nhận gói tin MQTT (ingest)',
    defaultOpen: true,
  },
  {
    key: 'remote_control_open',
    label: 'Điều khiển từ xa (cmd)',
    defaultOpen: true,
    danger: true,
  },
  {
    key: 'partner_api_open',
    label: 'Partner API (/api/v1)',
    defaultOpen: true,
  },
];

const cache = new Map(); // key -> '0' | '1'
/** Snapshot env lúc boot — dùng khi reset flag về mặc định. */
const bootEnv = Object.create(null);

export function initOpsFlagsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
  `);
}

function envOpen(def) {
  if (!def.env) return def.defaultOpen;
  const raw = process.env[def.env];
  if (raw == null || raw === '') return def.defaultOpen;
  return String(raw).toLowerCase() !== 'false';
}

/** Nạp cache từ DB; đồng bộ REGISTRATION_OPEN nếu có override. */
export function loadOpsFlags(db) {
  cache.clear();
  for (const def of OPS_FLAG_DEFS) {
    if (def.env && !(def.env in bootEnv)) bootEnv[def.env] = process.env[def.env];
  }
  try {
    const rows = db.prepare('SELECT key, value FROM ops_flags').all();
    for (const r of rows) cache.set(r.key, String(r.value));
  } catch {
    /* bảng chưa có */
  }
  applyEnvSync();
}

function applyEnvSync() {
  const def = OPS_FLAG_DEFS.find((d) => d.key === 'registration_open');
  if (!def?.env) return;
  if (cache.has('registration_open')) {
    process.env[def.env] = cache.get('registration_open') === '1' ? 'true' : 'false';
  }
}

export function isOpsOpen(key) {
  const def = OPS_FLAG_DEFS.find((d) => d.key === key);
  if (!def) return true;
  if (cache.has(key)) return cache.get(key) === '1';
  return envOpen(def);
}

export function listOpsFlags(db) {
  const rows = db.prepare('SELECT key, value, updated_at, updated_by FROM ops_flags').all();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  return OPS_FLAG_DEFS.map((def) => {
    const row = byKey[def.key];
    const open = isOpsOpen(def.key);
    return {
      key: def.key,
      label: def.label,
      open,
      danger: Boolean(def.danger),
      source: row ? 'manual' : 'env',
      envDefault: envOpen(def),
      updatedAt: row?.updated_at || null,
      updatedBy: row?.updated_by || null,
    };
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {boolean} open
 * @param {{ userId?: number, ip?: string }} [meta]
 */
export function setOpsFlag(db, key, open, meta = {}) {
  const def = OPS_FLAG_DEFS.find((d) => d.key === key);
  if (!def) return { error: 'unknown_flag', status: 400 };
  const value = open ? '1' : '0';
  const now = Date.now();
  const by = meta.userId != null ? `admin:${meta.userId}` : null;
  db.prepare(`
    INSERT INTO ops_flags (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(key, value, now, by);
  cache.set(key, value);
  applyEnvSync();
  audit(db, open ? 'ops_flag_enable' : 'ops_flag_disable', {
    userId: meta.userId ?? null,
    ip: meta.ip ?? null,
    detail: key,
  });
  return { ok: true, flag: listOpsFlags(db).find((f) => f.key === key) };
}

/** Xoá override → về mặc định env. */
export function clearOpsFlag(db, key, meta = {}) {
  const def = OPS_FLAG_DEFS.find((d) => d.key === key);
  if (!def) return { error: 'unknown_flag', status: 400 };
  db.prepare('DELETE FROM ops_flags WHERE key = ?').run(key);
  cache.delete(key);
  if (def.env) {
    if (bootEnv[def.env] === undefined) delete process.env[def.env];
    else process.env[def.env] = bootEnv[def.env];
  }
  applyEnvSync();
  audit(db, 'ops_flag_reset', {
    userId: meta.userId ?? null,
    ip: meta.ip ?? null,
    detail: key,
  });
  return { ok: true, flag: listOpsFlags(db).find((f) => f.key === key) };
}

/** Middleware: chặn login khi login_open=false (admin vẫn bật lại qua SSH/DB). */
export function loginGateMiddleware(req, res, next) {
  if (isOpsOpen('login_open')) return next();
  const p = req.path || '';
  // Giữ /api/login/activity|lock cho session đang mở; chặn OTP/passkey/register mới
  const allowWhilePaused = p === '/api/login/activity' || p === '/api/login/lock'
    || p === '/api/login/resume' || p === '/api/logout';
  const block = (p.startsWith('/api/login') && !allowWhilePaused)
    || p.startsWith('/api/register');
  if (!block) return next();
  return res.status(503).json({ error: 'login_paused', message: 'Đăng nhập tạm dừng bởi admin.' });
}

/** Dùng với `app.use('/api/v1', partnerApiGate)` — req.path lúc này là phần sau /api/v1. */
export function partnerApiGate(req, res, next) {
  if (isOpsOpen('partner_api_open')) return next();
  const p = String(req.path || '');
  if (p === '/contract' || p.startsWith('/contract/')) return next();
  return res.status(503).json({ error: 'partner_api_paused' });
}
