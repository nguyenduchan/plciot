/**
 * CÀI ĐẶT GATEWAY TỪ XA bằng GatewayAdmin (app desktop của chủ hệ thống) — relay qua MQTT, dùng lại ĐÚNG API LAN của gateway.
 *
 *   GatewayAdmin ──HTTPS (ký bằng khoá máy)──▶ server ──gw/<mqttId>/rpc (server ký rpc1|…)──▶ gateway
 *                ◀──────────── {status, body} ◀── ghép các phần gw/<mqttId>/rpcr ◀──────────────┘
 *
 * Xác thực (không có màn hình đăng nhập — chỉ một người dùng app này):
 *   - Máy GatewayAdmin tự sinh khoá ECDSA P-256; khoá công khai được ĐĂNG KÝ QUA SSH trên VPS
 *     (`node scripts/remote-admin-key.js add <tên> <spki-base64url>`) → chỉ ai có SSH mới thêm được máy.
 *   - Mỗi yêu cầu ký: radm1|METHOD|/đường-dẫn|ts|nonce|sha256(thân) — header X-Radm-Key/Ts/Nonce/Sig; lệch giờ > 60 s
 *     hoặc nonce đã dùng → từ chối. Không có cookie/token để lộ.
 * Đồng ý của người dùng: chủ gateway BẬT "Cho phép hỗ trợ từ xa" trên webapp (mặc định TẮT) — server kiểm trước mỗi yêu cầu.
 * Giới hạn: chỉ các route trong ALLOWED (không có chạy/dừng gateway, đăng ký cloud, đổi mạng/Wi-Fi, OTA, PC quản trị, lease).
 * Nhật ký: mọi yêu cầu GHI (và đọc cấu hình) vào audit_log (`radmin_rpc`).
 *
 * Gói tin:
 *   rpc  (server → gateway): {"rid","ts","m","p","b":<base64 gzip thân | "">,"adm":<tên máy>,"sig"} — ký `rpc1|<mqttId>|<json>`
 *   rpcr (gateway → server): {"rid","i","n","st","z":<một phần base64 của gzip(thân trả lời)>} — chia phần ≤ 3000 ký tự
 *                            vì đường ingest chặn gói > 4 KB.
 */
import { gatewayName } from './gatewayNames.js';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { audit, rateLimit, clientIp } from '@plciot/security';
import { publishSigned } from './controlPublisher.js';
import { signRpc } from './cmdSign.js';

const SKEW_MS = 60_000;
const NONCE_TTL_MS = 10 * 60_000;
const RPC_TIMEOUT_MS = Number(process.env.RADMIN_RPC_TIMEOUT_MS || 25_000);
const MAX_REQ_B64 = 12_000;   // thân yêu cầu sau gzip+base64 (broker cho tối đa 16 KB một gói)
const MAX_PARTS = 64;         // trả lời tối đa ~190 KB base64

/** Route gateway (LAN API) được phép gọi từ xa: [method, path]. Đổi mạng / Wi-Fi / chạy-dừng / OTA… để sau (cần tự quay lại khi mất kết nối). */
export const ALLOWED = [
  ['GET', '/api/state'], ['GET', '/api/config'], ['PUT', '/api/config'], ['GET', '/api/config-message'],
  ['POST', '/api/write'], ['POST', '/api/device'],
  // Chương trình logic: chỉ ĐỌC qua đây. Đổi = GatewayAdmin gửi đề xuất (text) → chủ trạm duyệt trên webapp → gatewayLogic.js mới gửi PUT
  // (kèm mã duyệt "appr" trong phần được ký — board không nhận PUT /api/offline từ xa nếu thiếu). Thử mất mạng (đóng/ngắt DO thật): chỉ tại chỗ.
  ['GET', '/api/offline'],
  ['GET', '/api/network'], ['GET', '/api/wifi'],
  ['GET', '/api/events'], ['GET', '/api/ota'],   // xem nhật ký + trạng thái cập nhật; nạp firmware từ xa KHÔNG có ở đây (chủ trạm duyệt trên webapp, board tự tải)
];
export const isAllowed = (m, p) => ALLOWED.some(([am, ap]) => am === m && ap === p);

export function initRemoteAdminTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_admin_keys (
      key_id TEXT PRIMARY KEY,
      spki TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER,
      last_ip TEXT,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS remote_admin_consent (
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (site, device)
    );
  `);
}

export const keyIdOf = (spki) => crypto.createHash('sha256').update(Buffer.from(spki, 'base64url')).digest('hex').slice(0, 16);

export function addAdminKey(db, label, spki) {
  crypto.createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' });   // khoá hỏng → ném lỗi
  const id = keyIdOf(spki);
  db.prepare(`INSERT INTO remote_admin_keys (key_id, spki, label, created_at, disabled) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(key_id) DO UPDATE SET label = excluded.label, disabled = 0`).run(id, spki, String(label).slice(0, 60), Date.now());
  return id;
}

export const radmMessage = (method, path, ts, nonce, bodyHashHex) => `radm1|${method}|${path}|${ts}|${nonce}|${bodyHashHex}`;

// ------------------------------------------------------------------ chờ trả lời từ gateway
const pending = new Map();   // rid → { mqttId, parts[], n, resolve, timer }

/** Gọi từ mqttIngest khi có gói gw/<mqttId>/rpcr. Gateway chỉ ghi được rpcr của CHÍNH nó (ACL) → kiểm mqttId khớp yêu cầu. */
export function onRpcReply(mqttId, buf) {
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
  const p = pending.get(String(m?.rid || ''));
  if (!p || p.mqttId !== mqttId) return;
  const n = Number(m.n), i = Number(m.i);
  if (m.enc === 'b64') p.enc = 'b64';   // board Waveshare: base64 thường, không gzip
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS || !Number.isInteger(i) || i < 0 || i >= n || typeof m.z !== 'string') return;
  p.n = n; p.st = Number(m.st) || p.st; p.parts[i] = m.z;
  if (p.parts.filter((x) => typeof x === 'string').length < n) return;
  clearTimeout(p.timer); pending.delete(m.rid);
  try {
    const raw = Buffer.from(p.parts.join(''), 'base64');
    const body = (p.enc === 'b64' ? raw : zlib.gunzipSync(raw)).toString('utf8');
    p.resolve({ status: p.st || 200, body });
  } catch { p.resolve({ status: 502, body: JSON.stringify({ Ok: false, Err: 'bad_reply' }) }); }
}

/**
 * Gọi một route API LAN của gateway qua MQTT rpc. mcu = board Waveshare (không có gzip: thân base64 thường, "enc":"b64").
 * appr = mã duyệt của chủ trạm (bắt buộc với PUT /api/offline trên board) — nằm trong phần server ký.
 */
export async function callGateway(mqttId, { method, path, body, label, mcu = false, appr = '' }) {
  const rid = crypto.randomBytes(12).toString('hex');
  const b = body ? (mcu ? Buffer.from(body, 'utf8') : zlib.gzipSync(Buffer.from(body, 'utf8'))).toString('base64') : '';
  if (b.length > MAX_REQ_B64) return { status: 413, body: JSON.stringify({ Ok: false, Err: 'too_large' }) };
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(rid); resolve({ status: 504, body: JSON.stringify({ Ok: false, Err: 'gateway_timeout' }) }); }, RPC_TIMEOUT_MS);
    pending.set(rid, { mqttId, parts: [], n: 0, st: 0, resolve, timer });
  });
  try {
    const msg = { rid, ts: Date.now(), m: method, p: path, b, adm: label };
    if (mcu) msg.enc = 'b64';
    if (appr) msg.appr = appr;
    await publishSigned(mqttId, 'rpc', signRpc(mqttId, msg));
  } catch (e) {
    const p = pending.get(rid); if (p) { clearTimeout(p.timer); pending.delete(rid); }
    return { status: 503, body: JSON.stringify({ Ok: false, Err: 'mqtt_unavailable' }) };
  }
  return result;
}

// ------------------------------------------------------------------ route
export function mountRemoteAdmin(app, { db, requireAuth }) {
  initRemoteAdminTables(db);
  const seen = new Map();   // nonce → hết hạn
  const limit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_RADMIN || 600), keyFn: (req) => `${clientIp(req)}:radmin` });
  const bad = (res, status, error) => res.status(status).json({ error });

  /** Chữ ký của máy GatewayAdmin đã đăng ký (không phải phiên đăng nhập). */
  function requireAdminKey(req, res, next) {
    const keyId = String(req.get('x-radm-key') || ''), ts = Number(req.get('x-radm-ts')), nonce = String(req.get('x-radm-nonce') || '');
    const sig = String(req.get('x-radm-sig') || '');
    if (!/^[0-9a-f]{16}$/.test(keyId) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !sig) return bad(res, 401, 'radmin_unsigned');
    const now = Date.now();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > SKEW_MS) return bad(res, 401, 'radmin_clock');
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (seen.has(nonce)) return bad(res, 401, 'radmin_replay');
    const row = db.prepare('SELECT * FROM remote_admin_keys WHERE key_id = ? AND disabled = 0').get(keyId);
    if (!row) return bad(res, 401, 'radmin_unknown_key');
    const hash = crypto.createHash('sha256').update(req.rawBody || Buffer.alloc(0)).digest('hex');
    let ok = false;
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(row.spki, 'base64url'), format: 'der', type: 'spki' });
      ok = crypto.verify('sha256', Buffer.from(radmMessage(req.method, req.path, ts, nonce, hash), 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    } catch { ok = false; }
    if (!ok) return bad(res, 401, 'radmin_bad_sig');
    seen.set(nonce, now + NONCE_TTL_MS);
    db.prepare('UPDATE remote_admin_keys SET last_seen = ?, last_ip = ? WHERE key_id = ?').run(now, clientIp(req), keyId);
    req.radmin = { keyId, label: row.label };
    next();
  }

  const consentOf = (site, device) => Boolean(db.prepare('SELECT enabled FROM remote_admin_consent WHERE site = ? AND device = ?').get(site, device)?.enabled);

  /** Danh sách gateway: chỉ gateway có MQTT id (đã đăng ký); Allowed = chủ đã cho phép. */
  app.get('/api/v1/radmin/gateways', limit, requireAdminKey, (req, res) => {
    const rows = db.prepare(`
      SELECT d.site, d.device, d.mqtt_id AS mqttId, g.version, g.last_seen AS lastSeen,
        COALESCE(c.enabled, 0) AS allowed,
        (SELECT u.username FROM users u WHERE (u.notify_site = d.site AND u.notify_device = d.device)
           OR EXISTS (SELECT 1 FROM user_devices ud WHERE ud.user_id = u.id AND ud.site = d.site AND ud.gateway_device = d.device) LIMIT 1) AS owner
      FROM devices d
      LEFT JOIN gateway_clients g ON g.site = d.site AND g.device = d.device
      LEFT JOIN remote_admin_consent c ON c.site = d.site AND c.device = d.device
      WHERE d.mqtt_id IS NOT NULL AND d.mqtt_id != ''
      ORDER BY g.last_seen IS NULL, g.last_seen DESC`).all();
    res.json({ gateways: rows.map((r) => ({ ...r, allowed: Boolean(r.allowed), kind: String(r.version || '').startsWith('mcu') ? 'mcu' : 'pc' })) });
  });

  /** Gọi một route API LAN của gateway qua MQTT. Thân: {site, device, method, path, body}. */
  app.post('/api/v1/radmin/rpc', limit, requireAdminKey, async (req, res) => {
    const { site, device } = req.body || {};
    const method = String(req.body?.method || '').toUpperCase(), path = String(req.body?.path || '');
    const body = req.body?.body == null ? '' : String(req.body.body);
    if (!isAllowed(method, path)) return bad(res, 403, 'radmin_route_blocked');
    const dev = db.prepare('SELECT site, device, mqtt_id FROM devices WHERE site = ? AND device = ?').get(String(site || ''), String(device || ''));
    if (!dev?.mqtt_id) return bad(res, 404, 'gateway_not_found');
    if (!consentOf(dev.site, dev.device)) return bad(res, 403, 'radmin_not_allowed');
    const cl = db.prepare('SELECT version FROM gateway_clients WHERE site = ? AND device = ?').get(dev.site, dev.device);
    const r = await callGateway(dev.mqtt_id, { method, path, body, label: req.radmin.label, mcu: String(cl?.version || '').startsWith('mcu') });
    if (method !== 'GET' || path === '/api/config') {
      audit(db, 'radmin_rpc', { ip: clientIp(req), detail: `${req.radmin.label} ${method} ${path} ${dev.site}/${dev.device} → ${r.status}`.slice(0, 500) });
    }
    res.json({ status: r.status, body: r.body });
  });

  // ---- người dùng (chủ gateway) bật/tắt "Cho phép hỗ trợ từ xa" — mặc định TẮT
  const owns = (user, site, device) => (user.notify_site === site && user.notify_device === device)
    || Boolean(db.prepare('SELECT 1 FROM user_devices WHERE user_id = ? AND site = ? AND gateway_device = ? LIMIT 1').get(user.id, site, device));

  app.get('/api/v1/remote-support', requireAuth, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const mine = db.prepare('SELECT DISTINCT site, gateway_device AS device FROM user_devices WHERE user_id = ?').all(u.id);
    if (u.notify_site && u.notify_device && !mine.some((g) => g.site === u.notify_site && g.device === u.notify_device)) mine.unshift({ site: u.notify_site, device: u.notify_device });
    res.json({ gateways: mine.map((g) => ({ ...g, name: gatewayName(db, g.site, g.device), allowed: consentOf(g.site, g.device) })) });
  });

  app.put('/api/v1/remote-support', requireAuth, (req, res) => {
    const site = String(req.body?.site || ''), device = String(req.body?.device || ''), on = Boolean(req.body?.allowed);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!u || !owns(u, site, device)) return bad(res, 403, 'not_owner');
    db.prepare(`INSERT INTO remote_admin_consent (site, device, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(site, device) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(site, device, on ? 1 : 0, u.id, Date.now());
    audit(db, on ? 'radmin_consent_on' : 'radmin_consent_off', { userId: u.id, ip: clientIp(req), detail: `${site}/${device}` });
    res.json({ ok: true, allowed: on });
  });

  return { requireAdminKey, limit, consentOf, owns };
}
