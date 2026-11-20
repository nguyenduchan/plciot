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
  // Người dùng BÁO MẤT → khoá tạm (blocked_hw) + báo cáo chờ admin duyệt. Chỉ THÊM bảng (tương thích ngược, DB_SCHEMA_VERSION 4).
  db.exec(`CREATE TABLE IF NOT EXISTS hw_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hw TEXT NOT NULL,
    site TEXT NOT NULL,
    device TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | cancelled | released
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by INTEGER,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hw_reports_hw ON hw_reports (hw, status);
  CREATE INDEX IF NOT EXISTS idx_hw_reports_user ON hw_reports (user_id, created_at)`);
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
  // admin mở khoá thẳng: báo cáo đang chờ → rejected, báo cáo đã duyệt → released
  db.prepare("UPDATE hw_reports SET status = CASE status WHEN 'pending' THEN 'rejected' ELSE 'released' END, decided_at = ? WHERE hw = ? AND status IN ('pending','approved')").run(Date.now(), v);
  const devices = devicesOfHw(db, v);
  for (const d of devices) notifyGateway(db, d.site, d.device, 'unlock');
  return { ok: true, hw: v, devices };
}

/** Lỗi chung trả cho gateway bị khoá (board nhận mã này thì vào chế độ khoá). */
export const BLOCKED = Object.freeze({ error: 'device_blocked', status: 403 });

// ---------------------------------------------------------------- người dùng BÁO MẤT → khoá tạm → admin duyệt
export const REPORTS_PER_DAY = Number(process.env.HW_REPORTS_PER_DAY || 3);

/** Mã phần cứng của gateway site/device (tem đã kích hoạt, hoặc khoá công khai đã lưu). null = chưa gắn máy nào. */
export function hwOfGateway(db, site, device) {
  const cols = db.prepare("PRAGMA table_info('hardware_devices')").all().map((c) => c.name);
  const r = db.prepare(`SELECT activated_hw${cols.includes('gw_pubkey') ? ', gw_pubkey' : ''} FROM hardware_devices WHERE site = ? AND device = ?`).get(site, device);
  if (!r) return null;
  return normHw(r.activated_hw) || (r.gw_pubkey ? hwOfPubkey(r.gw_pubkey) : null) || null;
}

/** Gateway đang bị khoá (admin khoá hoặc đang chờ duyệt báo mất)? Server từ chối lệnh điều khiển tới nó. */
export function isGatewayLocked(db, site, device) {
  const hw = hwOfGateway(db, site, device);
  return Boolean(hw) && isHwBlocked(db, hw);
}

const REPORT_COLS = 'id, hw, site, device, user_id AS userId, reason, status, created_at AS createdAt, decided_at AS decidedAt, decided_by AS decidedBy, note';

/**
 * Chủ gateway báo mất: khoá tạm NGAY (gateway đang nối nhận { sys:'lock' }) và mở báo cáo chờ admin.
 * Gọi sau khi route đã kiểm user sở hữu gateway và qua step-up.
 */
export function reportLost(db, { userId, site, device, reason = '' }) {
  initHwBlockTable(db);
  const hw = hwOfGateway(db, site, device);
  if (!hw) return { error: 'no_hardware', status: 409 };
  if (db.prepare("SELECT 1 FROM hw_reports WHERE hw = ? AND status = 'pending'").get(hw)) return { error: 'already_reported', status: 409 };
  if (isHwBlocked(db, hw)) return { error: 'already_blocked', status: 409 };
  const recent = db.prepare('SELECT COUNT(*) c FROM hw_reports WHERE user_id = ? AND created_at > ?').get(userId, Date.now() - 86_400_000).c;
  if (recent >= REPORTS_PER_DAY) return { error: 'report_limit', status: 429 };
  const text = String(reason || '').trim().slice(0, 200);
  const id = db.prepare('INSERT INTO hw_reports (hw, site, device, user_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(hw, site, device, userId, text, 'pending', Date.now()).lastInsertRowid;
  blockHw(db, { hw, reason: `[chủ báo mất #${id}, chờ admin duyệt] ${text}`.slice(0, 200), adminId: null });
  return { ok: true, report: getReport(db, Number(id)) };
}

export function getReport(db, id) {
  return db.prepare(`SELECT ${REPORT_COLS} FROM hw_reports WHERE id = ?`).get(id) || null;
}

/** Danh sách báo cáo: của một user (userId) hoặc tất cả (admin), lọc theo trạng thái. */
export function listReports(db, { userId = null, status = '' } = {}) {
  initHwBlockTable(db);
  const where = []; const args = [];
  if (userId != null) { where.push('user_id = ?'); args.push(userId); }
  if (status) { where.push('status = ?'); args.push(status); }
  return db.prepare(`SELECT ${REPORT_COLS} FROM hw_reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args);
}

/** Admin duyệt (giữ khoá, ghi tên admin) hoặc từ chối (mở khoá — báo nhầm / tìm lại máy). Chỉ báo cáo đang chờ. */
export function decideReport(db, id, { approve, adminId = null, note = '' }) {
  const r = getReport(db, id);
  if (!r) return { error: 'not_found', status: 404 };
  if (r.status !== 'pending') return { error: 'not_pending', status: 409 };
  const n = String(note || '').slice(0, 200);
  if (approve) {
    db.prepare("UPDATE hw_reports SET status = 'approved', decided_at = ?, decided_by = ?, note = ? WHERE id = ?").run(Date.now(), adminId, n, id);
    blockHw(db, { hw: r.hw, reason: `[chủ báo mất #${id}, admin đã duyệt] ${r.reason || ''}`.slice(0, 200), adminId });
  } else {
    unblockHw(db, r.hw);   // đóng luôn báo cáo chờ thành 'rejected'
    db.prepare("UPDATE hw_reports SET status = 'rejected', decided_at = ?, decided_by = ?, note = ? WHERE id = ?").run(Date.now(), adminId, n, id);
  }
  return { ok: true, report: getReport(db, id) };
}

/** Chủ tìm lại máy / báo nhầm: tự huỷ báo cáo CHƯA được admin duyệt → mở khoá. */
export function cancelReport(db, id, userId) {
  const r = getReport(db, id);
  if (!r || r.userId !== userId) return { error: 'not_found', status: 404 };
  if (r.status !== 'pending') return { error: 'not_pending', status: 409 };
  unblockHw(db, r.hw);
  db.prepare("UPDATE hw_reports SET status = 'cancelled', decided_at = ?, decided_by = ? WHERE id = ?").run(Date.now(), userId, id);
  return { ok: true, report: getReport(db, id) };
}
