/**
 * Siết kênh admin từ Internet: IP allow-list, Cloudflare Access, hoặc PC nhà đã đánh dấu.
 * Không thay thế Passkey/reauth.
 */
import { clientIp, ipInCidrs } from '@plciot/security';
import { verifyHomePcRequest } from './homePc.js';

function allowList() {
  return String(process.env.ADMIN_OPS_ALLOW_CIDRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isLoopback(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  return s === '127.0.0.1' || s === '::1';
}

export function adminOpsStrict() {
  return String(process.env.ADMIN_OPS_STRICT || 'false').toLowerCase() === 'true';
}

export function adminNetworkAllowed(ip) {
  const list = allowList();
  if (isLoopback(ip)) return true;
  if (!list.length) return !adminOpsStrict();
  return ipInCidrs(ip, list);
}

export function cloudflareAccessOk(req) {
  if (String(process.env.CF_ACCESS_TRUST || 'false').toLowerCase() !== 'true') return false;
  const jwt = req.headers['cf-access-jwt-assertion'] || req.headers['cf-access-token'];
  const email = req.headers['cf-access-authenticated-user-email'];
  if (!jwt && !email) return false;
  const allowEmails = String(process.env.CF_ACCESS_ALLOW_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowEmails.length && email && !allowEmails.includes(String(email).toLowerCase())) return false;
  return true;
}

/**
 * Middleware ghi admin: IP / CF Access / PC nhà (chữ ký khoá thiết bị, không chỉ UUID).
 */
export function requireAdminNetwork(req, res, next) {
  const ip = clientIp(req);
  const db = req.app?.locals?.db;
  if (adminNetworkAllowed(ip) || cloudflareAccessOk(req)) return next();
  if (String(process.env.ADMIN_HOME_PC_TRUST || 'true').toLowerCase() !== 'false'
    && db && verifyHomePcRequest(db, req, req.path)) {
    return next();
  }
  return res.status(403).json({
    error: 'admin_network_denied',
    hint: 'PC nhà phải ký device-proof từ đúng trình duyệt đã đánh dấu; hoặc IP allow / SSH / Cloudflare Access.',
  });
}
