/**
 * History retention per account (plan).
 *   users.retention_days  NULL → default plan (HISTORY_DEFAULT_DAYS, 3 days)
 *                         0    → unlimited
 *                         N≥4  → N days (paid tiers are not fixed: any N from 4 up)
 * Several accounts may share a site/device; the longest retention wins.
 */
const DAY = 86_400_000;
export const MIN_PAID_DAYS = 4;

export function defaultDays() {
  const n = Number(process.env.HISTORY_DEFAULT_DAYS);
  return Number.isInteger(n) && n >= 1 ? n : 3;
}

/** Days kept for one account; Infinity = unlimited. */
export function effectiveDays(user) {
  const d = user?.retention_days;
  if (d == null) return defaultDays();
  return d === 0 ? Infinity : d;
}

export function retentionInfo(user) {
  const d = effectiveDays(user);
  return { retentionDays: Number.isFinite(d) ? d : null, unlimited: !Number.isFinite(d), plan: user?.retention_days == null ? 'default' : 'custom' };
}

/** Earliest ts (ms) the account may read; 0 when unlimited. */
export function retentionFloor(user, now = Date.now()) {
  const d = effectiveDays(user);
  return Number.isFinite(d) ? now - d * DAY : 0;
}

/** Parse admin input: "default" | "unlimited" | integer ≥ 4. Returns {value} or {error}. */
export function parseRetention(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === 'default' || s === 'null') return { value: null };
  if (['unlimited', 'inf', 'infinity', '0', '∞'].includes(s)) return { value: 0 };
  const n = Number(s);
  if (!Number.isInteger(n) || n < MIN_PAID_DAYS) return { error: `retention must be "default", "unlimited" or an integer >= ${MIN_PAID_DAYS}` };
  return { value: n };
}

export function setRetention(db, userId, value) {
  db.prepare('UPDATE users SET retention_days = ? WHERE id = ?').run(value, userId);
}

/**
 * Delete expired events honouring each site/device's longest plan.
 * Pairs with no explicit plan use the default; pairs with an explicit plan are handled per pair.
 */
export function purgeByPlan(db, now = Date.now()) {
  const users = db.prepare('SELECT notify_site AS site, notify_device AS device, retention_days FROM users').all();
  const pairs = new Map(); // "site\0device" -> { site, device, days, explicit }
  for (const u of users) {
    const k = `${u.site}\0${u.device}`;
    const d = effectiveDays(u);
    const cur = pairs.get(k) || { site: u.site, device: u.device, days: 0, explicit: false };
    cur.days = Math.max(cur.days, d);
    cur.explicit = cur.explicit || u.retention_days != null;
    pairs.set(k, cur);
  }

  let deleted = 0;
  // Default retention for everything without an explicit plan (including orphan data).
  deleted += db.prepare(`
    DELETE FROM mqtt_events
    WHERE ts < ?
      AND NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.notify_site = mqtt_events.site AND u.notify_device = mqtt_events.device
          AND u.retention_days IS NOT NULL
      )
  `).run(now - defaultDays() * DAY).changes;

  const del = db.prepare('DELETE FROM mqtt_events WHERE site = ? AND device = ? AND ts < ?');
  for (const p of pairs.values()) {
    if (!p.explicit || !Number.isFinite(p.days)) continue; // unlimited → keep
    deleted += del.run(p.site, p.device, now - p.days * DAY).changes;
  }
  return deleted;
}

/** Remove every stored event of one device namespace (ownership change / user request). */
export function wipeDeviceHistory(db, site, device) {
  return db.prepare('DELETE FROM mqtt_events WHERE site = ? AND device = ?').run(site, device).changes;
}
