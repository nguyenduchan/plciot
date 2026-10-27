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

const defaults = {
  secret: () => process.env.APP_JWT_SECRET || '',
  publicUrl: () => (process.env.WEBAPP_PUBLIC_URL || '').replace(/\/$/, ''),
  notify: async () => {},
  email: { available: () => false, send: async () => { throw new Error('email_disabled'); } },
  canControl: (u) => u?.role === 'admin' || u?.role === 'operator',
  brand: { rpName: 'Ứng dụng' },
};

let cfg = { ...defaults, email: { ...defaults.email }, brand: { ...defaults.brand } };

export function configure(patch = {}) {
  cfg = {
    ...cfg,
    ...patch,
    email: { ...cfg.email, ...(patch.email || {}) },
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
