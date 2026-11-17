/**
 * Đăng ký gateway theo TÀI KHOẢN (lõi dùng chung): registerForUser nhận token đăng ký đã được xác thực ở gatewayLogin.js
 * (duyệt qua trình duyệt hoặc mã ghép OTP tạo trên webapp), kiểm chữ ký khoá riêng của gateway, cấp site `u<id>` + tem + MQTT.
 * Bảng gateway_pairings giữ lịch sử đăng ký + hạn mức theo tài khoản (USER_MAX_GATEWAYS).
 * Mã ghép cặp do admin phát (cũ) và các màn hình duyệt tay đã bỏ.
 */
import crypto from 'node:crypto';
import { provisionHardwareDevice, parseHardwareId, deleteHardwareDevice, getHardwareDeviceQr, audit } from '@plciot/security';
import { revokeDevice } from './tenants.js';
import { parsePubkey, verifyProof, pairMessage, ensureKeyColumns } from './gatewayKey.js';
import { sanitizeConfig, applyGatewayConfig, MAX_CONFIG_BYTES } from './gatewayConfig.js';
import { attachGatewayBundle, enrollGateway } from './gatewayEnroll.js';
import { cleanSolution, setGatewaySolution, migrateGatewaySolutions } from './gatewaySolution.js';

const ALPHABET = '0123456789';   // mã ghép / OTP CHỈ gồm chữ số (dễ gõ trên bàn phím số, không nhầm O/0, I/1)
const CODE_RE = /^\d{8}$/;
const SAFE = /^[a-zA-Z0-9_-]{1,48}$/;
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
  // Giải pháp (kiểu giao diện webapp + gateway) admin chọn lúc phát mã: gateway nhận ở kit, user quét QR tự map cùng giải pháp
  if (!cols.has('solution')) db.exec("ALTER TABLE gateway_pairings ADD COLUMN solution TEXT NOT NULL DEFAULT ''");
  // Chủ gateway (đăng ký theo tài khoản / đổi chủ): tạo ngay ở đây — tra cứu đổi chủ chạy TRƯỚC registerForUser nên không được chờ nó thêm cột
  if (!cols.has('user_id')) db.exec('ALTER TABLE gateway_pairings ADD COLUMN user_id INTEGER');
  migrateGatewaySolutions(db);
}

export function normalizeCode(raw) {
  const c = String(raw ?? '').replace(/\s/g, '');   // chỉ bỏ khoảng trắng gõ thừa; ký tự khác số → không hợp lệ
  return CODE_RE.test(c) ? c : null;
}

const migrated = new WeakSet();
/** Dọn mã hết hạn / bản ghi cũ — gọi theo timer, không gọi trên mỗi request. */
export function sweepPairings(db) { purge(db); }

const hashCode = (c) => crypto.createHash('sha256').update(`pairing:${c}`).digest('hex');

/** Mã chưa dùng quá hạn → expired; bản ghi cũ hơn RETAIN_MS bị xoá. */
function purge(db, now = Date.now()) {
  migratePairings(db);
  db.prepare("UPDATE gateway_pairings SET status = 'expired' WHERE status IN ('open','received') AND expires_at < ?").run(now);
  db.prepare('DELETE FROM gateway_pairings WHERE expires_at < ?').run(now - RETAIN_MS);
}

/** Một lỗi chung cho mã sai / hết hạn / đã dùng / đã bị khoá: người ngoài không phân biệt được. */
const INVALID = Object.freeze({ error: 'invalid_pairing', status: 404 });

/**
 * Gateway gửi toàn bộ bản khai kèm mã. Không có mã hợp lệ → trả lỗi chung ngay (không phân tích nội dung, không ghi DB).
 * @param {{ code: string, fp?: string, config: object }} body
 */
export function submitPairing(db, body = {}, opts = {}) {
  const proofMsg = (c) => opts.proof ?? pairMessage(c, body.ts);
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
      || !verifyProof(body.pubkey, proofMsg(code), body.sig, body.ts)) return INVALID;
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
  if (!opts.proofVerified && !verifyProof(body.pubkey, proofMsg(code), body.sig, body.ts)) return { error: 'invalid_proof', status: 401 };
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

export const USER_MAX_GATEWAYS = Number(process.env.USER_MAX_GATEWAYS || 5);

/**
 * Người dùng ĐÃ ĐĂNG NHẬP tự đăng ký gateway (không cần mã admin). Cổng vào là tài khoản (đã qua mật khẩu + TOTP):
 * hạn mức theo tài khoản (USER_MAX_GATEWAYS), site cố định theo tài khoản (`u<id>`), truy vết được người tạo.
 * Tái dùng đường duyệt tự động của submitPairing (khoá công khai + chữ ký + sanitizeConfig + cấp tem/MQTT).
 */
export function registerForUser(db, user, body = {}) {
  if (!user?.id) return { error: 'unauthorized', status: 401 };
  migratePairings(db);
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('gateway_pairings')").all().map((c) => c.name));
  if (!cols.has('user_id')) db.exec('ALTER TABLE gateway_pairings ADD COLUMN user_id INTEGER');
  // Hạn mức tính theo gateway CÒN TỒN TẠI (xoá gateway thì trả lại hạn mức), cộng các lượt đang dở
  const used = db.prepare(`SELECT COUNT(*) AS n FROM gateway_pairings p WHERE p.user_id = ? AND (
      p.status IN ('open','received')
      OR (p.status = 'approved' AND EXISTS (SELECT 1 FROM hardware_devices h WHERE h.site = p.site AND h.device = p.device)))`).get(user.id).n;
  if (used >= USER_MAX_GATEWAYS) return { error: 'too_many_gateways', status: 429 };
  const sol = cleanSolution(body.solution || '');
  if (sol === null) return { error: 'invalid_solution', status: 400 };
  // Chữ ký phủ `register|<userId>|<ts>`: chứng minh giữ khoá riêng và gắn với đúng tài khoản này (không phát lại sang tài khoản khác)
  const pk = parsePubkey(body.pubkey);
  if (!pk) return { error: 'invalid_pubkey', status: 400 };
  const proof = `register|${user.id}|${body.ts}`;
  if (!verifyProof(body.pubkey, proof, body.sig, body.ts)) return { error: 'invalid_proof', status: 401 };
  // Cùng một máy (khoá công khai) đăng ký lại: trả lại kit cũ, không tạo thêm tem (một máy không ăn nhiều hạn mức)
  const same = db.prepare("SELECT * FROM gateway_pairings p WHERE user_id = ? AND pubkey = ? AND status = 'approved' AND EXISTS (SELECT 1 FROM hardware_devices h WHERE h.site = p.site AND h.device = p.device) ORDER BY created_at DESC LIMIT 1").get(user.id, pk.spki);
  if (same) return autoResult(db, same, pk.hw);
  const now = Date.now();
  let code = '';
  for (let k = 0; k < 8; k++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  const id = `pr_${crypto.randomBytes(6).toString('hex')}`;
  const site = `u${user.id}`;
  db.prepare(`INSERT INTO gateway_pairings (id, code_hash, admin_id, label, status, created_at, expires_at, site_pre, device_pre, auto, solution, user_id)
    VALUES (?, ?, NULL, ?, 'open', ?, ?, ?, NULL, 1, ?, ?)`).run(id, hashCode(code), `user:${user.id}`, now, now + 5 * 60_000, site, sol, user.id);
  const r = submitPairing(db, { ...body, code }, { proof, proofVerified: true });   // chữ ký đã kiểm ở trên (mỗi chữ ký chỉ dùng được một lần)
  if (!r.ok || !r.approved) db.prepare("UPDATE gateway_pairings SET status = 'cancelled' WHERE id = ? AND status IN ('open','received')").run(id);
  return r;
}

/**
 * Gateway ĐÃ đăng ký cho tài khoản KHÁC (cùng khoá công khai) mà người đang đăng nhập muốn nhận về → trả dòng pairing hiện hữu, ngược lại null.
 * Chỉ tra cứu (chưa xác minh chữ ký): transferToUser mới kiểm chứng khoá riêng.
 */
export function findForeignPairing(db, user, body = {}) {
  const pk = parsePubkey(body.pubkey);
  if (!user?.id || !pk) return null;
  migratePairings(db);
  return db.prepare("SELECT * FROM gateway_pairings p WHERE pubkey = ? AND status = 'approved' AND user_id IS NOT NULL AND user_id != ? AND EXISTS (SELECT 1 FROM hardware_devices h WHERE h.site = p.site AND h.device = p.device) ORDER BY created_at DESC LIMIT 1").get(pk.spki, user.id) || null;
}

/**
 * Yêu cầu ĐỔI CHỦ: người xin phải giữ đúng khoá riêng của gateway (chữ ký `register|<userId>|<ts>`, dùng một lần) và còn hạn mức.
 * Không tự chuyển ở đây — gatewayTransfer.js giữ yêu cầu chờ chủ cũ duyệt (hoặc hết hạn chờ) rồi mới gọi reassignPairing.
 */
export function checkTransferRequest(db, user, body = {}) {
  const pk = parsePubkey(body.pubkey);
  if (!pk) return { error: 'invalid_pubkey', status: 400 };
  if (!verifyProof(body.pubkey, `register|${user.id}|${body.ts}`, body.sig, body.ts)) return { error: 'invalid_proof', status: 401 };
  if (userGatewayCount(db, user.id) >= USER_MAX_GATEWAYS) return { error: 'too_many_gateways', status: 429 };
  return { ok: true };
}

/** Số gateway đang tính vào hạn mức của tài khoản (gateway còn tồn tại + lượt đăng ký đang dở). */
export function userGatewayCount(db, userId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM gateway_pairings p WHERE p.user_id = ? AND (p.status IN ('open','received')
      OR (p.status = 'approved' AND EXISTS (SELECT 1 FROM hardware_devices h WHERE h.site = p.site AND h.device = p.device)))`).get(userId).n;
}

/** Gán dòng pairing (gateway) sang chủ mới — chỉ gọi khi yêu cầu đổi chủ đã được duyệt / hết hạn chờ. */
export function reassignPairing(db, pairingId, toUserId) {
  db.prepare('UPDATE gateway_pairings SET user_id = ?, label = ? WHERE id = ?').run(toUserId, `user:${toUserId}`, pairingId);
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
  if (row.solution) setGatewaySolution(db, s, d, row.solution);   // gateway + webapp của user quét QR dùng cùng giải pháp
  db.prepare("UPDATE gateway_pairings SET status = 'approved', site = ?, device = ? WHERE id = ?").run(s, d, row.id);
  return { pairingId: row.id, ...attachGatewayBundle(db, hw, { rotateMqtt: true, includePassword: false }) };
}

/**
 * Tem cấp từ ghép cặp mà quá TTL vẫn chưa có user claim → thu hồi (xoá tem, thu hồi MQTT).
 * Tem bỏ quên không để QR + tài khoản MQTT sống mãi. Chỉ đụng tem do ghép cặp tạo (ui_meta.pairingId), chưa ai claim.
 */
// Mặc định 0 = KHÔNG giới hạn thời gian (QR/ID sống đến khi admin xoá/thu hồi). Đặt số ngày > 0 để bật tự thu hồi.
export const TEM_TTL_DAYS = Number(process.env.PAIRING_TEM_TTL_DAYS ?? 0) || 0;
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

/** Gateway của tài khoản (đã duyệt, còn tồn tại): dùng cho "chuyển gateway sang PC mới". */
export function listGatewaysOfUser(db, user) {
  migratePairings(db);
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('gateway_pairings')").all().map((c) => c.name));
  if (!cols.has('user_id')) return { ok: true, gateways: [] };
  const rows = db.prepare(`SELECT p.site, p.device, p.created_at, h.label, h.activated_at FROM gateway_pairings p
    JOIN hardware_devices h ON h.site = p.site AND h.device = p.device
    WHERE p.user_id = ? AND p.status = 'approved' ORDER BY p.created_at DESC`).all(user.id);
  return { ok: true, gateways: rows.map((r) => ({ site: r.site, device: r.device, label: r.label || null, boundAt: r.activated_at || null })) };
}

/**
 * CHUYỂN gateway sang PC mới, GIỮ NGUYÊN tem/QR/id MQTT/lịch sử/thiết bị.
 * Cổng vào: token `gateway_register` (chủ tài khoản vừa qua mật khẩu+TOTP hoặc OTP điện thoại) + chữ ký khoá riêng của PC MỚI
 * phủ `rebind|<site>|<device>|<ts>`. Chỉ chủ đã đăng ký gateway đó mới chuyển được.
 * Hiệu lực: khoá công khai + hw của tem đổi sang PC mới, mật khẩu MQTT xoay → PC cũ bị cắt (không dùng song song được).
 */
export function rebindForUser(db, user, body = {}) {
  if (!user?.id) return { error: 'unauthorized', status: 401 };
  migratePairings(db);
  ensureKeyColumns(db);
  const site = String(body.site || '').trim();
  const device = String(body.device || '').trim();
  const pk = parsePubkey(body.pubkey);
  if (!pk) return { error: 'invalid_pubkey', status: 400 };
  if (!verifyProof(body.pubkey, `rebind|${site}|${device}|${body.ts}`, body.sig, body.ts)) return { error: 'invalid_proof', status: 401 };
  const own = db.prepare(`SELECT p.id FROM gateway_pairings p JOIN hardware_devices h ON h.site = p.site AND h.device = p.device
    WHERE p.user_id = ? AND p.status = 'approved' AND p.site = ? AND p.device = ?`).get(user.id, site, device);
  if (!own) return { error: 'not_found', status: 404 };   // không phân biệt "không có" với "của người khác"
  db.prepare('UPDATE hardware_devices SET activated_hw = ?, activated_at = ?, activations = COALESCE(activations, 0) + 1, gw_pubkey = ? WHERE site = ? AND device = ?')
    .run(pk.hw, Date.now(), pk.spki, site, device);
  db.prepare('UPDATE gateway_pairings SET pubkey = ?, hw = ? WHERE id = ?').run(pk.spki, pk.hw, own.id);
  const q = getHardwareDeviceQr(db, { site, device });
  if (q.error) return { error: 'not_found', status: 404 };
  const kit = enrollGateway(db, { qr: q.qr, hw: pk.hw }, { includePassword: true, trusted: true, rotateMqtt: true });
  if (kit.error) return { ok: false, error: kit.error, status: kit.status || 400 };
  audit(db, 'gateway_rebind', { userId: user.id, detail: `${site}/${device} → ${pk.hw}` });
  return { ok: true, site, device, qr: q.qr, loginUrl: q.loginUrl, kit };
}
