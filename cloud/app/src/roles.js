/**
 * Vai trò:
 *   admin    — quản lý người dùng (thêm/sửa/khoá/xoá) + toàn quyền trên thiết bị của mình
 *   operator — xem + điều khiển (gửi lệnh) thiết bị của mình
 *   viewer   — chỉ xem; broker không cấp quyền ghi …/cmd
 */
export const ROLES = ['admin', 'operator', 'viewer'];
export const DEFAULT_ROLE = 'operator';

/** Nhóm thông tin (topic) mà người dùng có thể được phép đọc ("monitor"). */
export const MONITOR_SCOPES = ['telemetry', 'status', 'ack', 'history'];

/** NULL trong DB = toàn bộ; '' = không được đọc nhóm nào. Trả về mảng hợp lệ, giữ thứ tự chuẩn. */
export function userScopes(u) {
  if (u?.monitor_scopes == null) return [...MONITOR_SCOPES]; // chuỗi rỗng = không nhóm nào
  const set = new Set(String(u.monitor_scopes).split(','));
  return MONITOR_SCOPES.filter((s) => set.has(s));
}

/** Chuẩn hoá đầu vào từ admin; trả null nếu không hợp lệ. */
export function parseScopes(input) {
  if (!Array.isArray(input)) return null;
  if (input.some((s) => !MONITOR_SCOPES.includes(s))) return null;
  return MONITOR_SCOPES.filter((s) => input.includes(s));
}

export const isRole = (r) => ROLES.includes(r);
export const isAdmin = (u) => u?.role === 'admin';
export const canControl = (u) => u?.role === 'admin' || u?.role === 'operator';
