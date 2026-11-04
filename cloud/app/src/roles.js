/**
 * Vai trò:
 *   admin    — quản lý người dùng + toàn quyền trên thiết bị của mình
 *   operator — xem + điều khiển
 *   viewer   — chỉ xem
 */
export const ROLES = ['admin', 'operator', 'viewer'];
export const DEFAULT_ROLE = 'operator';
export const MONITOR_SCOPES = ['telemetry', 'status', 'ack', 'history'];

export function userScopes(u) {
  if (u?.monitor_scopes == null) return [...MONITOR_SCOPES];
  const set = new Set(String(u.monitor_scopes).split(','));
  return MONITOR_SCOPES.filter((s) => set.has(s));
}

export function parseScopes(input) {
  if (!Array.isArray(input)) return null;
  if (input.some((s) => !MONITOR_SCOPES.includes(s))) return null;
  return MONITOR_SCOPES.filter((s) => input.includes(s));
}

export const isRole = (r) => ROLES.includes(r);
export const isAdmin = (u) => u?.role === 'admin';
export const canControl = (u) => u?.role === 'admin' || u?.role === 'operator';

/** Allow-list username (ADMIN_DASHBOARD_USERS / ADMIN_USERNAMES). Trống = mọi role=admin. */
export function dashboardAdminUsers() {
  const raw = process.env.ADMIN_DASHBOARD_USERS || process.env.ADMIN_USERNAMES || process.env.ADMIN_PHONES || '';
  return [...new Set(String(raw).split(',').map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
}

export function userIdentity(u) {
  return String(u?.username || '').trim().toLowerCase();
}

export function isDashboardAdmin(u) {
  if (!isAdmin(u)) return false;
  const list = dashboardAdminUsers();
  if (!list.length) return true;
  return list.includes(userIdentity(u));
}

export function canPromoteToAdmin(username) {
  const list = dashboardAdminUsers();
  if (!list.length) return true;
  return list.includes(String(username || '').trim().toLowerCase());
}

/** @deprecated */
export const dashboardAdminPhones = dashboardAdminUsers;
export const userPhone = userIdentity;
