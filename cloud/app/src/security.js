/** Basic hardening headers + CORS allowlist. */

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // PWA may need same-origin; avoid overly strict CSP that breaks inline-less app
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

export function buildCorsOptions() {
  const raw = process.env.CORS_ORIGINS || process.env.WEBAPP_PUBLIC_URL || '';
  const allowed = raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  // Always allow same-host requests (no Origin) e.g. curl / tunnel health
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (!allowed.length) return cb(null, true); // dev: unset allowlist
      const o = origin.replace(/\/$/, '');
      if (allowed.includes(o) || allowed.includes('*')) return cb(null, true);
      cb(new Error('CORS_NOT_ALLOWED'));
    },
    credentials: false,
    maxAge: 86400,
  };
}

/** History only for user's bound site/device unless HISTORY_OPEN_ACCESS=true. */
export function assertHistoryAccess(user, site, device) {
  if (String(process.env.HISTORY_OPEN_ACCESS || '').toLowerCase() === 'true') return true;
  return user.notify_site === site && user.notify_device === device;
}
