/** Header bảo mật HTTP (CSP, v.v.) và allowlist CORS. */

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP: không cho script nội tuyến/nguồn lạ → XSS khó lấy được JWT và token điều khiển. connect-src mở wss:/ws: cho broker MQTT.
  const extra = process.env.CSP_CONNECT_EXTRA ? ` ${process.env.CSP_CONNECT_EXTRA}` : '';
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
    `connect-src 'self' wss: ws:${extra}`, "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

export function buildCorsOptions() {
  const raw = process.env.CORS_ORIGINS || process.env.WEBAPP_PUBLIC_URL || '';
  const allowed = raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
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
