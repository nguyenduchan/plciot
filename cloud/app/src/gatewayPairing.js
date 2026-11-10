/**
 * Ghép cặp gateway ↔ admin bằng mã do ADMIN phát (gateway không tự đăng ký → không có cửa vào mở để spam).
 *
 *  1. Admin tạo mã ghép cặp (8 ký tự, dùng một lần, hết hạn ~15 phút, tối đa MAX_OPEN mã mở / admin).
 *  2. Người lắp đặt nhập mã vào GatewayApp → POST /api/v1/gateway/pair { code, fp, config } (toàn bộ thiết bị + setting + UI).
 *  3. Server gắn bản khai vào đúng mã (trạng thái `received`), admin xem trước ở trang admin.
 *  4. Admin duyệt → server cấp site/device + tem QR (cùng cơ chế hardware_devices) và lưu cấu hình (gateway_configs).
 *
 * Chống spam: mã sai/hết hạn/đã khoá trả CÙNG một lỗi, không ghi DB, không báo admin; giới hạn tốc độ theo IP + toàn cục
 * (ở route); mỗi mã chỉ nhận tối đa MAX_SUBMITS lần gửi; kích thước chặn trước khi phân tích; mã quá hạn tự xoá.
 */
import crypto from 'node:crypto';
import { provisionHardwareDevice } from '@plciot/security';
import { sanitizeConfig, applyGatewayConfig, MAX_CONFIG_BYTES } from './gatewayConfig.js';
import { attachGatewayBundle } from './gatewayEnroll.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const SAFE = /^[a-zA-Z0-9_-]{1,48}$/;
export const MAX_OPEN_PER_ADMIN = Number(process.env.PAIRING_MAX_OPEN || 10);
export const MAX_SUBMITS = Number(process.env.PAIRING_MAX_SUBMITS || 5);
const RETAIN_MS = 24 * 3600 * 1000;

export function migratePairings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_pairings (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      admin_id INTEGER,
      label TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      fp TEXT,
      config TEXT,
      received_at INTEGER,
      site TEXT,
      device TEXT
    );
  `);
}

export function normalizeCode(raw) {
  const c = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(c) ? c : null;
}

const hashCode = (c) => crypto.createHash('sha256').update(`pairing:${c}`).digest('hex');
const fmt = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

/** Mã chưa dùng quá hạn → expired; bản ghi cũ hơn RETAIN_MS bị xoá. */
function purge(db, now = Date.now()) {
  migratePairings(db);
  db.prepare("UPDATE gateway_pairings SET status = 'expired' WHERE status IN ('open','received') AND expires_at < ?").run(now);
  db.prepare('DELETE FROM gateway_pairings WHERE expires_at < ?').run(now - RETAIN_MS);
}

export function createPairing(db, { adminId, label = '', ttlMin = 15 } = {}) {
  const now = Date.now();
  purge(db, now);
  const open = db.prepare("SELECT COUNT(*) AS n FROM gateway_pairings WHERE admin_id IS ? AND status IN ('open','received')").get(adminId ?? null).n;
  if (open >= MAX_OPEN_PER_ADMIN) return { error: 'too_many_pairings', status: 429 };
  const ttl = Math.min(60, Math.max(5, Number(ttlMin) || 15));
  for (let i = 0; i < 5; i++) {
    let code = '';
    for (let k = 0; k < 8; k++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const id = `pr_${crypto.randomBytes(6).toString('hex')}`;
    try {
      db.prepare(`INSERT INTO gateway_pairings (id, code_hash, admin_id, label, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)`).run(id, hashCode(code), adminId ?? null, String(label).trim().slice(0, 80) || null, now, now + ttl * 60_000);
      return { ok: true, id, code: fmt(code), expiresAt: now + ttl * 60_000 };
    } catch { /* trùng hash (cực hiếm) → sinh lại */ }
  }
  return { error: 'pairing_failed', status: 500 };
}

/** Một lỗi chung cho mã sai / hết hạn / đã dùng / đã bị khoá: người ngoài không phân biệt được. */
const INVALID = Object.freeze({ error: 'invalid_pairing', status: 404 });

/**
 * Gateway gửi toàn bộ bản khai kèm mã. Không có mã hợp lệ → trả lỗi chung ngay (không phân tích nội dung, không ghi DB).
 * @param {{ code: string, fp?: string, config: object }} body
 */
export function submitPairing(db, body = {}) {
  const code = normalizeCode(body.code);
  if (!code) return INVALID;
  const now = Date.now();
  purge(db, now);
  const row = db.prepare('SELECT * FROM gateway_pairings WHERE code_hash = ?').get(hashCode(code));
  if (!row || !['open', 'received'].includes(row.status) || row.expires_at < now) return INVALID;
  if (row.attempts >= MAX_SUBMITS) {
    db.prepare("UPDATE gateway_pairings SET status = 'cancelled' WHERE id = ?").run(row.id);
    return INVALID;
  }
  db.prepare('UPDATE gateway_pairings SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  const cfg = body.config;
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(cfg ?? null)); } catch { return { error: 'config_invalid', status: 400 }; }
  if (size > MAX_CONFIG_BYTES) return { error: 'config_too_large', status: 413 };
  const clean = sanitizeConfig(cfg);
  if (clean.error) return { error: clean.error, status: 400 };
  if (!clean.devices.length) return { error: 'config_empty', status: 400 };
  const fp = String(body.fp ?? '').trim().slice(0, 24).replace(/[^A-Za-z0-9-]/g, '');
  db.prepare("UPDATE gateway_pairings SET status = 'received', fp = ?, config = ?, received_at = ? WHERE id = ?")
    .run(fp || null, JSON.stringify(clean.devices), now, row.id);
  return { ok: true, id: row.id, devices: clean.devices.length, fp: fp || null };
}

function summary(r) {
  let devices = 0;
  try { devices = r.config ? JSON.parse(r.config).length : 0; } catch { /* hỏng */ }
  return {
    id: r.id, label: r.label, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at,
    receivedAt: r.received_at, fp: r.fp, devices, site: r.site, device: r.device,
  };
}

export function listPairings(db) {
  purge(db);
  return db.prepare('SELECT * FROM gateway_pairings ORDER BY created_at DESC LIMIT 100').all().map(summary);
}

export function getPairing(db, id) {
  purge(db);
  const r = db.prepare('SELECT * FROM gateway_pairings WHERE id = ?').get(String(id));
  if (!r) return { error: 'not_found', status: 404 };
  return { ...summary(r), config: r.config ? JSON.parse(r.config) : null };
}

export function cancelPairing(db, id) {
  const r = db.prepare("UPDATE gateway_pairings SET status = 'cancelled' WHERE id = ? AND status IN ('open','received')").run(String(id));
  return r.changes ? { ok: true } : { error: 'not_found', status: 404 };
}

/**
 * Admin duyệt bản khai: cấp site/device + tem QR (gateway enroll + user quét dùng cùng QR),
 * lưu cấu hình gateway (UI) để user quét tem là thấy đúng giao diện đã khai.
 */
export function approvePairing(db, { id, site, device, label = '' }) {
  purge(db);
  const row = db.prepare('SELECT * FROM gateway_pairings WHERE id = ?').get(String(id));
  if (!row) return { error: 'not_found', status: 404 };
  if (row.status !== 'received' || !row.config) return { error: 'pairing_not_received', status: 409 };
  const s = String(site || '').trim();
  const d = String(device || '').trim();
  if (!SAFE.test(s) || !SAFE.test(d)) return { error: 'invalid_site_or_device', status: 400 };
  const taken = db.prepare('SELECT claimed_by FROM hardware_devices WHERE site = ? AND device = ?').get(s, d);
  if (taken) return { error: 'site_device_taken', status: 409 };

  const devices = JSON.parse(row.config);
  const uiMeta = {
    configRev: 1,
    pairingId: row.id,
    seed: devices.map((x) => ({ childId: x.id, type: 'dynamic', title: x.name, fields: x.fields.map((f) => f.key) })),
  };
  const hw = provisionHardwareDevice(db, { site: s, device: d, label: String(label || row.label || '').trim(), profile: 'iot-hub', uiMeta });
  if (hw.error) return hw;
  const applied = applyGatewayConfig(db, { site: s, device: d, payload: { devices } });
  if (applied.error) return applied;
  db.prepare("UPDATE gateway_pairings SET status = 'approved', site = ?, device = ? WHERE id = ?").run(s, d, row.id);
  return { pairingId: row.id, ...attachGatewayBundle(db, hw, { rotateMqtt: true, includePassword: false }) };
}
