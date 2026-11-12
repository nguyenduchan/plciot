import { newMqttId, isValidMqttId, DEFAULT_TENANT } from './contract.js';

/**
 * Id MQTT ngẫu nhiên của gateway (devices.mqtt_id): server cấp, lưu DB, ánh xạ tới tenant/site/device (và cấu hình
 * gateway qua site/device). Gateway ghép id này vào topic `gw/<mqttId>/<kind>`; ingest tra ngược id → thiết bị.
 */

/** Thêm cột + chỉ mục duy nhất; thiết bị cũ chưa có id được cấp id ngẫu nhiên. */
export function ensureMqttIdColumn(db) {
  const cols = db.prepare("PRAGMA table_info('devices')").all().map((c) => c.name);
  if (!cols.length) return;   // chưa có bảng devices (DB tối giản trong test)
  if (!cols.includes('mqtt_id')) db.exec('ALTER TABLE devices ADD COLUMN mqtt_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_mqtt_id ON devices(mqtt_id)');
  const missing = db.prepare("SELECT id FROM devices WHERE mqtt_id IS NULL OR mqtt_id = ''").all();
  const set = db.prepare('UPDATE devices SET mqtt_id = ? WHERE id = ?');
  for (const r of missing) set.run(uniqueMqttId(db), r.id);
}

/** Sinh id chưa dùng (va chạm 64 bit gần như không xảy ra, nhưng vẫn kiểm tra). */
export function uniqueMqttId(db) {
  for (let i = 0; i < 8; i++) {
    const id = newMqttId();
    if (!db.prepare('SELECT 1 FROM devices WHERE mqtt_id = ?').get(id)) return id;
  }
  throw new Error('mqtt_id_exhausted');
}

const cache = new Map();   // mqttId → { at, row }
const TTL_MS = 30_000;

export function clearMqttIdCache() { cache.clear(); }

/** Tra thiết bị theo id MQTT (chỉ thiết bị active). Có cache ngắn vì ingest gọi cho mỗi gói tin. */
export function deviceByMqttId(db, mqttId) {
  if (!isValidMqttId(mqttId)) return null;
  const hit = cache.get(mqttId);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.row;
  const row = db.prepare(
    "SELECT id, tenant_id, site, device, mqtt_user, mqtt_id, profile, status FROM devices WHERE mqtt_id = ? AND status = 'active'",
  ).get(mqttId) || null;
  cache.set(mqttId, { at: now, row });
  return row;
}

/** Id MQTT của gateway theo tenant/site/device (null nếu chưa cấp). */
export function mqttIdFor(db, tenant, site, device) {
  try {
    return mqttIdForUnsafe(db, tenant, site, device);
  } catch {
    return null;   // DB chưa có cột/bảng (bản cũ chưa migrate) → coi như chưa cấp id
  }
}

function mqttIdForUnsafe(db, tenant, site, device) {
  const row = db.prepare(
    "SELECT mqtt_id FROM devices WHERE tenant_id = ? AND site = ? AND device = ? AND status = 'active'",
  ).get(tenant || DEFAULT_TENANT, site, device);
  if (row?.mqtt_id) return row.mqtt_id;
  const any = db.prepare(
    "SELECT mqtt_id FROM devices WHERE site = ? AND device = ? AND status = 'active' ORDER BY id LIMIT 1",
  ).get(site, device);
  return any?.mqtt_id || null;
}
