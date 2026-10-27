import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { openDb, findUserById, findUserByPhone } from './db.js';
import { signToken, bearerUser, jwtTtlSeconds } from './auth.js';
import { resolveBundleRoot, safeJoin, listBundleFiles } from './bundle.js';
import { normalizePhone, isValidVnPhone, formatVnLocal } from './phone.js';
import {
  requestRegisterOtp, verifyRegisterOtp,
  requestLoginOtp, verifyLoginOtp,
} from './otp.js';
import { startTelegramBot } from './bot.js';
import { startMqttIngest, startHistoryPurge } from './mqttIngest.js';
import { telegramConfigured } from './telegram.js';
import { sharedPgConfigured } from './sharedTg.js';
import { queryTelemetry, queryEvents, historyStats } from './historyStore.js';
import { rateLimit, clientIp } from './rateLimit.js';
import { securityHeaders, buildCorsOptions } from './security.js';
import { mqttClientConfig, provisionUserMqtt } from './mqttProvision.js';
import {
  accountSecuritySummary, requestEmailVerify, verifyEmail, regenerateRecoveryCodes,
  startSelfChange, confirmSelfChange, cancelChange,
  startRecovery, confirmRecovery, recoveryStatus, startPlcChallenge, checkPlcChallenge,
  processDueChanges,
} from './accountSecurity.js';
import { audit } from './audit.js';
import { wipeOwnHistory } from './deviceTransfer.js';
import { isAdmin, userScopes } from './roles.js';
import { listUsers, createUser, updateUser, deleteUser, applyBootstrapAdmins, ROLES, MONITOR_SCOPES } from './adminUsers.js';
import { retentionInfo, retentionFloor, defaultDays } from './retention.js';
import { mountControl } from './controlRoutes.js';
import { mountSite } from './siteRoutes.js';
import { noteLogin } from './loginAlerts.js';

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

const db = openDb(DATA_DIR);
applyBootstrapAdmins(db);
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Cloudflare Tunnel / CF-Connecting-IP
app.use(securityHeaders);
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = buf; } })); // rawBody: chữ ký của PC nhà máy

// Global soft limit (per IP)
app.use('/api/', rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_API || 120) }));

const authStrict = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_AUTH || 10),
  keyFn: (req) => `${clientIp(req)}:auth`,
});
const otpStrict = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_OTP || 5),
  keyFn: (req) => {
    const phone = normalizePhone(req.body?.phone || req.body?.username || '') || 'na';
    return `${clientIp(req)}:otp:${phone}`;
  },
});

// Sensitive account endpoints: tight per-IP + per-account budget.
const sensitiveStrict = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_SENSITIVE || 8),
  keyFn: (req) => `${clientIp(req)}:sens:${req.user?.id || normalizePhone(req.body?.oldPhone || '') || req.body?.id || 'na'}`,
});

function requireAuth(req, res, next) {
  const payload = bearerUser(req, JWT_SECRET);
  if (!payload?.uid) return res.status(401).json({ error: 'unauthorized' });
  const user = findUserById(db, payload.uid);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  // token_version bumps on phone change/recovery: every older session is revoked.
  if ((payload.tv | 0) !== (user.token_version | 0)) return res.status(401).json({ error: 'session_revoked' });
  if (user.disabled) return res.status(403).json({ error: 'account_disabled' });
  req.user = user;
  req.tokenPayload = payload;
  // gia hạn trượt: quá nửa hạn thì cấp token mới qua header (webapp/session.js tự cập nhật)
  if (payload.iat && Date.now() / 1000 - payload.iat > jwtTtlSeconds() / 2) {
    res.setHeader('X-Renewed-Token', signToken({ uid: user.id, u: user.username, tv: user.token_version | 0 }, JWT_SECRET));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'forbidden' });
  next();
}

const registrationOpen = () => String(process.env.REGISTRATION_OPEN || 'true').toLowerCase() !== 'false';

function loginPayload(user) {
  let bundleRoot;
  try {
    bundleRoot = resolveBundleRoot(DATA_DIR, user.folder_path);
  } catch {
    return { error: 'bad_folder_path', status: 500 };
  }
  if (!fs.existsSync(bundleRoot)) return { error: 'bundle_missing', status: 500 };
  const files = listBundleFiles(bundleRoot);
  const token = signToken({ uid: user.id, u: user.username, tv: user.token_version | 0 }, JWT_SECRET);
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
    token,
    userId: u.id,
    username: u.username,
    version: u.version,
    files,
    mqtt: mqttClientConfig(u),
    notifySite: u.notify_site,
    notifyDevice: u.notify_device,
    role: u.role,
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/config', (_req, res) => {
  res.json({
    telegram: telegramConfigured(),
    botUsername: BOT_USERNAME || null,
    botLink: BOT_USERNAME ? `https://t.me/${BOT_USERNAME.replace(/^@/, '')}` : null,
    sharedBot: sharedPgConfigured()
      || String(process.env.TELEGRAM_BOT_POLLING || 'false').toLowerCase() !== 'true',
  });
});

app.post('/api/register/request-otp', authStrict, otpStrict, async (req, res) => {
  if (!registrationOpen()) return res.status(403).json({ error: 'registration_closed' });
  const phone = String(req.body?.phone || req.body?.username || '');
  const result = await requestRegisterOtp(db, { phone, dataDir: DATA_DIR, webappSrc: WEBAPP_SRC });
  if (result.error) return res.status(result.status || 400).json(result);
  res.json(result);
});

app.post('/api/register/verify', authStrict, otpStrict, async (req, res) => {
  if (!registrationOpen()) return res.status(403).json({ error: 'registration_closed' });
  const phone = String(req.body?.phone || req.body?.username || '');
  const otp = String(req.body?.otp || '');
  const result = await verifyRegisterOtp(db, { phone, otp, dataDir: DATA_DIR, webappSrc: WEBAPP_SRC });
  if (result.error) return res.status(result.status || 400).json(result);
  const out = loginPayload(result.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  noteLogin(db, result.user, { deviceId: req.headers['x-device-id'], ip: clientIp(req), method: 'đăng ký OTP' });
  res.json(out);
});

app.post('/api/login/request-otp', authStrict, otpStrict, async (req, res) => {
  const phone = String(req.body?.phone || req.body?.username || '');
  // Một cửa duy nhất: số đã có tài khoản → OTP đăng nhập; số mới → OTP tạo tài khoản (nếu đăng ký đang mở).
  const known = findUserByPhone(db, normalizePhone(phone));
  let result;
  if (known || !isValidVnPhone(phone)) {
    result = await requestLoginOtp(db, { phone });
    if (!result.error) result.purpose = 'login';
  } else {
    if (!registrationOpen()) return res.status(403).json({ error: 'registration_closed' });
    result = await requestRegisterOtp(db, { phone, dataDir: DATA_DIR, webappSrc: WEBAPP_SRC });
    if (!result.error) result.purpose = 'register';
  }
  if (result.error) return res.status(result.status || 400).json(result);
  res.json(result);
});

app.post('/api/login/verify-otp', authStrict, otpStrict, (req, res) => {
  const phone = String(req.body?.phone || req.body?.username || '');
  const otp = String(req.body?.otp || '');
  const result = verifyLoginOtp(db, { phone, otp });
  if (result.error) return res.status(result.status || 400).json(result);
  const out = loginPayload(result.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  noteLogin(db, result.user, { deviceId: req.headers['x-device-id'], ip: clientIp(req), method: 'OTP Telegram' });
  res.json(out);
});


/* ---------- Account security: email, recovery codes, change phone ---------- */
// Xác nhận lại danh tính cho thao tác nhạy cảm (thay cho "mật khẩu hiện tại"): phiên điều khiển (vân tay/TOTP) hoặc vừa đăng nhập.
let controlApi;
const reauth = (req, res, next) => controlApi.reauth(req, res, next);
const send = (res, out) => (out.error ? res.status(out.status || 400).json(out) : res.json(out));
const ipOf = (req) => clientIp(req);

app.get('/api/account/security', requireAuth, (req, res) => {
  res.json(accountSecuritySummary(db, req.user));
});

app.post('/api/account/email/request', requireAuth, sensitiveStrict, reauth, async (req, res) => {
  send(res, await requestEmailVerify(db, req.user, {
    email: req.body?.email, reauthed: req.reauthed, ip: ipOf(req),
  }));
});

app.post('/api/account/email/verify', requireAuth, sensitiveStrict, async (req, res) => {
  send(res, await verifyEmail(db, req.user, { otp: req.body?.otp, ip: ipOf(req) }));
});

app.post('/api/account/recovery-codes', requireAuth, sensitiveStrict, reauth, async (req, res) => {
  send(res, await regenerateRecoveryCodes(db, req.user, { reauthed: req.reauthed, ip: ipOf(req) }));
});

app.post('/api/account/data/wipe', requireAuth, sensitiveStrict, reauth, (req, res) => {
  send(res, wipeOwnHistory(db, req.user, { reauthed: req.reauthed, ip: ipOf(req) }));
});

app.post('/api/account/phone/start', requireAuth, sensitiveStrict, reauth, async (req, res) => {
  send(res, await startSelfChange(db, req.user, {
    newPhone: req.body?.newPhone,
    reauthed: req.reauthed,
    oldChannel: req.body?.oldChannel,
    ip: ipOf(req),
  }));
});

app.post('/api/account/phone/confirm', requireAuth, sensitiveStrict, async (req, res) => {
  const out = await confirmSelfChange(db, req.user, {
    id: req.body?.id,
    newOtp: req.body?.newOtp,
    oldOtp: req.body?.oldOtp,
    recoveryCode: req.body?.recoveryCode,
    ip: ipOf(req),
  });
  send(res, out);
});

app.post('/api/account/phone/cancel', requireAuth, sensitiveStrict, async (req, res) => {
  send(res, await cancelChange(db, String(req.body?.id || ''), { userId: req.user.id, ip: ipOf(req) }));
});

// One-click veto from the Telegram/email warning (no login: the owner may have lost the session).
app.get('/api/phone/cancel', authStrict, async (req, res) => {
  const out = await cancelChange(db, String(req.query.id || ''), { token: String(req.query.t || ''), ip: ipOf(req) });
  const msg = out.ok ? 'Đã huỷ yêu cầu đổi số điện thoại. Tài khoản của bạn không bị thay đổi.'
    : out.error === 'request_not_pending' ? 'Yêu cầu này đã được xử lý hoặc đã bị huỷ trước đó.'
      : 'Liên kết không hợp lệ.';
  res.status(out.ok ? 200 : (out.status || 400)).type('html').send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Huỷ yêu cầu</title><body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px">`
    + `<h2>${out.ok ? '✅' : '⚠️'} ${msg}</h2><p><a href="/login.html">Về trang đăng nhập</a></p>`,
  );
});

/* Recovery when the old phone/Telegram is gone (no session). */
app.post('/api/recovery/start', authStrict, sensitiveStrict, async (req, res) => {
  send(res, await startRecovery(db, {
    oldPhone: req.body?.oldPhone, newPhone: req.body?.newPhone, note: req.body?.note, ip: ipOf(req),
  }));
});

app.post('/api/recovery/confirm', authStrict, sensitiveStrict, async (req, res) => {
  send(res, await confirmRecovery(db, {
    id: String(req.body?.id || ''), newOtp: req.body?.newOtp, recoveryCode: req.body?.recoveryCode, ip: ipOf(req),
  }));
});

app.post('/api/recovery/status', authStrict, (req, res) => {
  send(res, recoveryStatus(db, String(req.body?.id || '')));
});

app.post('/api/recovery/plc/start', authStrict, sensitiveStrict, (req, res) => {
  send(res, startPlcChallenge(db, String(req.body?.id || '')));
});

app.post('/api/recovery/plc/check', authStrict, (req, res) => {
  send(res, checkPlcChallenge(db, String(req.body?.id || '')));
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
    notifySite: u.notify_site,
    notifyDevice: u.notify_device,
    role: u.role,
    ...retentionInfo(u),
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
controlApi = mountControl(app, { db, requireAuth, adminOnly, loginPayload, authStrict });
/* ---------- Nhà máy tự phục vụ: nhận thiết bị, mời thành viên, ghép PC ---------- */
mountSite(app, { db, requireAuth, reauth });

app.post('/api/logout', (_req, res) => {
  res.json({ ok: true });
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
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache');
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
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`plciot app listening on :${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`SHELL_DIR=${SHELL_DIR}`);
  startTelegramBot(db);
  startMqttIngest(db);
  startHistoryPurge(db);
  const tick = () => processDueChanges(db).catch((e) => console.error('processDueChanges', e.message));
  tick();
  setInterval(tick, 60_000).unref?.();
});
