import pg from 'pg';
import { normalizePhone, phoneVariants, isValidVnPhone } from './phone.js';
import { findTelegramByPhone as findLocal, upsertTelegramUser } from './db.js';

const { Pool } = pg;

let pool = null;

export function sharedPgConfigured() {
  return Boolean(process.env.TELEGRAM_SHARED_PG_HOST || process.env.TELEGRAM_SHARED_DATABASE_URL);
}

function getPool() {
  if (pool) return pool;
  if (process.env.TELEGRAM_SHARED_DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.TELEGRAM_SHARED_DATABASE_URL });
  } else if (process.env.TELEGRAM_SHARED_PG_HOST) {
    pool = new Pool({
      host: process.env.TELEGRAM_SHARED_PG_HOST,
      port: Number(process.env.TELEGRAM_SHARED_PG_PORT || 5432),
      user: process.env.TELEGRAM_SHARED_PG_USER,
      password: process.env.TELEGRAM_SHARED_PG_PASSWORD,
      database: process.env.TELEGRAM_SHARED_PG_DB || 'iot_postgres',
      max: 4,
      idleTimeoutMillis: 30_000,
    });
  } else {
    return null;
  }
  pool.on('error', (e) => console.error('shared TG pg pool', e.message));
  return pool;
}

/**
 * Resolve phone → chat_id from mqtt_server.telegram_users (Postgres),
 * then fall back to local SQLite. Caches hit into local DB.
 */
export async function resolveTelegramUser(db, phone) {
  const local = findLocal(db, phone);
  if (local) return { phone: local.phone, chat_id: local.chat_id, source: 'local' };

  const p = getPool();
  if (!p) return null;

  const variants = phoneVariants(phone);
  const norm = normalizePhone(phone);

  try {
    const { rows } = await p.query(
      `SELECT phone_number, chat_id
       FROM telegram_users
       WHERE phone_number = ANY($1::text[])
          OR regexp_replace(phone_number, '[^0-9]', '', 'g') = $2
       LIMIT 1`,
      [variants, norm],
    );
    if (!rows.length) return null;
    const row = rows[0];
    const chatId = Number(row.chat_id);
    const canon = normalizePhone(row.phone_number) || norm;
    // Prefer valid VN mobile as identity key
    const phoneKey = isValidVnPhone(canon) ? canon : (isValidVnPhone(norm) ? norm : canon);
    try {
      upsertTelegramUser(db, phoneKey, chatId);
    } catch {}
    return { phone: phoneKey, chat_id: chatId, source: 'mqtt_server' };
  } catch (e) {
    console.error('shared TG lookup', e.message);
    return null;
  }
}

export async function closeSharedPg() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}
