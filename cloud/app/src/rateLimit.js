/** Simple in-memory sliding-window rate limiter (single process). */

import { ipInCidrs } from './controlAuth.js';

/**
 * Chỉ tin CF-Connecting-IP / X-Forwarded-For khi kết nối TCP đến từ proxy tin cậy (TRUST_PROXY_CIDRS, mặc định
 * loopback + dải riêng của Docker/LAN). Truy cập thẳng từ internet không giả được IP bằng header.
 * X-Forwarded-For đọc từ phải sang trái, bỏ các hop tin cậy; phần tử đầu tiên không tin cậy là client.
 */
const DEFAULT_TRUSTED = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1'];
const trustedList = () => (process.env.TRUST_PROXY_CIDRS ? process.env.TRUST_PROXY_CIDRS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TRUSTED);

export function clientIp(req) {
  const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
  const trusted = trustedList();
  if (!ipInCidrs(remote, trusted)) return remote;
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const hops = String(xff).split(',').map((x) => x.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) if (!ipInCidrs(hops[i], trusted)) return hops[i];
    return hops[0] || remote;
  }
  return remote;
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
