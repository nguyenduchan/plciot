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

/**
 * Khoá TRANG admin + toàn bộ /api/admin: chỉ loopback (đường hầm SSH) hoặc IP trong ADMIN_ONLY_CIDRS vào được.
 * Còn lại nhận 404 như thể trang không tồn tại. ADMIN_ONLY_CIDRS trống = không giới hạn (hành vi cũ).
 * Đặt ADMIN_ONLY_CIDRS=127.0.0.1/32 để chỉ cho đường hầm SSH.
 */
const ADMIN_PATHS = new Set(['/admin.html', '/admin.js']);
/**
 * ADMIN_INTERNET_USERS=nguyenduchan[,tên khác]: CHỈ các tài khoản này được dùng trang + API admin từ Internet (đã đăng nhập).
 * Mọi tài khoản khác vẫn chỉ vào qua đường hầm SSH / IP trong ADMIN_ONLY_CIDRS. Trống = không ai từ Internet (hành vi cũ).
 */
export function adminInternetUsers() {
  return String(process.env.ADMIN_INTERNET_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export function isInternetAdminUser(user) {
  return Boolean(user?.username) && adminInternetUsers().includes(String(user.username).toLowerCase());
}
const isAdminPath = (p) => ADMIN_PATHS.has(p) || p === '/api/admin' || p.startsWith('/api/admin/');

export function isAdminLocalRequest(req) {
  const raw = String(process.env.ADMIN_ONLY_CIDRS || '').trim();
  const ip = clientIp(req);
  return isLoopbackIp(ip) || isDirectLocal(req) || Boolean(raw && ipInCidrs(ip, raw.split(',').map((s) => s.trim()).filter(Boolean)));
}

export function adminLocalOnly(req, res, next) {
  const raw = String(process.env.ADMIN_ONLY_CIDRS || '').trim();
  if (!raw) return next();
  if (!isAdminPath(req.path)) return next();
  if (isAdminLocalRequest(req)) return next();
  if (adminInternetUsers().length) { req.adminInternet = true; return next(); }   // quyết định theo tài khoản ở adminInternetGuard
  return res.status(404).type('text/plain').send('Not found');
}

/**
 * Đặt NGAY SAU adminLocalOnly. Yêu cầu admin từ Internet vào /api/admin/*: phải đăng nhập và đúng tài khoản trong
 * ADMIN_INTERNET_USERS, nếu không trả 404 (không lộ có API). Kiểm TRƯỚC mọi route nên không route admin nào lọt.
 * Trang tĩnh /admin.html, /admin.js vẫn tải được (chỉ là HTML, không có dữ liệu — mọi dữ liệu đều qua API đã khoá).
 */
export function adminInternetGuard(requireAuth) {
  return (req, res, next) => {
    if (!req.adminInternet || ADMIN_PATHS.has(req.path)) return next();
    requireAuth(req, res, () => (isInternetAdminUser(req.user) ? next() : res.status(404).type('text/plain').send('Not found')));
  };
}

/** Đường hầm SSH tới 127.0.0.1:3080 đi qua cầu Docker nên nguồn là IP riêng, nhưng KHÔNG có header của Cloudflare/proxy.
 *  Mọi truy cập Internet đều qua Cloudflare Tunnel và luôn mang CF-Connecting-IP, nên không giả được trường hợp này từ ngoài
 *  (cổng 3080 chỉ mở trên loopback của VPS). */
export function isDirectLocal(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['forwarded']) return false;
  const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ipInCidrs(remote, ['127.0.0.0/8', '172.16.0.0/12', '10.0.0.0/8', '192.168.0.0/16']);
}

function isLoopbackIp(ip) {
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
  if (req.adminInternet && isInternetAdminUser(req.user)) return next();   // tài khoản được chỉ định mở admin từ Internet
  if (String(process.env.ADMIN_HOME_PC_TRUST || 'true').toLowerCase() !== 'false'
    && db && verifyHomePcRequest(db, req, req.path)) {
    return next();
  }
  return res.status(403).json({
    error: 'admin_network_denied',
    hint: 'PC nhà phải ký device-proof từ đúng trình duyệt đã đánh dấu; hoặc IP allow / SSH / Cloudflare Access.',
  });
}
