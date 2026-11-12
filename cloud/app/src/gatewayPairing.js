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
import { provisionHardwareDevice, parseHardwareId, deleteHardwareDevice, getHardwareDeviceQr, audit } from '@plciot/security';
import { revokeDevice } from './tenants.js';
import { parsePubkey, verifyProof, pairMessage, ensureKeyColumns } from './gatewayKey.js';
import { sanitizeConfig, applyGatewayConfig, MAX_CONFIG_BYTES } from './gatewayConfig.js';
import { attachGatewayBundle, enrollGateway } from './gatewayEnroll.js';

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
      device TEXT,
      hw TEXT
    );
  `);
  // DB cũ chưa có cột hw (ID máy gateway lúc ghép cặp)
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('gateway_pairings')").all().map((c) => c.name));
  if (!cols.has('hw')) db.exec('ALTER TABLE gateway_pairings ADD COLUMN hw TEXT');
  ensureKeyColumns(db);   // pubkey (khoá công khai gateway) + hardware_devices.gw_pubkey
  // Mã TỰ DUYỆT: admin chọn site (và tuỳ chọn mã tem) lúc phát mã → gateway nhập mã là server cấp tem + MQTT ngay, không cần admin duyệt tay
  if (!cols.has('site_pre')) db.exec('ALTER TABLE gateway_pairings ADD COLUMN site_pre TEXT');
  if (!cols.has('device_pre')) db.exec('ALTER TABLE gateway_pairings ADD COLUMN device_pre TEXT');
  if (!cols.has('auto')) db.exec('ALTER TABLE gateway_pairings ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
}

/** Chỉ đọc (không ghi DB): mã có đang mở không? Dùng để ngân sách lần-thất-bại không chặn mã hợp lệ. */
export function pairingCodeValid(db, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return false;
  try {
    const row = db.prepare('SELECT status, expires_at FROM gateway_pairings WHERE code_hash = ?').get(hashCode(code));
    return Boolean(row) && ['open', 'received'].includes(row.status) && row.expires_at >= Date.now();
  } catch { return false; }   // bảng chưa tạo
}

export function normalizeCode(raw) {
  const c = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(c) ? c : null;
}

const migrated = new WeakSet();
/** Dọn mã hết hạn / bản ghi cũ — gọi theo timer, không gọi trên mỗi request. */
export function sweepPairings(db) { purge(db); }

const hashCode = (c) => crypto.createHash('sha256').update(`pairing:${c}`).digest('hex');
const fmt = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

/** Mã chưa dùng quá hạn → expired; bản ghi cũ hơn RETAIN_MS bị xoá. */
function purge(db, now = Date.now()) {
  migratePairings(db);
  db.prepare("UPDATE gateway_pairings SET status = 'expired' WHERE status IN ('open','received') AND expires_at < ?").run(now);
  db.prepare('DELETE FROM gateway_pairings WHERE expires_at < ?').run(now - RETAIN_MS);
}

/**
 * @param {{ site?: string, device?: string, auto?: boolean }} opts
 *   site (+device) đặt sẵn → mã TỰ DUYỆT: gateway nhập mã là tự được cấp tem + MQTT (mã do admin phát, dùng một lần, ~15 phút, khoá theo máy).
 *   auto:false hoặc không có site → admin xem bản khai rồi duyệt tay như trước.
 */
export function createPairing(db, { adminId, label = '', ttlMin = 15, site = '', device = '', auto } = {}) {
  const now = Date.now();
  purge(db, now);
  const siteP = String(site || '').trim();
  const devP = String(device || '').trim();
  if ((siteP && !SAFE.test(siteP)) || (devP && !SAFE.test(devP))) return { error: 'invalid_site_or_device', status: 400 };
  const isAuto = siteP && auto !== false ? 1 : 0;
  const open = db.prepare("SELECT COUNT(*) AS n FROM gateway_pairings WHERE admin_id IS ? AND status IN ('open','received')").get(adminId ?? null).n;
  if (open >= MAX_OPEN_PER_ADMIN) return { error: 'too_many_pairings', status: 429 };
  const ttl = Math.min(60, Math.max(5, Number(ttlMin) || 15));
  for (let i = 0; i < 5; i++) {
    let code = '';
    for (let k = 0; k < 8; k++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const id = `pr_${crypto.randomBytes(6).toString('hex')}`;
    try {
      db.prepare(`INSERT INTO gateway_pairings (id, code_hash, admin_id, label, status, created_at, expires_at, site_pre, device_pre, auto)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`).run(id, hashCode(code), adminId ?? null, String(label).trim().slice(0, 80) || null, now, now + ttl * 60_000, siteP || null, devP || null, isAuto);
      return { ok: true, id, code: fmt(code), expiresAt: now + ttl * 60_000, auto: Boolean(isAuto), site: siteP || null };
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
  // Không ghi DB dọn dẹp trên đường nóng (mã sai đúng định dạng không gây áp lực ghi): chỉ đảm bảo bảng có, hạn dùng kiểm ngay bên dưới
  if (!migrated.has(db)) { migratePairings(db); migrated.add(db); }
  const row = db.prepare('SELECT * FROM gateway_pairings WHERE code_hash = ?').get(hashCode(code));
  if (!row || !['open', 'received', 'approved'].includes(row.status) || row.expires_at < now) return INVALID;
  if (row.status === 'approved') {
    // Gateway mất mạng giữa chừng, chưa nhận được kết quả: cùng máy (hw) gửi lại thì trả lại kit (tem đã cấp), máy khác không được
    const pkAgain = parsePubkey(body.pubkey);
    if (!row.auto || !pkAgain || row.pubkey !== pkAgain.spki
      || !verifyProof(body.pubkey, pairMessage(code, body.ts), body.sig, body.ts)) return INVALID;
    return autoResult(db, row, pkAgain.hw);
  }
  if (row.attempts >= MAX_SUBMITS) {
    db.prepare("UPDATE gateway_pairings SET status = 'cancelled' WHERE id = ?").run(row.id);
    return INVALID;
  }
  db.prepare('UPDATE gateway_pairings SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  // Gateway gửi KHOÁ CÔNG KHAI + chữ ký chứng minh giữ khoá riêng. hw (ID máy) = băm của khoá, không tự khai.
  // Lần gửi đầu KHOÁ mã vào khoá đó: người khác biết mã cũng không ghi đè được bản khai.
  const pk = parsePubkey(body.pubkey);
  if (!pk) return { error: 'invalid_pubkey', status: 400 };
  if (!verifyProof(body.pubkey, pairMessage(code, body.ts), body.sig, body.ts)) return { error: 'invalid_proof', status: 401 };
  const hw = pk.hw;
  if (row.hw && row.hw !== hw) return INVALID;

  const cfg = body.config;
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(cfg ?? null)); } catch { return { error: 'config_invalid', status: 400 }; }
  if (size > MAX_CONFIG_BYTES) return { error: 'config_too_large', status: 413 };
  const clean = sanitizeConfig(cfg);
  if (clean.error) return { error: clean.error, status: 400 };
  // Bản khai rỗng hợp lệ: gateway chưa có thiết bị vẫn được cấp QR, setting đồng bộ lên sau qua <base>/config.
  const fp = String(body.fp ?? '').trim().slice(0, 24).replace(/[^A-Za-z0-9-]/g, '');
  db.prepare("UPDATE gateway_pairings SET status = 'received', fp = ?, config = ?, received_at = ?, hw = ?, pubkey = ? WHERE id = ?")
    .run(fp || null, JSON.stringify(clean.devices), now, hw, pk.spki, row.id);
  const base = { ok: true, id: row.id, devices: clean.devices.length, fp: fp || null };
  if (row.auto && row.site_pre) {
    const auto = autoApprove(db, { ...row, hw, pubkey: pk.spki }, hw);
    if (auto.approved) return { ...base, ...auto };
    return { ...base, approved: false, autoError: auto.error };   // không tự duyệt được: để admin duyệt tay
  }
  return base;
}

/** Chọn mã tem còn trống trong site: gw01, gw02… */
function freeDevice(db, site, wanted) {
  const taken = (d) => db.prepare('SELECT 1 FROM hardware_devices WHERE site = ? AND device = ?').get(site, d);
  if (wanted) return taken(wanted) ? null : wanted;
  for (let i = 1; i < 100; i++) { const d = `gw${String(i).padStart(2, '0')}`; if (!taken(d)) return d; }
  return null;
}

/** Tự duyệt ngay khi gateway gửi bản khai: cấp tem + MQTT, trả kit để gateway tự enroll (không cần dán QR). */
function autoApprove(db, row, hw) {
  const device = freeDevice(db, row.site_pre, row.device_pre);
  if (!device) return { approved: false, error: 'site_device_taken' };
  const ap = approvePairing(db, { id: row.id, site: row.site_pre, device, label: row.label || '' });
  if (ap.error) return { approved: false, error: ap.error };
  audit(db, 'pairing_auto_approve', { detail: `${row.id} → ${row.site_pre}/${device}` });
  return autoResult(db, { ...row, site: row.site_pre, device }, hw, ap);
}

function autoResult(db, row, hw, ap = null) {
  const cur = ap ? null : db.prepare('SELECT site, device FROM gateway_pairings WHERE id = ?').get(row.id);
  const site = ap ? row.site : cur?.site; const device = ap ? row.device : cur?.device;
  let qr = ap?.qr; let loginUrl = ap?.loginUrl;
  if (!qr) {
    const q = getHardwareDeviceQr(db, { site, device });
    if (q.error) return { error: 'invalid_pairing', status: 404 };
    qr = q.qr; loginUrl = q.loginUrl;
  }
  const kit = enrollGateway(db, { qr, hw }, { includePassword: true, trusted: true });   // vừa chứng minh khoá riêng ở bước ghép cặp
  if (kit.error) return { ok: false, approved: false, error: kit.error, status: kit.status || 400 };
  return { ok: true, id: row.id, approved: true, site, device, qr, loginUrl, kit };
}

function summary(r) {
  let devices = 0;
  try { devices = r.config ? JSON.parse(r.config).length : 0; } catch { /* hỏng */ }
  return {
    id: r.id, label: r.label, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at,
    receivedAt: r.received_at, fp: r.fp, hw: r.hw || null, devices, site: r.site || r.site_pre || null, device: r.device, auto: Boolean(r.auto),
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
  ensureKeyColumns(db);
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
  // Gắn sẵn tem với máy đã ghép cặp: cầm ảnh QR mà không có hw của máy này thì không enroll / lấy mật khẩu MQTT được
  if (row.hw) {
    db.prepare('UPDATE hardware_devices SET activated_hw = ?, activated_at = ?, activations = 1, gw_pubkey = ? WHERE site = ? AND device = ?')
      .run(row.hw, Date.now(), row.pubkey || null, s, d);
  }
  const applied = applyGatewayConfig(db, { site: s, device: d, payload: { devices } });
  if (applied.error) return applied;
  db.prepare("UPDATE gateway_pairings SET status = 'approved', site = ?, device = ? WHERE id = ?").run(s, d, row.id);
  return { pairingId: row.id, ...attachGatewayBundle(db, hw, { rotateMqtt: true, includePassword: false }) };
}

/**
 * Tem cấp từ ghép cặp mà quá TTL vẫn chưa có user claim → thu hồi (xoá tem, thu hồi MQTT).
 * Tem bỏ quên không để QR + tài khoản MQTT sống mãi. Chỉ đụng tem do ghép cặp tạo (ui_meta.pairingId), chưa ai claim.
 */
export const TEM_TTL_DAYS = Number(process.env.PAIRING_TEM_TTL_DAYS || 30);
export function expireUnusedTems(db, { ttlDays = TEM_TTL_DAYS, now = Date.now() } = {}) {
  if (!(ttlDays > 0)) return { expired: 0 };
  const cutoff = now - ttlDays * 86400_000;
  const rows = db.prepare(`SELECT site, device FROM hardware_devices
    WHERE claimed_by IS NULL AND created_at < ? AND ui_meta LIKE '%"pairingId"%'`).all(cutoff);
  let expired = 0;
  for (const r of rows) {
    if (deleteHardwareDevice(db, { site: r.site, device: r.device }).error) continue;
    try { revokeDevice(db, 'default', r.site, r.device); } catch { /* broker có thể offline: thu hồi sau */ }
    audit(db, 'tem_expired', { detail: `${r.site}/${r.device} quá ${ttlDays} ngày chưa có user` });
    expired += 1;
  }
  return { expired };
}

/** hw đầy đủ chỉ admin thấy; summary rút gọn để đối chiếu. */
