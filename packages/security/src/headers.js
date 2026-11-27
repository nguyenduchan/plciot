/** Header bảo mật HTTP (CSP, v.v.) và allowlist CORS. */

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  // CSP: không cho script nội tuyến/nguồn lạ → XSS khó lấy được JWT và token điều khiển. connect-src mở wss:/ws: cho broker MQTT.
  const extra = process.env.CSP_CONNECT_EXTRA ? ` ${process.env.CSP_CONNECT_EXTRA}` : '';
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
    `connect-src 'self' wss: ws:${extra}`, "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

/** Trình duyệt tới qua http hay https: Cloudflare (Tunnel) ghi CF-Visitor {"scheme":"http|https"}; proxy khác dùng X-Forwarded-Proto. Không qua proxy → null. */
function visitorScheme(req) {
  const cf = req.headers['cf-visitor'];
  if (cf) { try { const s = JSON.parse(cf).scheme; if (s === 'http' || s === 'https') return s; } catch { /* header hỏng: xét tiếp */ } }
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return xf === 'http' || xf === 'https' ? xf : null;
}

/**
 * Chống hạ cấp xuống HTTP (SSL-strip) khi chạy sau Cloudflare/proxy: người dùng gõ http://… → 301 sang https; lệnh ghi (POST/PUT…)
 * qua http bị từ chối (không chuyển hướng để mật khẩu/token không đi lần thứ hai qua đường hở). Trả lời qua https kèm HSTS
 * (HSTS_MAX_AGE giây, mặc định 1 năm; 0 = tắt) → trình duyệt tự dùng https từ lần sau, kẻ giữa đường không chen được bản http.
 * Truy cập thẳng không qua proxy (server cài trong LAN, http://192.168…) không bị ảnh hưởng. Tắt hẳn: HTTPS_REDIRECT=0.
 */
export function httpsOnly(req, res, next) {
  if (process.env.HTTPS_REDIRECT === '0') return next();
  const scheme = visitorScheme(req);
  if (scheme === 'http') {
    const host = String(req.headers.host || '').replace(/[^a-z0-9.:\-[\]]/gi, '');
    if (host && (req.method === 'GET' || req.method === 'HEAD')) return res.redirect(301, `https://${host}${req.originalUrl || req.url}`);
    return res.status(403).json({ error: 'https_required' });
  }
  if (scheme === 'https') {
    const age = Number.parseInt(process.env.HSTS_MAX_AGE ?? '31536000', 10);
    if (age > 0) res.setHeader('Strict-Transport-Security', `max-age=${age}`);
  }
  next();
}

export function buildCorsOptions() {
  const raw = process.env.CORS_ORIGINS || process.env.WEBAPP_PUBLIC_URL || '';
  const allowed = raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  // Trang admin riêng (ADMIN_HOST) là một origin khác: tự cho phép để đăng nhập từ chính tên miền đó không bị 403.
  const adminHost = String(process.env.ADMIN_HOST || '').trim().toLowerCase();
  if (adminHost && allowed.length) allowed.push(`https://${adminHost}`);
  // Không có Origin (curl / health) thì cho qua
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (!allowed.length) return cb(null, true); // dev: chưa đặt allowlist
      const o = origin.replace(/\/$/, '');
      if (allowed.includes(o) || allowed.includes('*')) return cb(null, true);
      cb(new Error('CORS_NOT_ALLOWED'));
    },
    credentials: false,
    exposedHeaders: ['X-Renewed-Token'],
    maxAge: 86400,
  };
}
