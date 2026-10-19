/** Simple in-memory sliding-window rate limiter (single process). */

export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * @param {{ windowMs: number, max: number, keyFn?: (req) => string }} opts
 */
export function rateLimit(opts) {
  const windowMs = opts.windowMs || 60_000;
  const max = opts.max || 30;
  const keyFn = opts.keyFn || ((req) => clientIp(req));
  const hits = new Map(); // key -> number[] timestamps

  // periodic cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const next = arr.filter((t) => now - t < windowMs);
      if (next.length) hits.set(k, next);
      else hits.delete(k);
    }
  }, Math.min(windowMs, 60_000)).unref?.();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let arr = hits.get(key) || [];
    arr = arr.filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
