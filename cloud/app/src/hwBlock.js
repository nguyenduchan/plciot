/**
 * Khoá thiết bị bị MẤT TRỘM theo mã phần cứng (hw = 20 ký tự Crockford đầu của SHA-256(khoá công khai) — gatewayKey.js,
 * trùng "mã phần cứng" GatewayApp/board hiển thị). Người dùng báo mất → admin khoá hw:
 *   - server từ chối đăng ký / enroll / hỏi cấu hình / lấy lại QR / chuyển PC của hw đó (device_blocked);
 *   - gửi tín hiệu ký { sys:'lock' } tới gateway đang nối → board vào CHẾ ĐỘ KHOÁ (giữ qua reset bằng BOOT);
 *   - mở khoá: { sys:'unlock' } + gateway hỏi lại /gateway/config thấy hết bị chặn thì tự mở.
 * Không thu hồi tài khoản MQTT: để tín hiệu mở khoá tới được board khi tìm lại máy.
 * Bảng chỉ THÊM (tương thích ngược, DB_SCHEMA_VERSION 3).
 */
import { parsePubkey } from './gatewayKey.js';
import { notifyGateway } from './gatewayNotify.js';

const ready = new WeakSet();
export function initHwBlockTable(db) {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS blocked_hw (
    hw TEXT PRIMARY KEY,
    reason TEXT,
    blocked_by INTEGER,
    blocked_at INTEGER NOT NULL
  )`);
  ready.add(db);
}

const HW = /^[0-9A-HJKMNP-TV-Z]{20}$/;   // bảng chữ Crockford (không I, L, O, U)
export const normHw = (s) => String(s || '').trim().toUpperCase().replace(/[\s-]/g, '');

export function isHwBlocked(db, ...hws) {
  initHwBlockTable(db);   // DB nào cũng chạy được (kể cả DB dựng tay trong smoke test): chốt chặn không làm sập đường enroll
  for (const h of hws) {
    const v = normHw(h);
    if (v && db.prepare('SELECT 1 FROM blocked_hw WHERE hw = ?').get(v)) return true;
  }
  return false;
}

/** hw từ khoá công khai (base64url SPKI) — null nếu không đọc được. */
export const hwOfPubkey = (pk) => (pk ? parsePubkey(pk)?.hw || null : null);

/** Các tem (site/device) đang gắn với hw: activated_hw, hoặc khoá công khai đã lưu (gw_pubkey) sinh ra đúng hw. */
export function devicesOfHw(db, hw) {
  const v = normHw(hw);
  const cols = db.prepare("PRAGMA table_info('hardware_devices')").all().map((c) => c.name);
  const rows = db.prepare(`SELECT site, device, activated_hw${cols.includes('gw_pubkey') ? ', gw_pubkey' : ''} FROM hardware_devices`).all();
  return rows.filter((r) => r.activated_hw === v || (r.gw_pubkey && hwOfPubkey(r.gw_pubkey) === v)).map((r) => ({ site: r.site, device: r.device }));
}

export function listHwBlocks(db) {
  initHwBlockTable(db);
  return db.prepare('SELECT hw, reason, blocked_by AS blockedBy, blocked_at AS blockedAt FROM blocked_hw ORDER BY blocked_at DESC').all()
    .map((b) => ({ ...b, devices: devicesOfHw(db, b.hw) }));
}

export function blockHw(db, { hw, reason = '', adminId = null }) {
  initHwBlockTable(db);
  const v = normHw(hw);
  if (!HW.test(v)) return { error: 'bad_hw', status: 400 };
  db.prepare(`INSERT INTO blocked_hw (hw, reason, blocked_by, blocked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(hw) DO UPDATE SET reason = excluded.reason, blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at`)
    .run(v, String(reason).slice(0, 200), adminId, Date.now());
  const devices = devicesOfHw(db, v);
  for (const d of devices) notifyGateway(db, d.site, d.device, 'lock', { reason: String(reason).slice(0, 120) });   // board đang nối khoá ngay
  return { ok: true, hw: v, devices };
}

export function unblockHw(db, hw) {
  initHwBlockTable(db);
  const v = normHw(hw);
  const r = db.prepare('DELETE FROM blocked_hw WHERE hw = ?').run(v);
  if (!r.changes) return { error: 'not_found', status: 404 };
  const devices = devicesOfHw(db, v);
  for (const d of devices) notifyGateway(db, d.site, d.device, 'unlock');
  return { ok: true, hw: v, devices };
}

/** Lỗi chung trả cho gateway bị khoá (board nhận mã này thì vào chế độ khoá). */
export const BLOCKED = Object.freeze({ error: 'device_blocked', status: 403 });
