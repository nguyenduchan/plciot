/**
 * Tên hiển thị của gateway — người dùng đặt, CHỈ để hiển thị.
 * ID gateway (site/device) do hệ thống cấp lúc đăng ký (suy từ mã phần cứng, xem gatewayPairing.js gatewayIdFor) và không đổi:
 * MQTT, logic, OTA, lịch sử đều theo ID; đổi tên không đụng tới chúng.
 */
import { audit, clientIp } from '@plciot/security';
import { gatewaysOfUser } from './mqttIds.js';

const MAX = 40;

export function migrateGatewayNames(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS gateway_names (
    site TEXT NOT NULL,
    device TEXT NOT NULL,
    name TEXT NOT NULL,
    updated_by INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (site, device)
  )`);
}

/** Tên đã đặt, hoặc '' (webapp tự hiện ID). */
export function gatewayName(db, site, device) {
  try { return db.prepare('SELECT name FROM gateway_names WHERE site = ? AND device = ?').get(site, device)?.name || ''; } catch { return ''; }
}

/** Bỏ ký tự điều khiển / khoảng trắng thừa, giới hạn độ dài. '' = xoá tên (quay về hiện ID). */
export function cleanName(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX);
}

export function setGatewayName(db, { site, device, name, userId = null }) {
  migrateGatewayNames(db);
  const n = cleanName(name);
  if (!n) { db.prepare('DELETE FROM gateway_names WHERE site = ? AND device = ?').run(site, device); return ''; }
  db.prepare(`INSERT INTO gateway_names (site, device, name, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site, device) DO UPDATE SET name = excluded.name, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(site, device, n, userId, Date.now());
  return n;
}

/** Tên mặc định lúc đăng ký (chưa đặt): "Gateway N" theo số gateway của tài khoản. */
export function defaultGatewayName(db, site, device, n) {
  if (gatewayName(db, site, device)) return;
  setGatewayName(db, { site, device, name: `Gateway ${n}` });
}

export function mountGatewayNames(app, { db, requireAuth }) {
  migrateGatewayNames(db);
  // Chủ gateway đổi tên hiển thị. Chỉ gateway có trong tài khoản này.
  app.put('/api/gateways/:site/:device/name', requireAuth, (req, res) => {
    const site = String(req.params.site); const device = String(req.params.device);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!u || !gatewaysOfUser(db, u).some((g) => g.site === site && g.device === device)) return res.status(403).json({ error: 'not_owner' });
    const name = setGatewayName(db, { site, device, name: req.body?.name, userId: u.id });
    audit(db, 'gateway_renamed', { userId: u.id, ip: clientIp(req), detail: `${site}/${device} → ${name || '(ID)'}` });
    res.json({ ok: true, site, device, name });
  });
}
