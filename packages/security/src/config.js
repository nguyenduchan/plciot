/**
 * Cổng cấu hình của lõi bảo mật. Lõi KHÔNG biết app dùng Telegram, email, MQTT hay PLC — app cắm các "adapter" vào đây
 * một lần lúc khởi động (configure) rồi dùng lõi như thư viện.
 *
 *   secret()      chuỗi bí mật gốc của app (≥16 ký tự); từ đó dẫn xuất khoá mã hoá TOTP, băm mã khôi phục, mã ghép PC…
 *   publicUrl()   URL công khai của webapp (dùng trong link huỷ gửi cho chủ tài khoản)
 *   notify(db, user, { subject, html?, text? })    báo cho chủ tài khoản (Telegram/email/push…) — không bao giờ được ném lỗi
 *   email.available(user) / email.send(user, subject, text)   kênh email ĐÃ XÁC MINH và đủ tuổi (nếu app có)
 *   canControl(user)   người này có thuộc nhóm phải bật yếu tố điều khiển không (mặc định: role admin/operator)
 *   brand       { rpName } tên hiện trên hộp thoại vân tay
 */
import crypto from 'crypto';
import { normalizePhone, isValidVnPhone, formatVnLocal } from './phone.js';

const defaults = {
  secret: () => process.env.APP_JWT_SECRET || '',
  publicUrl: () => (process.env.WEBAPP_PUBLIC_URL || '').replace(/\/$/, ''),
  notify: async () => {},
  email: {
    available: () => false, configured: () => false,
    validate: (address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(address)),
    send: async () => { throw new Error('email_disabled'); },
    sendAddress: async () => { throw new Error('email_disabled'); },
  },
  identity: {
    normalize: normalizePhone, valid: isValidVnPhone, format: formatVnLocal,
    contact: (user) => user.primary_contact || null,
    resolveContact: async () => null,
    sendCode: async () => { throw new Error('contact_unavailable'); },
    findContactOwner: (db, contact, userId) => db.prepare('SELECT id FROM users WHERE primary_contact = ? AND id != ?').get(contact, userId),
    createAccount: async (db, { phone, contact }) => {
      const created = db.prepare('INSERT INTO users (username, phone, primary_contact) VALUES (?, ?, ?)').run(phone, phone, contact);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(created.lastInsertRowid);
    },
    applyContact: (db, user, contact) => db.prepare('UPDATE users SET primary_contact = ? WHERE id = ?').run(contact, user.id),
    beforePhoneApplied: async () => {},
    unavailableError: 'contact_unavailable', sendError: 'otp_send_failed',
  },
  presence: { enabled: false, start: () => ({ error: 'proof_unavailable', status: 409 }), check: () => ({ error: 'proof_unavailable', status: 409 }) },
  accountExtra: () => ({}),
  canControl: (u) => u?.role === 'admin' || u?.role === 'operator',
  brand: { rpName: 'Ứng dụng' },
};

let cfg = { ...defaults, email: { ...defaults.email }, identity: { ...defaults.identity }, presence: { ...defaults.presence }, brand: { ...defaults.brand } };

export function configure(patch = {}) {
  cfg = {
    ...cfg,
    ...patch,
    email: { ...cfg.email, ...(patch.email || {}) },
    identity: { ...cfg.identity, ...(patch.identity || {}) },
    presence: { ...cfg.presence, ...(patch.presence || {}) },
    brand: { ...cfg.brand, ...(patch.brand || {}) },
  };
  return cfg;
}

export const getConfig = () => cfg;

/** Gọi notify của app, không bao giờ ném lỗi ra ngoài luồng bảo mật. */
export function notify(db, user, message) {
  try {
    return Promise.resolve(cfg.notify(db, user, message)).catch((e) => console.error('security.notify', e?.message));
  } catch (e) {
    console.error('security.notify', e?.message);
    return Promise.resolve();
  }
}

/** Khoá 32 byte dẫn xuất từ secret gốc theo "mục đích" (tiền tố cố định để dữ liệu cũ vẫn giải mã được). */
export const keyFrom = (prefix) => crypto.createHash('sha256').update(`${prefix}${cfg.secret()}`).digest();
export const rawSecret = () => cfg.secret();
