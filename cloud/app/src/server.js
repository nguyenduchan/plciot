import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { openDb } from './db.js';
import './securityAdapter.js';
import { resolveBundleRoot, safeJoin, listBundleFiles } from './bundle.js';
import { startBundleSync } from './bundleSync.js';
import { formatVnLocal } from './phone.js';
import { startTelegramBot } from './bot.js';
import { startMqttIngest, startHistoryPurge } from './mqttIngest.js';
import { telegramConfigured } from './telegram.js';
import { sharedPgConfigured } from './sharedTg.js';
import { queryTelemetry, queryEvents, historyStats } from './historyStore.js';
import {
  configure, mountAuthentication, securityHeaders, buildCorsOptions, rateLimit, clientIp, audit,
} from '@plciot/security';
import { mqttClientConfig, provisionUserMqtt } from './mqttProvision.js';
import { wipeOwnHistory } from './deviceTransfer.js';
import { isDashboardAdmin, userScopes, canControl } from './roles.js';
import { listUsers, createUser, updateUser, deleteUser, applyBootstrapAdmins, ROLES, MONITOR_SCOPES } from './adminUsers.js';
import { retentionInfo, retentionFloor, defaultDays } from './retention.js';
import { mountPlcControl } from './plcControlRoutes.js';
import { plcControlConfig } from './plcCommands.js';
import { startControlPublisher } from './controlPublisher.js';
import { mountSite } from './siteRoutes.js';
import { mountPartnerRoutes } from './partnerRoutes.js';
import { mountAdminOps } from './adminOps.js';
import { contractInfo } from './contract.js';
import { subscriptionInfo } from './entitlements.js';
import { loginGateMiddleware } from './opsFlags.js';
import { mountDebugTrace, debugTraceEnabled } from './debugTrace.js';

const PORT = Number(process.env.PORT || 3080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const SHELL_DIR = path.resolve(process.env.SHELL_DIR || path.join(DATA_DIR, '..', '..', '..', 'webapp'));
const WEBAPP_SRC = path.resolve(process.env.WEBAPP_SRC || SHELL_DIR);
const JWT_SECRET = process.env.APP_JWT_SECRET || '';
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';

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
const app = express();
app.locals.db = db;

app.disable('x-powered-by');
app.set('trust proxy', 1); // Cloudflare Tunnel / CF-Connecting-IP
app.use(securityHeaders);
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
  // Chỉ SĐT trong ADMIN_DASHBOARD_PHONES / ADMIN_PHONES (docs/ADMIN-REMOTE.md)
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
    mqtt: mqttClientConfig(u),
    notifySite: u.notify_site,
    notifyDevice: u.notify_device,
    role: u.role,
    dashboardAdmin: isDashboardAdmin(u),
  };
}

const controlApi = mountAuthentication(app, {
  db, appPayload, registrationContext: { dataDir: DATA_DIR, webappSrc: WEBAPP_SRC }, adminOnly: [requireAdmin],
  extraStatus: () => ({ physicalConfirm: plcControlConfig().physicalBit !== null }),
  authConfig: () => ({ telegram: telegramConfigured(), botUsername: BOT_USERNAME || null,
    botLink: BOT_USERNAME ? `https://t.me/${BOT_USERNAME.replace(/^@/, '')}` : null,
    sharedBot: sharedPgConfigured() || String(process.env.TELEGRAM_BOT_POLLING || 'false').toLowerCase() !== 'true' }),
  presencePaths: { start: '/api/recovery/plc/start', check: '/api/recovery/plc/check' },
});
const { requireAuth, sensitiveStrict, reauth } = controlApi;
const send = (res, result) => res.status(result.error ? result.status || 400 : 200).json(result);
const ipOf = clientIp;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, contract: contractInfo(), debugTrace: debugTraceEnabled() });
});

app.post('/api/account/data/wipe', requireAuth, sensitiveStrict, reauth, (req, res) => {
  send(res, wipeOwnHistory(db, req.user, { reauthed: req.reauthed, ip: ipOf(req) }));
});

app.get('/api/me', requireAuth, (req, res) => {
  let u = req.user;
  if (!u.mqtt_user || !u.mqtt_pass) {
    try { u = provisionUserMqtt(db, u).user; } catch (e) { console.error('lazy mqtt provision', e.message); }
  }
  res.json({
    userId: u.id,
    username: u.username,
    phone: u.phone || u.username,
    phoneLocal: formatVnLocal(u.phone || u.username),
    version: u.version,
    files: (() => { try { return listBundleFiles(resolveBundleRoot(DATA_DIR, u.folder_path)); } catch { return []; } })(),
    notifySite: u.notify_site,
    notifyDevice: u.notify_device,
    role: u.role,
    dashboardAdmin: isDashboardAdmin(u),
    ...retentionInfo(u),
    subscription: subscriptionInfo(u),
    mqtt: mqttClientConfig(u),
  });
});

/* ---------- Admin: quản lý người dùng & phân quyền ---------- */
const adminOnly = [requireAuth, requireAdmin];
const adminWrite = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_ADMIN || 30),
  keyFn: (req) => `${clientIp(req)}:admin:${req.user?.id || 'na'}`,
});

app.get('/api/admin/users', ...adminOnly, (_req, res) => {
  res.json({ roles: ROLES, scopes: MONITOR_SCOPES, users: listUsers(db) });
});

app.post('/api/admin/users', ...adminOnly, adminWrite, reauth, (req, res) => {
  send(res, createUser(db, req.user, req.body || {}, { dataDir: DATA_DIR, webappSrc: WEBAPP_SRC, ip: ipOf(req) }));
});

app.patch('/api/admin/users/:id', ...adminOnly, adminWrite, reauth, (req, res) => {
  send(res, updateUser(db, req.user, Number(req.params.id), req.body || {}, { ip: ipOf(req) }));
});

app.delete('/api/admin/users/:id', ...adminOnly, adminWrite, reauth, (req, res) => {
  send(res, deleteUser(db, req.user, Number(req.params.id), { ip: ipOf(req) }));
});

/* ---------- Điều khiển: step-up (Passkey / TOTP), PC trạm, nút vật lý ---------- */
mountPlcControl(app, { db, requireAuth, security: controlApi });
/* ---------- Nhà máy tự phục vụ: nhận thiết bị, mời thành viên, ghép PC ---------- */
mountSite(app, { db, requireAuth, reauth });
/* ---------- Nền tảng đa tenant: admin tenants + partner API (MQTTS provision) ---------- */
mountPartnerRoutes(app, { db, requireAuth, reauth });
/* ---------- Console vận hành: gói / thiết bị / DB ---------- */
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
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`SHELL_DIR=${SHELL_DIR}`);
  startTelegramBot(db);
  startControlPublisher();
  startBundleSync(db, { dataDir: DATA_DIR, shellDir: SHELL_DIR });
  startMqttIngest(db);
  startHistoryPurge(db);
});
