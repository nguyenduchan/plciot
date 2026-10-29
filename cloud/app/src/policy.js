/**
 * Chính sách chặn gói tin MQTT trái phép / vi phạm.
 *
 * Tự động: thiết bị lạ, hết hạn gói, payload xấu, quá lớn, flood, blocklist.
 * Thủ công: admin block site/device/tenant (console) — có thể kèm thu hồi MQTT.
 */
import crypto from 'crypto';
import { resolveSubscriber, requireKnownDevice, requireActiveSubscription } from './deviceBinding.js';
import { setMosquittoPassword, randomMqttPassword, rebuildAclFromUsers, reloadMosquitto } from './mqttProvision.js';

const floodBuckets = new Map(); // key -> { n, windowStart }
let rejectStats = Object.create(null);

export function initPolicyTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_blocks (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,          -- tenant | site | device | topic
      tenant_id TEXT,
      site TEXT,
      device TEXT,
      topic_prefix TEXT,
      reason TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'manual',  -- manual | auto
      enabled INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_policy_blocks_active ON policy_blocks(enabled, scope);
    CREATE TABLE IF NOT EXISTS policy_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      action TEXT NOT NULL,         -- allow | deny
      reason TEXT NOT NULL,
      site TEXT,
      device TEXT,
      tenant_id TEXT,
      kind TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_policy_events_ts ON policy_events(ts DESC);
  `);
}

function maxPayloadBytes() {
  const n = Number(process.env.POLICY_MAX_PAYLOAD_BYTES || 4096);
  return Number.isFinite(n) && n > 0 ? n : 4096;
}

function floodLimit() {
  // số gói / cửa sổ giây mỗi site/device (telemetry+status+…)
  return {
    max: Number(process.env.POLICY_FLOOD_MAX || 120),
    windowMs: Number(process.env.POLICY_FLOOD_WINDOW_SEC || 60) * 1000,
  };
}

function autoBlockAfter() {
  // sau N lần deny (unknown/flood) trong cửa sổ → tạo block tạm
  return {
    n: Number(process.env.POLICY_AUTO_BLOCK_AFTER || 50),
    windowMs: Number(process.env.POLICY_AUTO_BLOCK_WINDOW_SEC || 300) * 1000,
    ttlMs: Number(process.env.POLICY_AUTO_BLOCK_TTL_SEC || 3600) * 1000,
  };
}

const autoStrike = new Map(); // key -> { n, start }

function bumpReject(reason) {
  rejectStats[reason] = (rejectStats[reason] || 0) + 1;
}

export function takeRejectStats() {
  const out = rejectStats;
  rejectStats = Object.create(null);
  return out;
}

/** Xem thống kê deny hiện tại (không xoá) — cho Console monitor. */
export function peekRejectStats() {
  return { ...rejectStats };
}

function matchBlock(db, { tenant, site, device, topic }) {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM policy_blocks
    WHERE enabled = 1 AND (expires_at IS NULL OR expires_at > ?)
  `).all(now);
  for (const b of rows) {
    if (b.scope === 'tenant' && b.tenant_id && b.tenant_id === tenant) return b;
    if (b.scope === 'site' && b.site === site && (!b.tenant_id || b.tenant_id === tenant)) return b;
    if (b.scope === 'device' && b.site === site && b.device === device) return b;
    if (b.scope === 'topic' && b.topic_prefix && String(topic || '').startsWith(b.topic_prefix)) return b;
  }
  return null;
}

function checkFlood(site, device) {
  const { max, windowMs } = floodLimit();
  if (max <= 0) return null;
  const key = `${site}/${device}`;
  const now = Date.now();
  let b = floodBuckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    b = { n: 0, windowStart: now };
    floodBuckets.set(key, b);
  }
  b.n += 1;
  if (b.n > max) return { reason: 'flood', detail: `${b.n}/${max} per ${windowMs / 1000}s` };
  return null;
}

function maybeAutoBlock(db, { site, device, tenant, reason }) {
  const cfg = autoBlockAfter();
  if (cfg.n <= 0) return;
  if (!['unknown_device', 'flood', 'blocked'].includes(reason) && reason !== 'payload_too_large') return;
  const key = `${tenant || ''}/${site}/${device}:${reason}`;
  const now = Date.now();
  let s = autoStrike.get(key);
  if (!s || now - s.start >= cfg.windowMs) s = { n: 0, start: now };
  s.n += 1;
  autoStrike.set(key, s);
  if (s.n < cfg.n) return;
  autoStrike.delete(key);
  // đã có block device?
  const exists = db.prepare(`
    SELECT id FROM policy_blocks
    WHERE enabled = 1 AND scope = 'device' AND site = ? AND device = ?
      AND (expires_at IS NULL OR expires_at > ?)
  `).get(site, device, now);
  if (exists) return;
  createBlock(db, {
    scope: 'device', site, device, tenantId: tenant || null,
    reason: `auto:${reason}`, mode: 'auto',
    expiresAt: now + cfg.ttlMs, createdBy: 'policy-engine',
  });
}

function validatePayload(kind, text, bufLen) {
  if (bufLen > maxPayloadBytes()) {
    return { reason: 'payload_too_large', detail: `${bufLen}>${maxPayloadBytes()}` };
  }
  if (kind === 'telemetry') {
    let data;
    try { data = JSON.parse(text); } catch {
      return { reason: 'invalid_json', detail: 'telemetry' };
    }
    if (!Array.isArray(data.r)) return { reason: 'policy_telemetry_shape', detail: 'missing r[]' };
    // Tối thiểu 18 thanh ghi (map D0.. như PROTOCOL); generic profile có thể nới bằng env sau
    const minR = Number(process.env.POLICY_TELEMETRY_MIN_REGS || 18);
    if (data.r.length < minR) return { reason: 'policy_telemetry_shape', detail: `r length < ${minR}` };
    if (data.r.length > 512) return { reason: 'policy_telemetry_shape', detail: 'r too long' };
    if (data.schema != null && Number(data.schema) > 1) {
      return { reason: 'schema_unsupported', detail: String(data.schema) };
    }
  }
  if (kind === 'status') {
    const ok = ['online', 'offline', 'plc_fault', 'fault'].includes(String(text).trim())
      || (text.startsWith('{') && text.length < 200);
    if (!ok && text.length > 64) return { reason: 'policy_status_shape', detail: 'bad status' };
  }
  if (kind === 'cmd') {
    // ingest không nên nhận cmd từ thiết bị giả; cmd chỉ từ ctl
    return { reason: 'cmd_on_ingest_path', detail: 'cmd ignored' };
  }
  return null;
}

/**
 * Kiểm tra đầy đủ trước khi lưu / webhook.
 * @returns {{ allow: true, sub } | { allow: false, reason, detail?, sub? }}
 */
export function evaluateIngest(db, {
  topic, parsed, payloadBuf,
}) {
  const { site, device, kind, tenant, ns } = parsed;
  const text = payloadBuf.toString();
  const bufLen = payloadBuf.length;

  const blocked = matchBlock(db, { tenant, site, device, topic });
  if (blocked) {
    return { allow: false, reason: 'manual_block', detail: blocked.reason || blocked.id, blockId: blocked.id };
  }

  const flood = checkFlood(site, device);
  if (flood) return { allow: false, reason: flood.reason, detail: flood.detail };

  const shape = validatePayload(kind, text, bufLen);
  if (shape) return { allow: false, reason: shape.reason, detail: shape.detail };

  const sub = resolveSubscriber(db, { tenant, site, device, ns });
  if (!sub.ok) return { allow: false, reason: sub.reason, detail: sub.reason, sub };

  // thiết bị bị status=blocked trong bảng devices
  if (sub.source === 'device' && sub.deviceId) {
    const d = db.prepare('SELECT status FROM devices WHERE id = ?').get(sub.deviceId);
    if (d && d.status === 'blocked') {
      return { allow: false, reason: 'device_blocked', detail: String(sub.deviceId), sub };
    }
  }

  return { allow: true, sub };
}

export function logPolicyEvent(db, row) {
  try {
    db.prepare(`
      INSERT INTO policy_events (ts, action, reason, site, device, tenant_id, kind, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.ts || Date.now(),
      row.action,
      row.reason,
      row.site || null,
      row.device || null,
      row.tenantId || null,
      row.kind || null,
      row.detail ? String(row.detail).slice(0, 200) : null,
    );
  } catch (e) {
    console.error('policy log', e.message);
  }
}

export function recordDeny(db, ctx) {
  bumpReject(ctx.reason);
  logPolicyEvent(db, { ...ctx, action: 'deny' });
  maybeAutoBlock(db, ctx);
}

export function createBlock(db, {
  scope, tenantId = null, site = null, device = null, topicPrefix = null,
  reason, mode = 'manual', expiresAt = null, createdBy = 'admin',
}) {
  if (!['tenant', 'site', 'device', 'topic'].includes(scope)) {
    return { error: 'invalid_scope', status: 400 };
  }
  if (scope === 'device' && (!site || !device)) return { error: 'site_device_required', status: 400 };
  if (scope === 'site' && !site) return { error: 'site_required', status: 400 };
  if (scope === 'tenant' && !tenantId) return { error: 'tenant_required', status: 400 };
  if (scope === 'topic' && !topicPrefix) return { error: 'topic_prefix_required', status: 400 };

  const id = `blk_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare(`
    INSERT INTO policy_blocks
      (id, scope, tenant_id, site, device, topic_prefix, reason, mode, enabled, expires_at, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id, scope, tenantId, site, device, topicPrefix,
    String(reason || 'blocked').slice(0, 200), mode,
    expiresAt, Date.now(), String(createdBy || 'admin').slice(0, 80),
  );
  return { ok: true, block: getBlock(db, id) };
}

export function getBlock(db, id) {
  return db.prepare('SELECT * FROM policy_blocks WHERE id = ?').get(id);
}

export function listBlocks(db, { includeDisabled = false } = {}) {
  if (includeDisabled) {
    return db.prepare('SELECT * FROM policy_blocks ORDER BY created_at DESC LIMIT 200').all();
  }
  return db.prepare(`
    SELECT * FROM policy_blocks WHERE enabled = 1
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC LIMIT 200
  `).all(Date.now());
}

export function disableBlock(db, id) {
  const info = db.prepare('UPDATE policy_blocks SET enabled = 0 WHERE id = ?').run(id);
  if (!info.changes) return { error: 'not_found', status: 404 };
  return { ok: true };
}

/** Chặn cứng thiết bị: blocklist + status=blocked + xoay mật khẩu MQTT. */
export function hardBlockDevice(db, { tenantId, site, device, reason, createdBy }) {
  const row = db.prepare(
    'SELECT * FROM devices WHERE tenant_id = ? AND site = ? AND device = ?',
  ).get(tenantId, site, device)
    || db.prepare('SELECT * FROM devices WHERE site = ? AND device = ? ORDER BY id LIMIT 1').get(site, device);

  const blk = createBlock(db, {
    scope: 'device', tenantId: tenantId || row?.tenant_id, site, device,
    reason: reason || 'hard_block', mode: 'manual', createdBy,
  });
  if (blk.error) return blk;

  if (row) {
    const newPass = randomMqttPassword();
    db.prepare(`UPDATE devices SET status = 'blocked', mqtt_pass = ?, updated_at = ? WHERE id = ?`)
      .run(newPass, Date.now(), row.id);
    if (row.mqtt_user) setMosquittoPassword(row.mqtt_user, newPass);
    rebuildAclFromUsers(db);
    reloadMosquitto();
  }
  return { ok: true, block: blk.block, deviceRevoked: !!row };
}

export function listPolicyEvents(db, { limit = 100, since = 0 } = {}) {
  const lim = Math.min(Math.max(1, limit | 0), 500);
  return db.prepare(`
    SELECT id, ts, action, reason, site, device, tenant_id AS tenantId, kind, detail
    FROM policy_events
    WHERE ts > ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(since, lim);
}

export function policyConfigPublic() {
  return {
    maxPayloadBytes: maxPayloadBytes(),
    flood: floodLimit(),
    autoBlock: autoBlockAfter(),
    requireKnown: requireKnownDevice(),
    requireActiveSub: requireActiveSubscription(),
  };
}
