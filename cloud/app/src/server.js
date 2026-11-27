import { serverProfileInfo } from './serverProfile.js';   // PHẢI đứng đầu: đặt mặc định biến môi trường theo cỡ VPS trước khi module khác đọc
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { openDb } from './db.js';
import './securityAdapter.js';
import { resolveBundleRoot, safeJoin, listBundleFiles } from './bundle.js';
import { startBundleSync, syncBundles, ensureUserBundleFresh } from './bundleSync.js';
import { registryItems, detectFolders, ignoredFolders, addItem, updateItem, removeItem, solutionVersion } from './solutions.js';
import { startMqttIngest, startHistoryPurge } from './mqttIngest.js';
import { queryTelemetry, queryTelemetryRows, queryEvents, historyStats } from './historyStore.js';
import {
  configure, mountAuthentication, securityHeaders, httpsOnly, buildCorsOptions, rateLimit, clientIp, audit,
  purgeExpiredAudit, createAppSession, signToken,
} from '@plciot/security';
import { mqttClientConfig, provisionUserMqtt, rebuildAclFromUsers, reloadMosquitto } from './mqttProvision.js';
import { wipeOwnHistory } from './deviceTransfer.js';
import { exportAccountData, deleteOwnAccount } from './accountData.js';
import { isDashboardAdmin, userScopes, canControl } from './roles.js';
import { adminLocalOnly, adminInternetGuard, isDirectLocal } from './adminGate.js';
import { adminSiteGate, mountAdminSite, adminHost } from './adminSite.js';
import { startBackups } from './dbBackup.js';
import { initSupport, mountSupport } from './supportChat.js';
import { adoptSolution, listUsers, createUser, updateUser, deleteUser, applyBootstrapAdmins, purgeIncompleteUsers, ROLES, MONITOR_SCOPES, listSolutions, defaultSolution } from './adminUsers.js';
import { retentionInfo, retentionFloor, defaultDays } from './retention.js';
import { mountPlcControl } from './plcControlRoutes.js';
import { mountHwReports } from './hwReports.js';
import { mountMcuOta } from './mcuOta.js';
import { plcControlConfig } from './plcCommands.js';
import { startControlPublisher } from './controlPublisher.js';
import { mountSite } from './siteRoutes.js';
import { mountPush } from './webPush.js';
import { mountPartnerRoutes } from './partnerRoutes.js';
import { mountAdminOps } from './adminOps.js';
import { mountRemoteAdmin } from './remoteAdmin.js';
import { mountGatewayLogic } from './gatewayLogic.js';
import { mountGatewayNames } from './gatewayNames.js';
import { mountNocode, startNocodeSweep } from './nocode.js';
import { mountCapacity } from './vpsCapacity.js';
import { mountUserDevices, setGatewayAddedHook } from './userDevices.js';
import { gatewaySolution, setSolutionsContext, setSolutionChangedHook } from './gatewaySolution.js';
import { mountGatewayEnroll } from './gatewayEnroll.js';
import { mountGatewayLogin } from './gatewayLogin.js';
import { expireUnusedTems, sweepPairings } from './gatewayPairing.js';
import { contractInfo } from './contract.js';
import { subscriptionInfo, planExportDays } from './entitlements.js';
import { markViewing } from './viewing.js';
import { loginGateMiddleware } from './opsFlags.js';
import { mountGatewayUpdate } from './gatewayUpdate.js';
import { mountDebugTrace, debugTraceEnabled } from './debugTrace.js';

const PORT = Number(process.env.PORT || 3080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const SHELL_DIR = path.resolve(process.env.SHELL_DIR || path.join(DATA_DIR, '..', '..', '..', 'webapp'));
const WEBAPP_SRC = path.resolve(process.env.WEBAPP_SRC || SHELL_DIR);
const JWT_SECRET = process.env.APP_JWT_SECRET || '';
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('APP_JWT_SECRET must be set (min 16 chars)');
  process.exit(1);
}

// Cắm app vào lõi bảo mật dùng chung (packages/security): lõi không biết Telegram/email/PLC.
configure({
  secret: () => JWT_SECRET,
  publicUrl: () => (process.env.WEBAPP_PUBLIC_URL || '').replace(/\/$/, ''),
  canControl: (u) => canControl(u),
  brand: { rpName: 'Giám sát PLC' },
});

const db = openDb(DATA_DIR);
applyBootstrapAdmins(db);
initSupport(db);
startBackups(db, DATA_DIR);
setInterval(() => { try { purgeIncompleteUsers(db); } catch (e) { console.error('purgeIncompleteUsers', e.message); } }, 3600_000).unref?.();
setInterval(() => { try { purgeExpiredAudit(db); } catch (e) { console.error('purgeExpiredAudit', e.message); } }, 3600_000).unref?.();
try { purgeExpiredAudit(db); } catch { /* ignore */ }
const app = express();
app.locals.db = db;

app.disable('x-powered-by');
app.set('trust proxy', 1); // Cloudflare Tunnel / CF-Connecting-IP
app.use(httpsOnly);         // qua Cloudflare: http → https (301) + HSTS; LAN truy cập thẳng không đổi
app.use(securityHeaders);
app.use(adminSiteGate);   // ADMIN_HOST: tên miền admin riêng, tên miền app không phục vụ admin
app.use(adminLocalOnly);
app.use(adminInternetGuard((req, res, next) => requireAuth(req, res, next)));   // requireAuth khai báo ở dưới; chỉ gọi lúc có request   // ADMIN_ONLY_CIDRS: trang + API admin chỉ cho PC của chủ (hoặc đường hầm SSH)
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = buf; } })); // rawBody: chữ ký của PC nhà máy
app.use('/api/', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// Global soft limit (per IP)
// Tải gói webapp (≈45 tệp mỗi lần đăng nhập/cập nhật) có hạn mức riêng; nếu dùng chung 120 yêu cầu/phút thì đăng nhập lần 2 trong 1 phút sẽ bị 429.
const apiLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_API || 120) });
const bundleLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_BUNDLE || 600) });
app.use('/api/', (req, res, next) => (req.path.startsWith('/bundle/') ? bundleLimit : apiLimit)(req, res, next));
// Kill-switch đăng nhập (Console Monitor)
app.use(loginGateMiddleware);
mountDebugTrace(app);

function requireAdmin(req, res, next) {
  if (!isDashboardAdmin(req.user)) return res.status(403).json({ error: 'forbidden' });
  next();
}

function appPayload(user) {
  let bundleRoot;
  try {
    bundleRoot = resolveBundleRoot(DATA_DIR, user.folder_path);
  } catch {
    return { error: 'bad_folder_path', status: 500 };
  }
  if (!fs.existsSync(bundleRoot)) return { error: 'bundle_missing', status: 500 };
  const files = listBundleFiles(bundleRoot);
  // Ensure MQTT ACL-scoped credentials exist (lazy provision for legacy users)
  let u = user;
  if (!u.mqtt_user || !u.mqtt_pass) {
    try {
      u = provisionUserMqtt(db, u).user;
    } catch (e) {
      console.error('lazy mqtt provision', e.message);
    }
  }
  return {
    userId: u.id,
    username: u.username,
    version: u.version,
    files,
    mqtt: mqttClientConfig(db, u),
    notifySite: u.notify_site,
    notifyDevice: u.notify_device,
    role: u.role,
    dashboardAdmin: isDashboardAdmin(u),
  };
}

// Nhật ký truy cập các bước đăng ký sinh trắc / đăng ký (không ghi nội dung): giúp chẩn đoán lỗi trên điện thoại.
app.use(['/api/register', '/api/webauthn', '/api/login/complete', '/api/login/complete-basic', '/api/account/password'], (req, res, next) => {
  res.on('finish', () => {
    console.log(`[auth] ${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} ua="${String(req.headers['user-agent'] || '').slice(0, 90)}"`);
  });
  next();
});

const controlApi = mountAuthentication(app, {
  db, appPayload, registrationContext: { dataDir: DATA_DIR, webappSrc: WEBAPP_SRC }, adminOnly: [requireAdmin],
  extraStatus: () => ({ physicalConfirm: plcControlConfig().physicalBit !== null }),
  authConfig: () => ({ channel: 'device' }),
});
const { requireAuth, sensitiveStrict, reauth } = controlApi;
mountAdminSite(app, { db, requireAuth, requireAdmin, jwtSecret: JWT_SECRET });
const send = (res, result) => res.status(result.error ? result.status || 400 : 200).json(result);
const ipOf = clientIp;

mountGatewayUpdate(app, { releasesDir: path.resolve(process.env.RELEASES_DIR || path.join(DATA_DIR, '..', '..', '..', 'releases')) });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, contract: contractInfo(), debugTrace: debugTraceEnabled(), appLockDisabled: String(process.env.APP_LOCK_DISABLED || "false").toLowerCase() === "true" });
});

app.post('/api/account/data/wipe', requireAuth, sensitiveStrict, reauth, (req, res) => {
  send(res, wipeOwnHistory(db, req.user, { reauthed: req.reauthed, ip: ipOf(req) }));
});

app.get('/api/account/data/export', requireAuth, sensitiveStrict, reauth, (req, res) => {
  if (req.reauthed !== true) return send(res, { error: 'invalid_credentials', status: 401 });
  const data = exportAccountData(db, req.user);
  audit(db, 'account_exported', { userId: req.user.id, ip: ipOf(req) });
  send(res, data);
});

app.post('/api/account/delete', requireAuth, sensitiveStrict, reauth, (req, res) => {
  send(res, deleteOwnAccount(db, req.user, { reauthed: req.reauthed, ip: ipOf(req), dataDir: DATA_DIR }));
});

app.get('/api/me', requireAuth, (req, res) => {
  let u = req.user;
  if (!u.mqtt_user || !u.mqtt_pass) {
    try { u = provisionUserMqtt(db, u).user; } catch (e) { console.error('lazy mqtt provision', e.message); }
  }
  u = ensureUserBundleFresh(db, u, { dataDir: DATA_DIR, shellDir: SHELL_DIR });   // tải lại trang = kiểm tra mã nguồn webapp ngay, khác thì dựng lại bundle
  res.json({
    userId: u.id,
    username: u.username,
    version: u.version,
    files: (() => { try { return listBundleFiles(resolveBundleRoot(DATA_DIR, u.folder_path)); } catch { return []; } })(),
    notifySite: u.notify_site,
    notifyDevice: u.notify_device,
    role: u.role,
    dashboardAdmin: isDashboardAdmin(u),
    adminUrl: adminHost() ? `https://${adminHost()}/` : null,
    ...retentionInfo(u),
    subscription: subscriptionInfo(u),
    mqtt: mqttClientConfig(db, u),
  });
});

/* ---------- Admin: quản lý người dùng & phân quyền ---------- */
/**
 * ADMIN_SSH_LOGIN=true: vào trang admin qua đường hầm SSH (127.0.0.1) thì KHÔNG cần đăng nhập — server cấp phiên cho tài khoản
 * admin đầu tiên trong danh sách. Chỉ chạy được khi kết nối đến trực tiếp (không có header Cloudflare/proxy); từ Internet luôn 404.
 */
app.get('/api/admin/local-session', (req, res) => {
  if (String(process.env.ADMIN_SSH_LOGIN || 'false').toLowerCase() !== 'true' || !isDirectLocal(req)) {
    return res.status(404).json({ error: 'not_found' });
  }
  const names = String(process.env.ADMIN_USERNAMES || '').split(',').map((x) => x.trim()).filter(Boolean);
  let u = null;
  for (const n of names) {
    u = db.prepare("SELECT id, token_version, username FROM users WHERE username = ? COLLATE NOCASE AND role = 'admin' AND disabled = 0").get(n);
    if (u) break;
  }
  if (!u) return res.status(409).json({ error: 'admin_account_missing' });
  const sid = createAppSession(db, u.id, 'ssh-local');
  const token = signToken({ uid: u.id, tv: u.token_version | 0, sid }, JWT_SECRET, 8 * 3600);
  audit(db, 'admin_ssh_login', { userId: u.id, ip: clientIp(req) });
  res.json({ token, username: u.username });
});

const adminOnly = [requireAuth, requireAdmin];
const adminWrite = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_ADMIN || 30),
  keyFn: (req) => `${clientIp(req)}:admin:${req.user?.id || 'na'}`,
});

app.get('/api/admin/users', ...adminOnly, (req, res) => {
  // ?q=&limit=&offset= : lọc theo tên/site/thiết bị/vai trò + phân trang (không có limit = trả tất cả như cũ)
  let users = listUsers(db);
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) users = users.filter((u) => [u.username, u.site, u.device, u.role].some((v) => String(v || '').toLowerCase().includes(q)));
  const total = users.length;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 0)) || null;
  const offset = Math.max(0, Number(req.query.offset) || 0);
  if (limit) users = users.slice(offset, offset + limit);
  res.json({ roles: ROLES, scopes: MONITOR_SCOPES, gatewaySolutions: listSolutions(WEBAPP_SRC, 'any'), defaultSolution: defaultSolution(), users, total, offset, limit });
});

/* Mục trong ô chọn "giải pháp" (admin thêm/sửa; mỗi mục trỏ tới một thư mục trong solutions/) */
const solutionsView = () => {
  const items = registryItems(WEBAPP_SRC);
  const count = (id) => { try { return db.prepare('SELECT COUNT(*) n FROM gateway_solutions WHERE solution = ?').get(id).n; } catch { return 0; } };   // số GATEWAY dùng giải pháp này
  const folders = detectFolders(WEBAPP_SRC);
  return {
    default: defaultSolution(),
    basicUsers: 0,
    items: items.map((it) => { const f = folders.find((x) => x.folder === it.folder); return { ...it, icon: f?.icon || '', themeColor: f?.themeColor || '', parts: f?.parts || { webapp: false, gateway: false }, users: count(it.id), missing: !f, version: f?.parts.webapp ? solutionVersion(WEBAPP_SRC, it.folder) : '' }; }),
    folders: folders.map((f) => ({ ...f, registered: items.some((it) => it.folder === f.folder) })),
    ignored: ignoredFolders(WEBAPP_SRC),   // thư mục trông như giải pháp nhưng thiếu dấu nhận diện / phần nào
  };
};
app.get('/api/admin/solutions', ...adminOnly, (req, res) => res.json(solutionsView()));
app.post('/api/admin/solutions', ...adminOnly, adminWrite, reauth, (req, res) => {
  const r = addItem(WEBAPP_SRC, req.body || {});
  if (r.ok) audit(db, 'solution_add', { userId: req.user.id, ip: ipOf(req), detail: r.item.id });
  send(res, r);
});
app.patch('/api/admin/solutions/:id', ...adminOnly, adminWrite, reauth, (req, res) => {
  const r = updateItem(WEBAPP_SRC, String(req.params.id), req.body || {});
  if (r.ok) { audit(db, 'solution_update', { userId: req.user.id, ip: ipOf(req), detail: String(req.params.id) }); syncBundles(db, { shellDir: WEBAPP_SRC, dataDir: DATA_DIR }); }
  send(res, r);
});
app.delete('/api/admin/solutions/:id', ...adminOnly, adminWrite, reauth, (req, res) => {
  const id = String(req.params.id);
  const r = removeItem(WEBAPP_SRC, id, (() => { try { return db.prepare('SELECT COUNT(*) n FROM gateway_solutions WHERE solution = ?').get(id).n; } catch { return 0; } })());
  if (r.ok) audit(db, 'solution_remove', { userId: req.user.id, ip: ipOf(req), detail: id });
  send(res, r);
});

app.post('/api/admin/users', ...adminOnly, adminWrite, reauth, (req, res) => {
  send(res, createUser(db, req.user, req.body || {}, { dataDir: DATA_DIR, webappSrc: WEBAPP_SRC, ip: ipOf(req) }));
});

app.patch('/api/admin/users/:id', ...adminOnly, adminWrite, reauth, (req, res) => {
  send(res, updateUser(db, req.user, Number(req.params.id), req.body || {}, { ip: ipOf(req), shellDir: WEBAPP_SRC, dataDir: DATA_DIR }));
});

app.delete('/api/admin/users/:id', ...adminOnly, adminWrite, reauth, (req, res) => {
  send(res, deleteUser(db, req.user, Number(req.params.id), { ip: ipOf(req), dataDir: DATA_DIR }));
});

/* ---------- Điều khiển: step-up (Passkey / TOTP), PC trạm, nút vật lý ---------- */
mountPlcControl(app, { db, requireAuth, security: controlApi });
mountHwReports(app, { db, requireAuth, security: controlApi });
// cập nhật firmware board có duyệt của chủ trạm + lịch sử hệ thống
mountMcuOta(app, { db, requireAuth, security: controlApi, releasesDir: path.resolve(process.env.RELEASES_DIR || path.join(DATA_DIR, '..', '..', '..', 'releases')) });
/* ---------- Nhà máy tự phục vụ: nhận thiết bị, mời thành viên, ghép PC ---------- */
mountSite(app, { db, requireAuth, reauth });
mountPush(app, { db, requireAuth, dataDir: DATA_DIR });
/* ---------- Nền tảng đa tenant: admin tenants + partner API (MQTTS provision) ---------- */
mountPartnerRoutes(app, { db, requireAuth, reauth });
/* ---------- Gateway enroll: kéo MQTT + seed từ tem QR (không hard-code) ---------- */
mountGatewayEnroll(app, { db });
mountGatewayLogin(app, { db, requireAuth, jwtSecret: JWT_SECRET, publicUrl: process.env.WEBAPP_PUBLIC_URL || 'https://plc.dieukhientudong.net' });
/* Tem ghép cặp bỏ quên (chưa ai claim sau PAIRING_TEM_TTL_DAYS) tự thu hồi: lúc khởi động rồi mỗi giờ */
const sweepTems = () => { try { sweepPairings(db); expireUnusedTems(db); } catch (e) { console.error('expireUnusedTems', e.message); } };
sweepTems();
setInterval(sweepTems, 3600_000).unref();
/* ---------- UI contract + thiết bị con dashboard (QR → widget tự động) ---------- */
mountUserDevices(app, { db, requireAuth, sensitiveStrict, authorize: controlApi.authorize });
mountGatewayNames(app, { db, requireAuth });   // tên hiển thị gateway do chủ đặt (ID do hệ thống cấp, không đổi)
mountNocode(app, { db });   // gateway mua sẵn (no-code): chỉ GatewayApp tạo/ánh xạ (ký khoá máy) — docs/NOCODE-GATEWAY.md
setSolutionsContext(WEBAPP_SRC);
setGatewayAddedHook((d, u, hw) => adoptSolution(d, u.id, gatewaySolution(d, hw.site, hw.device), { shellDir: WEBAPP_SRC, dataDir: DATA_DIR }));
// Gateway đổi giải pháp UI → dựng lại bundle webapp của mọi người dùng gateway đó (webapp tải giao diện mới, không giữ giao diện cũ)
setSolutionChangedHook((d, site, device, sol) => {
  const ids = d.prepare(`SELECT DISTINCT u.id FROM users u WHERE u.disabled = 0 AND (
      (u.notify_site = ? AND u.notify_device = ?)
      OR u.id IN (SELECT claimed_by FROM hardware_devices WHERE site = ? AND device = ? AND claimed_by IS NOT NULL)
      OR u.id IN (SELECT user_id FROM user_devices WHERE site = ? AND gateway_device = ?))`).all(site, device, site, device, site, device).map((r) => r.id);
  for (const id of ids) adoptSolution(d, id, sol, { shellDir: WEBAPP_SRC, dataDir: DATA_DIR });
});
/* ---------- Trang kích hoạt gateway trên điện thoại: Internet + đăng nhập admin + BẮT BUỘC Face ID ---------- */
/* ---------- Console vận hành: gói / thiết bị / DB ---------- */
const radmin = mountRemoteAdmin(app, { db, requireAuth });   // GatewayAdmin cài đặt gateway từ xa (ký bằng khoá máy, chủ gateway phải cho phép)
mountGatewayLogic(app, { db, requireAuth, security: controlApi, admin: radmin });   // chương trình logic: admin đề xuất (text) → chủ trạm duyệt; chủ trạm tự cài hẹn giờ
mountAdminOps(app, {
  db, requireAuth, requireAdmin, reauth,
  dataDir: DATA_DIR,
  shellDir: SHELL_DIR,
  adminWrite: rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_ADMIN || 30),
    keyFn: (req) => `${clientIp(req)}:admin-ops:${req.user?.id || 'na'}`,
  }),
});

mountCapacity(app, { db, requireAuth, requireAdmin, dataDir: DATA_DIR });
app.get('/api/admin/server-profile', requireAuth, requireAdmin, (_req, res) => res.json(serverProfileInfo()));

/* ---------- Chat hỗ trợ người dùng ↔ admin (chỉ văn bản; xem docs/CHAT-COMPLIANCE.md) ---------- */
mountSupport(app, { db, requireAuth, requireAdmin });

app.get('/api/history/telemetry', requireAuth, (req, res) => {
  // Always bind to the authenticated user's site/device (client query cannot pivot to another tenant)
  const site = req.user.notify_site;
  const device = req.user.notify_device;

  const until = Number(req.query.until || Date.now());
  const limit = Number(req.query.limit || 5000);
  const since = Math.max(Number(req.query.since || 0), retentionFloor(req.user)); // plan window
  if (!Number.isFinite(since) || !Number.isFinite(until)) {
    return res.status(400).json({ error: 'bad_range' });
  }

  if (!userScopes(req.user).includes('telemetry')) return res.status(403).json({ error: 'scope_denied' });
  const samples = queryTelemetry(db, { site, device, since, until, limit });
  const last = samples.length ? samples[samples.length - 1].t : since;
  res.json({
    site,
    device,
    samples: samples.map(({ t, o, i, a, c, s }) => ({ t, o, i, a, c, s })),
    nextSince: last,
    done: samples.length < Math.min(Math.max(1, limit | 0), 10000),
    ...retentionInfo(req.user),
  });
});

/** Nhịp "đang xem": webapp mở gửi mỗi ~20 giây → gateway của người dùng gửi nhanh; ngừng xem thì gateway quay về tốc độ lưu của gói. */
const viewingLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_VIEWING || 12), keyFn: (req) => `${clientIp(req)}:viewing:${req.user?.id || 'na'}` });
app.post('/api/viewing', requireAuth, viewingLimit, (req, res) => res.json(markViewing(db, req.user)));

/** Xuất dữ liệu: CSV (mở bằng Excel) hoặc JSON, dạng dài: thời gian · thiết bị · field · giá trị · nguồn (live | bu). Trong thời hạn lưu của gói. */
app.get('/api/history/export', requireAuth, (req, res) => {
  let site = req.user.notify_site;
  let device = req.user.notify_device;
  // Chọn gateway (site + gw) trong số gateway của CHÍNH tài khoản: thiết bị mặc định, gateway đã gắn (hardware_devices.claimed_by) hoặc có thiết bị con (user_devices). Không cho xuất gateway của người khác.
  const qSite = String(req.query.site || '').trim();
  const qGw = String(req.query.gw || '').trim();
  if (qSite && qGw && !(qSite === site && qGw === device)) {
    const mine = db.prepare('SELECT 1 FROM user_devices WHERE user_id = ? AND site = ? AND gateway_device = ? LIMIT 1').get(req.user.id, qSite, qGw)
      || db.prepare('SELECT 1 FROM hardware_devices WHERE claimed_by = ? AND site = ? AND device = ? LIMIT 1').get(req.user.id, qSite, qGw);
    if (!mine) return res.status(403).json({ error: 'gateway_not_yours' });
    site = qSite; device = qGw;
  }
  if (!userScopes(req.user).includes('telemetry')) return res.status(403).json({ error: 'scope_denied' });
  const until = Number(req.query.until || Date.now());
  // Gói miễn phí (DK10) chỉ xuất 7 ngày gần nhất; gói trả phí không giới hạn (vẫn trong thời hạn lưu)
  const exportDays = planExportDays(req.user);
  const exportFloor = exportDays == null ? 0 : Date.now() - exportDays * 86_400_000;
  const since = Math.max(Number(req.query.since || 0), retentionFloor(req.user), exportFloor);
  if (!Number.isFinite(since) || !Number.isFinite(until)) return res.status(400).json({ error: 'bad_range' });
  const fmtQ = String(req.query.format || 'csv').toLowerCase();
  const fmt = ['json', 'tsv'].includes(fmtQ) ? fmtQ : 'csv';   // csv | tsv (txt, cột cách nhau bằng Tab) | json
  const rows = queryTelemetryRows(db, { site, device, since, until, limit: Math.min(Number(req.query.limit || 200000), 500000) });
  const flat = [];
  for (const r of rows) {
    let pl; try { pl = JSON.parse(r.payload); } catch { continue; }
    const d = pl.d;
    if (!d || typeof d !== 'object') continue;
    for (const [child, fields] of Object.entries(d)) {
      if (!fields || typeof fields !== 'object') continue;
      for (const [field, v] of Object.entries(fields)) flat.push({ ts: r.ts, child, field, v, src: r.src === 'bf' ? 'bu' : 'live', mn: pl.agg?.mn?.[child]?.[field] ?? '', mx: pl.agg?.mx?.[child]?.[field] ?? '', n: pl.agg?.n ?? '' });
    }
  }
  const stamp = new Date().toISOString().slice(0, 10);
  if (fmt === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="plciot-${stamp}.json"`);
    return res.json({ site, device, rows: flat.map((x) => ({ t: x.ts, device: x.child, field: x.field, value: x.v, min: x.mn === '' ? null : x.mn, max: x.mx === '' ? null : x.mx, samples: x.n === '' ? null : x.n, source: x.src })) });
  }
  const tsv = fmt === 'tsv';
  const sep = tsv ? '\t' : ',';
  const esc = tsv ? (s) => String(s).replace(/[\t\r\n]/g, ' ') : (s) => { s = String(s); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['time_utc', 'epoch_ms', 'device', 'field', 'value', 'min', 'max', 'samples', 'source'].join(sep)];
  for (const x of flat) lines.push([new Date(x.ts).toISOString(), x.ts, esc(x.child), esc(x.field), x.v, x.mn, x.mx, x.n, x.src].join(sep));
  res.setHeader('Content-Type', tsv ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="plciot-${stamp}.${tsv ? 'txt' : 'csv'}"`);
  res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
});

app.get('/api/history/events', requireAuth, (req, res) => {
  const site = req.user.notify_site;
  const device = req.user.notify_device;
  const since = Math.max(Number(req.query.since || 0), retentionFloor(req.user));
  const until = Number(req.query.until || Date.now());
  const kinds = String(req.query.kinds || 'status,history')
    .split(',').map((k) => k.trim()).filter(Boolean)
    .filter((k) => userScopes(req.user).includes(k)); // chỉ trả nhóm thông tin user được phép đọc
  if (!kinds.length) return res.status(403).json({ error: 'scope_denied' });
  const events = queryEvents(db, {
    site, device, since, until, kinds, limit: Number(req.query.limit || 2000),
  });
  res.json({ site, device, events, done: events.length < 2000 });
});

app.get('/api/history/stats', requireAuth, (req, res) => {
  // Aggregate totals are admin-ish; only when open access or omit sensitive counts
  if (String(process.env.HISTORY_OPEN_ACCESS || '').toLowerCase() !== 'true') {
    return res.json({
      ...retentionInfo(req.user),
      scoped: true,
      site: req.user.notify_site,
      device: req.user.notify_device,
    });
  }
  res.json({
    ...historyStats(db),
    ...retentionInfo(req.user),
    defaultDays: defaultDays(),
  });
});

app.use('/api/bundle', requireAuth, (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const rel = (req.path || '/').replace(/^\/+/, '');
  let bundleRoot;
  try {
    bundleRoot = resolveBundleRoot(DATA_DIR, req.user.folder_path);
  } catch {
    return res.status(500).json({ error: 'bad_folder_path' });
  }
  const abs = safeJoin(bundleRoot, rel);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return res.status(404).json({ error: 'not_found' });
  }
  const type = mime.lookup(abs) || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
});

app.get('/', (_req, res) => {
  res.redirect(302, '/login.html');
});

if (fs.existsSync(SHELL_DIR)) {
  app.use(express.static(SHELL_DIR, {
    index: false,
    etag: true,
    setHeaders(res, filePath) {
      // HTML/JS: luôn kiểm tra bản mới sau deploy (refresh = phiên bản mới nhất)
      if (/\.(html?|js|css|json|svg)$/i.test(filePath) || filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  }));
} else {
  console.warn('SHELL_DIR missing:', SHELL_DIR);
}

app.use((err, _req, res, _next) => {
  if (err?.message === 'CORS_NOT_ALLOWED') {
    return res.status(403).json({ error: 'cors_denied' });
  }
  // lỗi do người gọi gửi sai (JSON hỏng, thân quá lớn…) là 4xx, không phải lỗi máy chủ
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`plciot app listening on :${PORT}`);
  { const p = serverProfileInfo(); console.log(`SERVER_PROFILE=${p.profile} (${p.label})` + (p.applied.length ? ` — hồ sơ đặt: ${p.applied.join(', ')}` : '') + (p.overridden.length ? ` — .env ghi đè: ${p.overridden.join(', ')}` : '')); }
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`SHELL_DIR=${SHELL_DIR}`);
  startControlPublisher();
  startBundleSync(db, { dataDir: DATA_DIR, shellDir: SHELL_DIR });
  // ACL gateway cần cho phép ghi kind 'alert' (sự kiện cảnh báo do gateway tự tính): dựng lại từ DB mỗi lần khởi động
  try { rebuildAclFromUsers(db); reloadMosquitto(); } catch (e) { console.error('acl rebuild', e.message); }
  startMqttIngest(db);
  startNocodeSweep();   // gateway no-code im lặng quá lâu → server báo offline
  startHistoryPurge(db);
});
