/** Security audit trail (who/when/IP) + helpers for lockout counters. */

export function audit(db, event, { userId = null, ip = null, detail = null } = {}) {
  try {
    db.prepare('INSERT INTO audit_log (ts, user_id, event, ip, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), userId, event, ip, detail == null ? null : String(detail).slice(0, 500));
  } catch (e) {
    console.error('audit', e.message);
  }
}

export function countAudit(db, userId, event, sinceMs) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND event = ? AND ts >= ?',
  ).get(userId, event, sinceMs).n;
}
