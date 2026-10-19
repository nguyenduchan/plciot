/** MQTT event log in the same SQLite file as users (WAL). */

export function initHistoryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mqtt_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      o INTEGER,
      i INTEGER,
      a INTEGER,
      c INTEGER,
      s INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mqtt_site_dev_ts ON mqtt_events(site, device, ts);
    CREATE INDEX IF NOT EXISTS idx_mqtt_site_dev_kind_ts ON mqtt_events(site, device, kind, ts);
    CREATE INDEX IF NOT EXISTS idx_mqtt_ts ON mqtt_events(ts);
  `);
}

export function insertEvent(db, row) {
  return db.prepare(`
    INSERT INTO mqtt_events (ts, site, device, kind, payload, o, i, a, c, s)
    VALUES (@ts, @site, @device, @kind, @payload, @o, @i, @a, @c, @s)
  `).run(row);
}

export function queryTelemetry(db, { site, device, since, until, limit = 5000 }) {
  const lim = Math.min(Math.max(1, limit | 0), 10000);
  const rows = db.prepare(`
    SELECT id, ts AS t, o, i, a, c, s
    FROM mqtt_events
    WHERE site = ? AND device = ? AND kind = 'telemetry'
      AND ts > ? AND ts <= ?
      AND o IS NOT NULL
    ORDER BY ts ASC
    LIMIT ?
  `).all(site, device, since, until, lim);
  return rows;
}

export function queryEvents(db, { site, device, since, until, kinds, limit = 2000 }) {
  const lim = Math.min(Math.max(1, limit | 0), 5000);
  let sql = `
    SELECT id, ts, kind, payload
    FROM mqtt_events
    WHERE site = ? AND device = ? AND ts > ? AND ts <= ?
  `;
  const args = [site, device, since, until];
  if (kinds?.length) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    args.push(...kinds);
  }
  sql += ' ORDER BY ts ASC LIMIT ?';
  args.push(lim);
  return db.prepare(sql).all(...args);
}

export function purgeOlderThan(db, cutoffTs) {
  const info = db.prepare('DELETE FROM mqtt_events WHERE ts < ?').run(cutoffTs);
  return info.changes;
}

export function historyStats(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM mqtt_events').get().n;
  const oldest = db.prepare('SELECT MIN(ts) AS t FROM mqtt_events').get().t;
  const newest = db.prepare('SELECT MAX(ts) AS t FROM mqtt_events').get().t;
  return { total, oldest, newest };
}
