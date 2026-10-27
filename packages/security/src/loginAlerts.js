/**
 * Cảnh báo đăng nhập từ thiết bị lạ. Webapp gửi header X-Device-Id (UUID ngẫu nhiên lưu trên máy);
 * thiết bị đầu tiên của tài khoản không báo, các thiết bị sau báo cho chủ qua Telegram + email.
 * Giới hạn: kẻ chiếm được Telegram cũng đọc được cảnh báo Telegram — email đã xác minh là kênh độc lập duy nhất.
 */
import crypto from 'crypto';
import { audit } from './audit.js';
import { notify } from './config.js';

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Thiết bị này có phải thiết bị đầu tiên từng đăng nhập vào tài khoản? (chưa có thiết bị nào ghi nhận → coi là có) */
export function isFirstDevice(db, userId, deviceId) {
  const first = db.prepare('SELECT dev_hash FROM known_devices WHERE user_id = ? ORDER BY first_seen ASC, rowid ASC LIMIT 1').get(userId);
  if (!first) return true;
  const id = String(deviceId || '');
  if (!ID_RE.test(id)) return false;
  return crypto.createHash('sha256').update(`${userId}:${id}`).digest('hex') === first.dev_hash;
}

export function noteLogin(db, user, { deviceId, ip, method }) {
  const id = String(deviceId || '');
  if (!ID_RE.test(id)) return { known: null };
  const h = crypto.createHash('sha256').update(`${user.id}:${id}`).digest('hex');
  const now = Date.now();
  const row = db.prepare('SELECT 1 FROM known_devices WHERE user_id = ? AND dev_hash = ?').get(user.id, h);
  if (row) {
    db.prepare('UPDATE known_devices SET last_seen = ?, last_ip = ? WHERE user_id = ? AND dev_hash = ?').run(now, ip || null, user.id, h);
    return { known: true };
  }
  const others = db.prepare('SELECT COUNT(*) AS n FROM known_devices WHERE user_id = ?').get(user.id).n;
  db.prepare('INSERT INTO known_devices (user_id, dev_hash, first_seen, last_seen, last_ip) VALUES (?, ?, ?, ?, ?)').run(user.id, h, now, now, ip || null);
  if (others > 0) {
    audit(db, 'login_new_device', { userId: user.id, ip, detail: method });
    notify(db, user, {
      subject: 'Đăng nhập từ thiết bị mới',
      html: `<b>🔔 Đăng nhập từ thiết bị mới</b> bằng ${esc(method)} lúc ${new Date(now).toLocaleString('vi-VN')} (IP ${esc(ip || '?')}).\n`
        + 'Không phải bạn? Mở ứng dụng → Cài đặt → Điều khiển → <b>Đăng xuất mọi máy</b>, rồi kiểm tra danh sách thiết bị.',
    });
  }
  return { known: false, notified: others > 0 };
}
