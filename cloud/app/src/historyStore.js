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
  // src: nguồn của dòng. NULL = gói LIVE (giờ = lúc server nhận); 'bf' = gói BÙ do gateway gửi lại sau khi offline (giờ = thời điểm gốc). Không bao giờ lẫn hai loại.
  if (!db.prepare('PRAGMA table_info(mqtt_events)').all().some((c) => c.name === 'src')) db.exec('ALTER TABLE mqtt_events ADD COLUMN src TEXT');
}

export function insertEvent(db, row) {
  return db.prepare(`
    INSERT INTO mqtt_events (ts, site, device, kind, payload, o, i, a, c, s, src)
    VALUES (@ts, @site, @device, @kind, @payload, @o, @i, @a, @c, @s, @src)
  `).run({ src: null, ...row });
}

/** Telemetry schema:2 (có d) trong khoảng thời gian, kèm nguồn (src: null = live, 'bf' = bù). Dùng cho xuất dữ liệu. */
export function queryTelemetryRows(db, { site, device, since, until, limit = 200000 }) {
  return db.prepare(`
    SELECT ts, payload, src FROM mqtt_events
    WHERE site = ? AND device = ? AND kind = 'telemetry' AND ts > ? AND ts <= ?
    ORDER BY ts ASC LIMIT ?
  `).all(site, device, since, until, Math.min(Math.max(1, limit | 0), 500000));
}

/** Có dòng LIVE trong ±gapMs quanh ts không (gói bù không được chồng lên dữ liệu live). */
export function hasLiveTelemetryNear(db, { site, device, ts, gapMs }) {
  return !!db.prepare("SELECT 1 FROM mqtt_events WHERE site = ? AND device = ? AND kind = 'telemetry' AND src IS NULL AND ts BETWEEN ? AND ? LIMIT 1")
    .get(site, device, ts - gapMs, ts + gapMs);
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

/** Mẫu telemetry mới nhất (hoặc null). */
export function queryLastTelemetry(db, { site, device }) {
  return db.prepare(`
    SELECT id, ts AS t, o, i, a, c, s, payload
    FROM mqtt_events
    WHERE site = ? AND device = ? AND kind = 'telemetry' AND o IS NOT NULL
    ORDER BY ts DESC
    LIMIT 1
  `).get(site, device) || null;
}

export function queryLastEvent(db, { site, device, kind }) {
  return db.prepare(`
    SELECT id, ts, kind, payload
    FROM mqtt_events
    WHERE site = ? AND device = ? AND kind = ?
    ORDER BY ts DESC
    LIMIT 1
  `).get(site, device, kind) || null;
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
