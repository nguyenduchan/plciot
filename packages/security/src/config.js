/**
 * Cổng cấu hình của lõi bảo mật. Danh tính theo thiết bị QR; app cắm adapter notify/identity.
 */
import crypto from 'crypto';

const defaults = {
  secret: () => process.env.APP_JWT_SECRET || '',
  publicUrl: () => (process.env.WEBAPP_PUBLIC_URL || '').replace(/\/$/, ''),
  notify: async () => ({ delivered: false }),
  identity: {
    normalize: (s) => String(s || '').trim(),
    valid: (s) => Boolean(String(s || '').trim()),
    format: (s) => String(s || ''),
    createAccount: async (db, { site = 'device', device = 'plc01' } = {}) => {
      const username = `u_${crypto.randomBytes(8).toString('hex')}`;
      const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
      if (cols.has('notify_site') && cols.has('notify_device')) {
        const created = db.prepare(
          'INSERT INTO users (username, notify_site, notify_device, setup_complete) VALUES (?, ?, ?, 0)',
        ).run(username, site, device);
        return db.prepare('SELECT * FROM users WHERE id = ?').get(created.lastInsertRowid);
      }
      const created = db.prepare('INSERT INTO users (username) VALUES (?)').run(username);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(created.lastInsertRowid);
      if (cols.has('setup_complete')) db.prepare('UPDATE users SET setup_complete = 0 WHERE id = ?').run(user.id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    },
  },
  presence: { enabled: false, start: () => ({ error: 'proof_unavailable', status: 409 }), check: () => ({ error: 'proof_unavailable', status: 409 }) },
  accountExtra: () => ({}),
  canControl: (u) => u?.role === 'admin' || u?.role === 'operator',
  brand: { rpName: 'Ứng dụng' },
};

let cfg = { ...defaults, identity: { ...defaults.identity }, presence: { ...defaults.presence }, brand: { ...defaults.brand } };

export function configure(patch = {}) {
  cfg = {
    ...cfg,
    ...patch,
    identity: { ...cfg.identity, ...(patch.identity || {}) },
    presence: { ...cfg.presence, ...(patch.presence || {}) },
    brand: { ...cfg.brand, ...(patch.brand || {}) },
  };
  return cfg;
}

export const getConfig = () => cfg;

export function notify(db, user, message) {
  try {
    return Promise.resolve(cfg.notify(db, user, message)).catch((e) => console.error('security.notify', e?.message));
  } catch (e) {
    console.error('security.notify', e?.message);
    return Promise.resolve();
  }
}

export const keyFrom = (prefix) => crypto.createHash('sha256').update(`${prefix}${cfg.secret()}`).digest();
export const rawSecret = () => cfg.secret();
