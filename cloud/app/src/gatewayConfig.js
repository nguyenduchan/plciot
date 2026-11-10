/**
 * Gateway khai báo cấu trúc thiết bị (Dynamic Discovery).
 *
 * Gateway (Node-RED / GatewayApp) publish RETAIN lên `<base>/config` mỗi khi thêm/bớt thiết bị con
 * (và khi khởi động lại):
 *   { "gw": "GW01", "devices": [
 *       { "id": "bien_ap_01", "name": "Biến áp", "fields": [
 *           { "key": "temp", "lbl": "Nhiệt độ", "unit": "°C", "widget": "gauge" },
 *           { "key": "run",  "lbl": "Chạy", "widget": "switch", "writable": true } ] } ] }
 * Telemetry vẫn là `<base>/telemetry`: { "schema":2, "ts":…, "d" | "data": { id: { key: value } } }.
 *
 * Server: kiểm tra + chuẩn hoá → upsert bảng gateway_configs → đồng bộ user_devices (thêm/bớt thiết bị
 * con kiểu 'dynamic') → webapp nhận config qua MQTT (retain) hoặc tải lại /api/v1/ui/dashboard là tự vẽ lại.
 * Widget chỉ là GỢI Ý hiển thị; quyền ghi lệnh vẫn do server quyết (limits/critical của tem, step-up).
 */
import crypto from 'node:crypto';

const ID = /^[a-zA-Z0-9_-]{1,48}$/;
const KEY = /^[A-Za-z0-9_]{1,32}$/;
export const MAX_CONFIG_BYTES = Number(process.env.POLICY_MAX_CONFIG_BYTES || 16384);
const MAX_DEVICES = 64;
const MAX_FIELDS = 32;

/** Tên widget phía gateway → kind của UI contract. Lạ → kpi. */
export const GW_WIDGET_TO_KIND = Object.freeze({
  gauge: 'gauge',
  tank: 'tank',
  chart: 'line',
  line: 'line',
  bar: 'bar',
  sparkline: 'sparkline',
  ring: 'ring',
  kpi: 'kpi',
  value: 'kpi',
  text: 'text',
  chip: 'chip',
  led_status: 'status',
  led: 'status',
  status: 'status',
  switch: 'toggle',
  toggle: 'toggle',
  slider: 'slider',
});

/** Màu nhấn + biểu tượng thẻ: danh sách trắng, lạ → bỏ (webapp dùng mặc định). */
export const DEVICE_COLORS = Object.freeze(['blue', 'green', 'yellow', 'red', 'purple', 'orange']);
const ICON = /^[a-z0-9_]{1,16}$/;

const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : undefined);

/** @returns {{ ok: true, devices: Array } | { error: string }} */
export function sanitizeConfig(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'config_not_object' };
  if (!Array.isArray(payload.devices)) return { error: 'config_devices_missing' };
  if (payload.devices.length > MAX_DEVICES) return { error: 'config_too_many_devices' };

  const seen = new Set();
  const devices = [];
  for (const d of payload.devices) {
    const id = clip(d?.id, 48);
    if (!ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const fields = [];
    const keys = new Set();
    for (const f of (Array.isArray(d.fields) ? d.fields : []).slice(0, MAX_FIELDS)) {
      const key = clip(f?.key, 32);
      if (!KEY.test(key) || keys.has(key)) continue;
      keys.add(key);
      const widget = clip(f.widget, 24).toLowerCase();
      const out = {
        key,
        lbl: clip(f.lbl ?? f.label ?? key, 60) || key,
        widget: GW_WIDGET_TO_KIND[widget] ? widget : 'kpi',
      };
      if (f.unit) out.unit = clip(f.unit, 16);
      if (f.writable === true) out.writable = true;
      if (f.on) out.on = clip(f.on, 24);
      if (f.off) out.off = clip(f.off, 24);
      const low = num(f.low); const high = num(f.high);
      if (low !== undefined) out.low = low;
      if (high !== undefined) out.high = high;
      const min = num(f.min); const max = num(f.max); const step = num(f.step);
      if (min !== undefined) out.min = min;
      if (max !== undefined) out.max = max;
      if (step !== undefined && step > 0) out.step = step;
      fields.push(out);
    }
    const dev = { id, name: clip(d.name, 120) || id, fields };
    const icon = clip(d.icon, 16).toLowerCase();
    if (ICON.test(icon)) dev.icon = icon;
    const color = clip(d.color, 12).toLowerCase();
    if (DEVICE_COLORS.includes(color)) dev.color = color;
    devices.push(dev);
  }
  return { ok: true, devices };
}

export function migrateGatewayConfigs(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_configs (
      tenant_id TEXT NOT NULL,
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1,
      hash TEXT NOT NULL,
      devices TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, site, device)
    );
  `);
}

export function getGatewayConfig(db, { tenantId = 'default', site, device }) {
  migrateGatewayConfigs(db);
  const row = db.prepare('SELECT * FROM gateway_configs WHERE tenant_id = ? AND site = ? AND device = ?')
    .get(tenantId, site, device);
  if (!row) return null;
  return { site, device, rev: row.rev, updatedAt: row.updated_at, devices: JSON.parse(row.devices) };
}

/** Thiết bị con đã khai báo (nhà máy + gateway): fields, icon, color — dùng dựng widget + kiểu thẻ động. */
export function deviceOf(db, { site, gateway, childId }) {
  migrateGatewayConfigs(db);
  const rows = db.prepare('SELECT devices FROM gateway_configs WHERE site = ? AND device = ?').all(site, gateway);
  for (const r of rows) {
    const d = JSON.parse(r.devices).find((x) => x.id === childId);
    if (d) return d;
  }
  return null;
}

/** Các field đã khai báo của một thiết bị con. */
export function fieldsOf(db, args) {
  return deviceOf(db, args)?.fields || [];
}

/**
 * Upsert cấu trúc mới nhất + đồng bộ danh sách thiết bị con của người dùng thuộc gateway này.
 * Cấu hình không đổi (hash trùng) → không làm gì (gateway gửi lại khi reconnect cũng được).
 */
export function applyGatewayConfig(db, { tenantId = 'default', site, device, payload }) {
  const clean = sanitizeConfig(payload);
  if (clean.error) return clean;
  migrateGatewayConfigs(db);

  const json = JSON.stringify(clean.devices);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  const now = Date.now();
  const prev = db.prepare('SELECT rev, hash FROM gateway_configs WHERE tenant_id = ? AND site = ? AND device = ?')
    .get(tenantId, site, device);
  if (prev && prev.hash === hash) return { ok: true, changed: false, rev: prev.rev, devices: clean.devices.length };

  const rev = (prev?.rev || 0) + 1;
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO gateway_configs (tenant_id, site, device, rev, hash, devices, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, site, device) DO UPDATE
        SET rev = excluded.rev, hash = excluded.hash, devices = excluded.devices, updated_at = excluded.updated_at
    `).run(tenantId, site, device, rev, hash, json, now);
    return syncUserDevices(db, { site, device, devices: clean.devices });
  });
  const sync = tx();
  return { ok: true, changed: true, rev, devices: clean.devices.length, ...sync };
}

/**
 * Chủ gateway (users.notify_site/notify_device) nhận thiết bị con khai báo: thêm mới / đổi tên,
 * và gỡ các thiết bị 'dynamic' không còn trong config. Thiết bị gắn bằng QR (type khác) giữ nguyên.
 */
function syncUserDevices(db, { site, device, devices }) {
  const users = db.prepare('SELECT id FROM users WHERE notify_site = ? AND notify_device = ?').all(site, device);
  let added = 0; let removed = 0;
  const ids = devices.map((d) => d.id);
  for (const u of users) {
    for (const d of devices) {
      const ex = db.prepare('SELECT id, type FROM user_devices WHERE user_id = ? AND site = ? AND child_id = ?')
        .get(u.id, site, d.id);
      if (ex) {
        if (ex.type === 'dynamic') {
          db.prepare('UPDATE user_devices SET title = ?, gateway_device = ? WHERE id = ?').run(d.name, device, ex.id);
        }
        continue;
      }
      db.prepare(`
        INSERT INTO user_devices (id, user_id, site, gateway_device, child_id, type, title, binds, created_at)
        VALUES (?, ?, ?, ?, ?, 'dynamic', ?, NULL, ?)
      `).run(`ud_${crypto.randomBytes(6).toString('hex')}`, u.id, site, device, d.id, d.name, Date.now());
      added += 1;
    }
    const stale = db.prepare(`SELECT id, child_id FROM user_devices
      WHERE user_id = ? AND site = ? AND gateway_device = ? AND type = 'dynamic'`).all(u.id, site, device)
      .filter((r) => !ids.includes(r.child_id));
    for (const r of stale) {
      db.prepare('DELETE FROM user_devices WHERE id = ?').run(r.id);
      removed += 1;
    }
  }
  return { users: users.length, added, removed };
}
