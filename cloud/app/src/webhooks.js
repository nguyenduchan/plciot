/**
 * Webhook partner: đăng ký URL, đẩy sự kiện status / alarm / count_done.
 * Chữ ký: header X-Plciot-Signature = sha256=<hmac_hex> (HMAC-SHA256 body, secret lúc tạo).
 */
import crypto from 'crypto';
import { isValidId, sanitizeId } from './contract.js';

const ALLOWED_EVENTS = new Set(['status', 'alarm', 'count_done', 'telemetry']);

export function listWebhooks(db, tenantId) {
  return db.prepare(`
    SELECT id, url, events, enabled, created_at AS createdAt
    FROM webhooks WHERE tenant_id = ? ORDER BY created_at DESC
  `).all(tenantId);
}

export function createWebhook(db, tenantId, { url, events } = {}) {
  const u = String(url || '').trim();
  if (!/^https:\/\//i.test(u) && process.env.WEBHOOK_ALLOW_HTTP !== 'true') {
    return { error: 'https_required', status: 400 };
  }
  if (!/^https?:\/\//i.test(u) || u.length > 500) return { error: 'invalid_url', status: 400 };
  const ev = normalizeEvents(events);
  if (!ev.length) return { error: 'invalid_events', status: 400 };
  const id = `wh_${crypto.randomBytes(8).toString('hex')}`;
  const secret = crypto.randomBytes(24).toString('base64url');
  db.prepare(`
    INSERT INTO webhooks (id, tenant_id, url, secret, events, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, tenantId, u, secret, ev.join(','), Date.now());
  return {
    ok: true,
    webhook: { id, url: u, events: ev, enabled: true },
    secret, // chỉ trả một lần
  };
}

export function deleteWebhook(db, tenantId, id) {
  const info = db.prepare('DELETE FROM webhooks WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  if (!info.changes) return { error: 'not_found', status: 404 };
  return { ok: true };
}

function normalizeEvents(input) {
  const list = Array.isArray(input)
    ? input
    : String(input || 'status,alarm').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(list.filter((e) => ALLOWED_EVENTS.has(e)))];
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Gửi bất đồng bộ tới mọi webhook của tenant khớp event.
 * tenantId: từ topic iot/… hoặc tra devices theo site/device.
 */
export function emitWebhook(db, {
  tenantId, site, device, event, data = {},
}) {
  if (!tenantId || !ALLOWED_EVENTS.has(event)) return;
  let hooks = [];
  try {
    hooks = db.prepare(`
      SELECT id, url, secret, events FROM webhooks
      WHERE tenant_id = ? AND enabled = 1
    `).all(tenantId);
  } catch {
    return;
  }
  const payload = JSON.stringify({
    event,
    ts: Date.now(),
    tenant: tenantId,
    site,
    device,
    data,
  });
  for (const h of hooks) {
    const set = new Set(String(h.events || '').split(','));
    if (!set.has(event)) continue;
    const sig = sign(h.secret, payload);
    // fire-and-forget; không chặn ingest
    fetch(h.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Plciot-Event': event,
        'X-Plciot-Signature': `sha256=${sig}`,
        'User-Agent': 'plciot-webhook/1',
      },
      body: payload,
      signal: AbortSignal.timeout(Number(process.env.WEBHOOK_TIMEOUT_MS || 5000)),
    }).catch((e) => console.error('webhook', h.id, e.message));
  }
}

/** Tra tenant_id của thiết bị active theo site/device (legacy plc/ không có tenant trên topic). */
export function resolveTenantForSiteDevice(db, site, device, hintTenant) {
  if (hintTenant && hintTenant !== 'default') {
    const row = db.prepare(
      "SELECT tenant_id FROM devices WHERE tenant_id = ? AND site = ? AND device = ? AND status = 'active'",
    ).get(hintTenant, site, device);
    if (row) return row.tenant_id;
  }
  const any = db.prepare(
    "SELECT tenant_id FROM devices WHERE site = ? AND device = ? AND status = 'active' ORDER BY id LIMIT 1",
  ).get(site, device);
  return any?.tenant_id || hintTenant || null;
}

export { ALLOWED_EVENTS, sanitizeId, isValidId };
