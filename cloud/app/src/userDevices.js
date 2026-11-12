/**
 * Thiết bị con trên dashboard + API /api/devices và /api/v1/ui/*.
 * Thêm bằng QR → tự lấy profile từ hardware_devices (không hỏi type).
 */
import crypto from 'node:crypto';
import {
  claimHardwareDevice, decodeClaimQr, verifyClaimSignature, hashClaimSecret, audit,
} from '@plciot/security';
import {
  uiSchemaPublic, listDeviceTypes, getDeviceType, resolveDeviceTypeId,
  resolveDashboard, deviceToUiNode, UI_CONTRACT_VERSION,
} from './uiContract.js';
import { specFor, parseUserKeys } from './childControl.js';
import { clientIp } from '@plciot/security';
import { mqttIdFor, gatewaysOfUser } from './mqttIds.js';
import { rebuildAclFromUsers, reloadMosquitto } from './mqttProvision.js';
import { planWidgetLimit, effectivePlan } from './entitlements.js';

/** Thông tin gói để dựng dashboard (giới hạn widget). */
const planOf = (u) => ({ widgetLimit: planWidgetLimit(u), planId: effectivePlan(u).id, planLabel: effectivePlan(u).label });
import { notifyGateway } from './gatewayNotify.js';
import { DEFAULT_TENANT } from './contract.js';
import { rateLimit } from '@plciot/security';
import { releaseSiteIfEmpty } from './sites.js';
import { deviceOf, migrateGatewayConfigs } from './gatewayConfig.js';

const SAFE = /^[a-zA-Z0-9_-]{1,48}$/;

export function migrateUserDevices(db) {
  migrateGatewayConfigs(db);
  // Bảng cùng tên từ schema cũ (user_id/site/device/role…) không có cột id: CREATE IF NOT EXISTS sẽ bỏ qua
  // và mọi truy vấn lỗi "no such column: id". Đổi tên (giữ dữ liệu) để tạo bảng đúng schema.
  const old = db.prepare("PRAGMA table_info('user_devices')").all();
  if (old.length && !old.some((c) => c.name === 'id')) {
    db.exec('ALTER TABLE user_devices RENAME TO user_devices_legacy_old');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      site TEXT NOT NULL,
      gateway_device TEXT NOT NULL,
      child_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      binds TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, site, child_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
  `);
  const cols = db.prepare("PRAGMA table_info('user_devices')").all().map((c) => c.name);
  if (!cols.includes('critical_keys')) db.exec('ALTER TABLE user_devices ADD COLUMN critical_keys TEXT');
}

function parseUiMeta(raw) {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

function listRows(db, userId) {
  const rows = db.prepare(
    'SELECT id, user_id AS userId, site, gateway_device AS gatewayDevice, child_id AS childId, type, title, binds, critical_keys AS criticalKeys, created_at AS createdAt FROM user_devices WHERE user_id = ? ORDER BY created_at',
  ).all(userId);
  // limits/critical do tem đặt (hardware.ui_meta) đi kèm từng dòng để dựng dashboard và kiểm lệnh
  const tenant = db.prepare("SELECT tenant_id FROM users WHERE id = ?").get(userId)?.tenant_id || DEFAULT_TENANT;
  const idOf = new Map();
  const mqttOfRow = (r) => { const k = `${r.site}/${r.gatewayDevice}`; if (!idOf.has(k)) idOf.set(k, mqttIdFor(db, tenant, r.site, r.gatewayDevice)); return idOf.get(k); };
  return rows.map((r) => {
    const dyn = r.type === 'dynamic' ? deviceOf(db, { site: r.site, gateway: r.gatewayDevice, childId: r.childId }) : null;
    return {
      ...r,
      mqttId: mqttOfRow(r),
      spec: specFor(db, r),
      userCritical: parseUserKeys(r.criticalKeys),
      ...(r.type === 'dynamic' ? { fields: dyn?.fields || [], icon: dyn?.icon, color: dyn?.color } : {}),
    };
  });
}

/** Người dùng đánh dấu/bỏ đánh dấu một lệnh là nguy hiểm. Lệnh do tem đặt thì không bỏ được. */
export function setCriticalKey(db, user, id, key, critical) {
  const row = db.prepare('SELECT * FROM user_devices WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!row) return { error: 'not_found', status: 404 };
  const node = deviceToUiNode({ ...row, childId: row.child_id });
  if (!node.widgets.some((w) => w.cmd && w.cmd.key === key)) return { error: 'unknown_key', status: 400 };
  const spec = specFor(db, { site: row.site, gatewayDevice: row.gateway_device, childId: row.child_id });
  if (!critical && spec.critical.includes(key)) return { error: 'locked_by_provisioning', status: 409 };
  const keys = new Set(parseUserKeys(row.critical_keys));
  if (critical) keys.add(key); else keys.delete(key);
  db.prepare('UPDATE user_devices SET critical_keys = ? WHERE id = ?').run(JSON.stringify([...keys]), id);
  audit(db, critical ? 'control_critical_marked' : 'control_critical_unmarked', { userId: user.id, detail: `${row.child_id}.${key}` });
  return { ok: true, dashboard: getDashboardFor(db, user, 'simple') };
}

function upsertDevice(db, {
  userId, site, gatewayDevice, childId, type, title,
}) {
  const existing = db.prepare(
    'SELECT id FROM user_devices WHERE user_id = ? AND site = ? AND child_id = ?',
  ).get(userId, site, childId);
  if (existing) {
    // quét lại tem của gateway khác: thiết bị con chuyển về gateway mới (limits/critical lấy theo tem đó)
    db.prepare('UPDATE user_devices SET type = ?, title = ?, gateway_device = ? WHERE id = ?')
      .run(type, title || null, gatewayDevice, existing.id);
    return { id: existing.id, already: true };
  }
  const id = `ud_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare(`
    INSERT INTO user_devices (id, user_id, site, gateway_device, child_id, type, title, binds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(id, userId, site, gatewayDevice, childId, type, title || null, Date.now());
  return { id, already: false };
}

/**
 * Seed / thêm instance từ hàng hardware đã verify.
 * - profile → device type
 * - ui_meta.seed[] → nhiều child
 * - mặc định 1 child = hardware.device
 */
export function addFromHardwareRow(db, user, hw) {
  const typeId = resolveDeviceTypeId(hw.profile) || 'generic';
  if (!getDeviceType(typeId) && typeId !== 'generic') {
    return { error: 'unknown_profile', status: 422, profile: hw.profile || null };
  }
  const meta = parseUiMeta(hw.ui_meta);
  const site = String(hw.site);
  const gateway = user.notify_device || String(hw.device);
  const added = [];

  const seeds = Array.isArray(meta?.seed) ? meta.seed : null;
  if (seeds?.length) {
    for (const s of seeds) {
      const childId = String(s.childId || s.id || '').trim();
      const t = resolveDeviceTypeId(s.type || typeId) || 'generic';
      if (!SAFE.test(childId)) continue;
      const r = upsertDevice(db, {
        userId: user.id, site, gatewayDevice: gateway,
        childId, type: t, title: s.title || getDeviceType(t)?.title,
      });
      added.push({ childId, type: t, ...r });
    }
  } else {
    const childId = String(hw.device);
    const title = hw.label || getDeviceType(typeId)?.title || childId;
    const r = upsertDevice(db, {
      userId: user.id, site, gatewayDevice: user.notify_device || childId,
      childId, type: typeId === 'iot-hub' ? 'iot-hub' : typeId, title,
    });
    added.push({ childId, type: typeId, ...r });
  }
  return { ok: true, added, site, gateway: user.notify_device };
}

const GATEWAY_PROFILES = new Set(['iot-hub', 'conveyor', 'conveyor-v1']);

/**
 * Quét QR → tự nhận type từ server.
 * - Tem gateway (iot-hub / conveyor): claim site/device rồi seed widgets.
 * - Tem module (env/pump…): chỉ thêm child nếu user đã cùng site (hoặc claim luôn nếu chưa có nhà máy).
 */
/** Chuỗi QR hoặc link login.html?claim=… → payload claim. */
function claimPayloadOf(qr) {
  let raw = String(qr ?? '').trim();
  if (raw.includes('claim=')) {
    try { raw = new URL(raw, 'http://local.invalid').searchParams.get('claim') || raw; } catch { /* giữ nguyên */ }
  }
  return decodeClaimQr(raw);
}

/**
 * Xem thử QR (admin): dựng đúng giao diện user sẽ thấy, KHÔNG gắn thiết bị vào tài khoản, KHÔNG đổi chủ gateway,
 * KHÔNG ghi user_devices / hardware_devices. Vẫn kiểm chữ ký + secret của tem nên không dò được cấu hình bằng cách đoán site/device.
 */
export function previewFromQr(db, { qr, ip, adminId }) {
  const decoded = claimPayloadOf(qr);
  if (!decoded) return { error: 'invalid_claim_payload', status: 400 };
  const verified = verifyClaimSignature(decoded);
  if (verified.error) return verified;
  const hw = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(verified.site, verified.device);
  if (!hw) return { error: 'unknown_device', status: 404 };
  if (hw.claim_hash !== hashClaimSecret(verified.claim)) return { error: 'invalid_claim_secret', status: 401 };

  const meta = parseUiMeta(hw.ui_meta);
  const site = String(hw.site);
  const gatewayDevice = String(hw.device);
  const seeds = Array.isArray(meta?.seed) ? meta.seed : null;
  const typeId = resolveDeviceTypeId(hw.profile) || 'generic';
  const children = seeds?.length
    ? seeds.map((s) => ({ childId: String(s.childId || s.id || '').trim(), type: resolveDeviceTypeId(s.type || typeId) || 'generic', title: s.title }))
      .filter((c) => SAFE.test(c.childId))
    : (typeId === 'iot-hub' ? [] : [{ childId: gatewayDevice, type: typeId, title: hw.label }]);
  const rows = children.map((c) => {
    const row = {
      id: `preview_${c.childId}`, site, gatewayDevice, childId: c.childId, type: c.type,
      title: c.title || getDeviceType(c.type)?.title || c.childId, userCritical: [],
    };
    const dyn = c.type === 'dynamic' ? deviceOf(db, { site, gateway: gatewayDevice, childId: c.childId }) : null;
    return {
      ...row,
      spec: specFor(db, row),
      ...(c.type === 'dynamic' ? { fields: dyn?.fields || [], icon: dyn?.icon, color: dyn?.color } : {}),
    };
  });
  const dash = resolveDashboard({ user: { notify_site: site, notify_device: gatewayDevice }, devices: rows, mode: 'simple', mqttId: mqttIdFor(db, DEFAULT_TENANT, site, gatewayDevice) });
  audit(db, 'admin_qr_preview', { userId: adminId ?? null, ip, detail: `${site}/${gatewayDevice}` });
  return {
    ok: true, review: true, site, device: gatewayDevice, label: hw.label || null, profile: hw.profile || null,
    claimed: Boolean(hw.claimed_by), devices: dash.devices,
  };
}

export async function addDeviceFromQr(db, user, { qr, ip, deviceId }) {
  // Admin quét QR nào cũng chỉ để xem thử: không bao giờ trở thành chủ gateway hay nhận thiết bị vào tài khoản.
  if (String(user?.role || '') === 'admin') return previewFromQr(db, { qr, ip, adminId: user.id });
  const decoded = decodeClaimQr(qr);
  if (!decoded) return { error: 'invalid_claim_payload', status: 400 };
  const verified = verifyClaimSignature(decoded);
  if (verified.error) return verified;

  const hw = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?')
    .get(verified.site, verified.device);
  if (!hw) return { error: 'unknown_device', status: 404 };
  if (hw.claim_hash !== hashClaimSecret(verified.claim)) {
    return { error: 'invalid_claim_secret', status: 401 };
  }
  if (!hw.profile && !parseUiMeta(hw.ui_meta)?.seed) {
    return { error: 'unknown_profile', status: 422 };
  }

  let u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const isGateway = GATEWAY_PROFILES.has(String(hw.profile || ''));

  // Webapp thêm được NHIỀU gateway: user đã có gateway khác → gateway mới được THÊM vào (không thay gateway chính, không xoay mật khẩu MQTT)
  const mine = db.prepare('SELECT DISTINCT site, gateway_device FROM user_devices WHERE user_id = ?').all(u.id);
  if (isGateway && mine.length > 0 && !mine.some((g) => g.site === hw.site && g.gateway_device === hw.device)) {
    return addAdditionalGateway(db, u, hw, { ip });
  }
  const sameSite = u.notify_site === verified.site;

  if (!sameSite) {
    // Chưa cùng nhà máy → claim tem này (gắn notify_site/device)
    const claimed = await claimHardwareDevice(db, { qr, userId: u.id, ip, deviceId });
    if (claimed.error && !claimed.already) return claimed;
    u = claimed.user || db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  } else if (isGateway && u.notify_device !== verified.device) {
    // Đã cùng site nhưng đổi gateway → claim lại
    const claimed = await claimHardwareDevice(db, { qr, userId: u.id, ip, deviceId });
    if (claimed.error && claimed.error !== 'device_already_claimed' && !claimed.already) return claimed;
    u = claimed.user || db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  const result = addFromHardwareRow(db, u, hw);
  if (result.error) return result;
  audit(db, 'user_device_added', {
    userId: u.id, ip, detail: `${verified.site}/${verified.device} +${result.added.length}`,
  });
  return {
    ok: true,
    ...result,
    dashboard: resolveDashboard({ user: u, devices: listRows(db, u.id), mode: 'simple', mqttId: mqttIdFor(db, u.tenant_id, u.notify_site, u.notify_device), gateways: gatewaysOfUser(db, u), ...planOf(u) }),
  };
}

/**
 * Thêm gateway THỨ HAI trở đi vào tài khoản. Tem phải chưa có chủ (hoặc đã là của user này).
 * Không đổi users.notify_site/device (gateway chính giữ nguyên), không xoay mật khẩu MQTT; chỉ cấp thêm quyền đọc topic
 * gw/<mqttId> của gateway mới (ACL) để webapp nhận data, và báo gateway "đã có user" để bắt đầu gửi data.
 */
function addAdditionalGateway(db, u, hw, { ip } = {}) {
  if (hw.claimed_by && hw.claimed_by !== u.id) {
    const owner = db.prepare('SELECT id, disabled, setup_complete FROM users WHERE id = ?').get(hw.claimed_by);
    if (owner && !owner.disabled && owner.setup_complete !== 0) return { error: 'device_already_claimed', status: 409 };
  }
  // Cùng site + trùng id thiết bị con với gateway đã có sẽ ghi đè nhau (UNIQUE user/site/child) → chặn rõ ràng
  const seeds = Array.isArray(parseUiMeta(hw.ui_meta)?.seed) ? parseUiMeta(hw.ui_meta).seed : [];
  const clash = seeds.map((s) => String(s.childId || s.id || '')).find((c) => c && db.prepare(
    'SELECT 1 FROM user_devices WHERE user_id = ? AND site = ? AND child_id = ? AND gateway_device != ?',
  ).get(u.id, hw.site, c, hw.device));
  if (clash) return { error: 'child_id_clash', status: 409, childId: clash };

  const before = gatewaysOfUser(db, u).length;
  db.prepare('UPDATE hardware_devices SET claimed_by = ?, claimed_at = ? WHERE site = ? AND device = ?').run(u.id, Date.now(), hw.site, hw.device);
  const result = addFromHardwareRow(db, { ...u, notify_site: hw.site, notify_device: hw.device }, hw);
  if (result.error) return result;
  if (gatewaysOfUser(db, u).length > before) {
    try { rebuildAclFromUsers(db); reloadMosquitto(); } catch (e) { console.error('add gateway acl', e.message); }
  }
  notifyGateway(db, hw.site, hw.device, 'claimed');
  audit(db, 'user_gateway_added', { userId: u.id, ip, detail: `${hw.site}/${hw.device} +${result.added.length}` });
  return {
    ok: true,
    ...result,
    additionalGateway: true,
    dashboard: getDashboardFor(db, u, 'simple'),
  };
}

export function listUserDevices(db, user) {
  return listRows(db, user.id);
}

export function deleteUserDevice(db, user, id, { ip } = {}) {
  const row = db.prepare('SELECT * FROM user_devices WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!row) return { error: 'not_found', status: 404 };
  db.prepare('DELETE FROM user_devices WHERE id = ?').run(id);
  audit(db, 'user_device_removed', { userId: user.id, detail: id });
  // Xoá thiết bị cuối của nhà máy → nhả tem: ai có QR (và đã reset thiết bị) thêm lại được
  const rel = releaseSiteIfEmpty(db, user.id, row.site, { ip });
  return { ok: true, released: rel.released };
}

/**
 * Gỡ MỘT GATEWAY khỏi tài khoản: xoá toàn bộ thiết bị con của gateway đó (không gỡ lẻ từng widget), nhả tem
 * (gateway ngừng gửi data), thu quyền đọc topic MQTT của gateway. Gateway chính bị gỡ thì chuyển sang gateway còn lại
 * (hết gateway thì về vùng riêng như khi nhả tem).
 */
export function removeGateway(db, user, site, device, { ip } = {}) {
  const rows = db.prepare('SELECT id FROM user_devices WHERE user_id = ? AND site = ? AND gateway_device = ?').all(user.id, site, device);
  if (!rows.length) return { error: 'not_found', status: 404 };
  db.prepare('DELETE FROM user_devices WHERE user_id = ? AND site = ? AND gateway_device = ?').run(user.id, site, device);
  db.prepare('UPDATE hardware_devices SET claimed_by = NULL, claimed_at = NULL WHERE site = ? AND device = ? AND claimed_by = ?').run(site, device, user.id);
  notifyGateway(db, site, device, 'unclaimed');   // gateway ngừng gửi data (best-effort)
  const rest = db.prepare('SELECT DISTINCT site, gateway_device FROM user_devices WHERE user_id = ? ORDER BY created_at').all(user.id);
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (me.notify_site === site && me.notify_device === device) {
    if (rest.length) db.prepare('UPDATE users SET notify_site = ?, notify_device = ? WHERE id = ?').run(rest[0].site, rest[0].gateway_device, user.id);
    else releaseSiteIfEmpty(db, user.id, site, { ip });
  }
  try { rebuildAclFromUsers(db); reloadMosquitto(); } catch (e) { console.error('remove gateway acl', e.message); }
  audit(db, 'user_gateway_removed', { userId: user.id, ip, detail: `${site}/${device} -${rows.length}` });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  return { ok: true, removed: rows.length, dashboard: getDashboardFor(db, u, 'simple') };
}

export function getDashboardFor(db, user, mode) {
  return resolveDashboard({
    user,
    devices: listRows(db, user.id),
    mode: mode === 'pro' ? 'pro' : 'simple',
    mqttId: mqttIdFor(db, user.tenant_id, user.notify_site, user.notify_device),
    gateways: gatewaysOfUser(db, user),
    ...planOf(user),
  });
}

export function mountUserDevices(app, { db, requireAuth, sensitiveStrict, authorize }) {
  migrateUserDevices(db);
  const send = (res, result) => res.status(result?.error ? result.status || 400 : 200).json(result);
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const addLimit = rateLimit({
    windowMs: 60 * 60_000,
    max: Number(process.env.RATE_LIMIT_CLAIM || 10),
    keyFn: (req) => `${clientIp(req)}:udev:${req.user?.id || 0}`,
  });

  app.get('/api/v1/ui/schema', (_req, res) => res.json(uiSchemaPublic()));

  app.get('/api/v1/ui/types', (_req, res) => {
    res.json({
      schema: 1,
      version: UI_CONTRACT_VERSION,
      types: listDeviceTypes().map((t) => {
        const full = getDeviceType(t.id);
        return { ...t, widgets: full?.widgets || [], source: full?.source };
      }),
    });
  });

  app.get('/api/v1/ui/types/:typeId', (req, res) => {
    const t = getDeviceType(req.params.typeId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.json({ schema: 1, version: UI_CONTRACT_VERSION, type: t });
  });

  app.get('/api/v1/ui/dashboard', requireAuth, (req, res) => {
    const mode = String(req.query.mode || 'simple');
    res.json(getDashboardFor(db, req.user, mode));
  });

  app.get('/api/devices', requireAuth, (req, res) => {
    res.json({ ok: true, devices: listUserDevices(db, req.user) });
  });

  // Đánh dấu lệnh nguy hiểm. Bỏ dấu = hạ mức bảo vệ → phải qua step-up như một lệnh điều khiển (nếu server bật).
  app.post('/api/devices/:id/critical', requireAuth, (req, res) => {
    const critical = Boolean(req.body?.critical);
    if (!critical && authorize) {
      const a = authorize(req);
      if (a.error) return res.status(a.status || 401).json(a);
    }
    send(res, setCriticalKey(db, req.user, req.params.id, String(req.body?.key || ''), critical));
  });

  app.post('/api/devices', requireAuth, sensitiveStrict, addLimit, asyncRoute(async (req, res) => {
    if (req.tokenPayload?.scope && req.tokenPayload.scope !== 'full') {
      return send(res, { error: 'login_step_up_required', status: 401 });
    }
    const qr = req.body?.qr || req.body?.payload;
    if (qr) {
      return send(res, await addDeviceFromQr(db, req.user, {
        qr, ip: clientIp(req), deviceId: req.headers['x-device-id'],
      }));
    }
    // Pre-register không QR: type + childId trên đúng site user
    const type = resolveDeviceTypeId(req.body?.type);
    const childId = String(req.body?.childId || '').trim();
    if (!type || !SAFE.test(childId)) return send(res, { error: 'invalid_device', status: 400 });
    if (!req.user.notify_site) return send(res, { error: 'no_site', status: 409 });
    const r = upsertDevice(db, {
      userId: req.user.id,
      site: req.user.notify_site,
      gatewayDevice: req.user.notify_device,
      childId,
      type,
      title: req.body?.title || getDeviceType(type)?.title,
    });
    send(res, {
      ok: true,
      added: [{ childId, type, ...r }],
      dashboard: getDashboardFor(db, req.user, 'simple'),
    });
  }));

  // Gỡ cả gateway (webapp không gỡ lẻ từng thiết bị/widget)
  app.delete('/api/gateways/:site/:device', requireAuth, sensitiveStrict, (req, res) => {
    send(res, removeGateway(db, req.user, String(req.params.site), String(req.params.device), { ip: clientIp(req) }));
  });

  app.delete('/api/devices/:id', requireAuth, sensitiveStrict, (req, res) => {
    send(res, deleteUserDevice(db, req.user, req.params.id, { ip: clientIp(req) }));
  });
}
