/**
 * Trang admin RIÊNG trên tên miền riêng (ADMIN_HOST, vd. admin.plc.dieukhientudong.net).
 *
 * - Cổng theo tên miền: tên miền admin chỉ phục vụ trang admin + API admin; tên miền app (plc.…) KHÔNG phục vụ trang/API admin.
 *   Đường hầm SSH (kết nối trực tiếp, không header proxy) vẫn vào được như cũ.
 * - Đăng nhập riêng: tên đăng nhập + mật khẩu + mã Authenticator (TOTP). Lần đầu chưa có TOTP thì bắt buộc đăng ký ngay
 *   (ADMIN_REQUIRE_TOTP=false để chỉ dùng mật khẩu). Phiên admin tách khỏi phiên app: token của app không dùng được ở đây.
 * - Cài đặt: đổi mật khẩu, đổi Authenticator, xem/ngắt phiên, nhật ký đăng nhập admin, trạng thái các cờ bảo mật.
 */
import {
  hashPassword, verifyPassword, signToken, verifyToken, createAppSession, findUserByUsername, countAudit, audit, clientIp,
  rateLimit, generateSecret, otpauthUri, verifyTotp, sealSecret, openSecret,
} from '@plciot/security';
import { isDashboardAdmin } from './roles.js';
import { isDirectLocal, isAdminLocalRequest, isInternetAdminUser } from './adminGate.js';

const env = (k, d = '') => String(process.env[k] ?? d);
const truthy = (v) => String(v).toLowerCase() === 'true';

export const adminHost = () => env('ADMIN_HOST').trim().toLowerCase();
const requireTotp = () => !['false', '0', 'no'].includes(env('ADMIN_REQUIRE_TOTP', 'true').toLowerCase());
const sessionSeconds = () => Math.max(1, Number(env('ADMIN_SESSION_HOURS', '8'))) * 3600;
export const ADMIN_DEVICE = 'admin-site';
const FAIL_EVENT = 'admin_login_fail';
const LOCK_FAILS = 5;
const LOCK_WINDOW = 15 * 60_000;

const hostOf = (req) => String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');

/** Trang tĩnh chỉ có trên tên miền admin. */
const ADMIN_PAGES = new Set([
  '/admin-login.html', '/admin-login.js', '/admin-settings.html', '/admin-settings.js',
  '/admin.html', '/admin.js', '/console.html', '/console.js', '/admin-nav.js', '/admin-chat.html', '/admin-chat.js',
]);
/** Tệp dùng chung mà trang admin cần (có trên cả hai tên miền). */
const SHARED_FILES = new Set([
  '/style.css', '/icon.svg', '/icon-180.png', '/icon-192.png', '/errors.js', '/control.js', '/plan.js', '/chat-image.js', '/favicon.ico',
]);
const ADMIN_API_PREFIXES = ['/api/admin-site/', '/api/admin/', '/api/health', '/api/me', '/api/logout', '/api/login/activity', '/api/control/'];

const isApi = (p) => p === '/api' || p.startsWith('/api/');
const apiAllowedOnAdminHost = (p) => ADMIN_API_PREFIXES.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));
const isAdminOnlyPath = (p) => ADMIN_PAGES.has(p) || p === '/api/admin' || p.startsWith('/api/admin/') || p.startsWith('/api/admin-site/');

/**
 * Đặt TRƯỚC mọi middleware khác. Chưa đặt ADMIN_HOST thì không làm gì (hành vi cũ: admin chung tên miền, chỉ SSH/CIDR).
 */
export function adminSiteGate(req, res, next) {
  const ah = adminHost();
  if (!ah) return next();
  const p = req.path;
  const nf = () => res.status(404).type('text/plain').send('Not found');
  if (hostOf(req) === ah) {
    if (p === '/') return res.redirect(302, '/admin-login.html');
    if (isApi(p)) return apiAllowedOnAdminHost(p) ? next() : nf();
    if (ADMIN_PAGES.has(p) || SHARED_FILES.has(p) || p.startsWith('/vendor/') || p.startsWith('/security/')) return next();
    return nf();
  }
  // Tên miền app: không phục vụ admin (trừ kết nối trực tiếp qua đường hầm SSH).
  if (isAdminOnlyPath(p) && !isDirectLocal(req)) return nf();
  next();
}

export function onAdminHost(req) {
  const ah = adminHost();
  return Boolean(ah) && hostOf(req) === ah;
}

const DUMMY_HASH = hashPassword('dummy-password-for-timing');

function weakPassword(pw, username) {
  const s = String(pw || '');
  if (s.length < 10 || s.length > 200) return true;
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return true;
  return username && s.toLowerCase().includes(String(username).toLowerCase());
}

export function mountAdminSite(app, { db, requireAuth, requireAdmin, jwtSecret }) {
  const ipOf = clientIp;
  const loginLimit = rateLimit({ windowMs: 60_000, max: Number(env('RATE_LIMIT_ADMIN_LOGIN', '10')), keyFn: (req) => `${ipOf(req)}:adminlogin` });
  const userLimit = rateLimit({ windowMs: 60_000, max: Number(env('RATE_LIMIT_ADMIN_LOGIN_USER', '6')), keyFn: (req) => `${ipOf(req)}:adminlogin:${String(req.body?.username || '').toLowerCase().slice(0, 48)}` });
  const err = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

  const userById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const failCount = (u) => countAudit(db, u.id, FAIL_EVENT, Date.now() - LOCK_WINDOW);

  /** Tài khoản này có được đăng nhập admin từ nơi gọi không (cùng quy tắc adminGate). */
  function eligible(user, req) {
    if (!user || user.disabled || !user.login_password_hash || user.setup_complete === 0) return false;
    if (!isDashboardAdmin(user)) return false;
    const restricted = Boolean(env('ADMIN_ONLY_CIDRS').trim());
    return !restricted || isAdminLocalRequest(req) || isInternetAdminUser(user);
  }

  /** Kiểm mã TOTP, chống phát lại + khoá khi sai nhiều. Trả null nếu đúng, ngược lại { status, error }. */
  function checkTotp(user, code, req, sealed = user.totp_secret, lastStep = user.totp_last_step | 0, persist = true) {
    if (failCount(user) >= LOCK_FAILS) return { status: 429, error: 'locked' };
    const secret = openSecret(sealed);
    const step = secret ? verifyTotp(secret, code, { lastStep }) : null;
    if (!step) {
      audit(db, FAIL_EVENT, { userId: user.id, ip: ipOf(req), detail: 'totp' });
      return { status: 401, error: 'totp_invalid' };
    }
    if (persist) db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
    return { step };
  }

  function issueSession(user, req, res, method) {
    const sid = createAppSession(db, user.id, ADMIN_DEVICE);
    const token = signToken({ uid: user.id, tv: user.token_version | 0, sid }, jwtSecret, sessionSeconds());
    audit(db, 'login_ok', { userId: user.id, ip: ipOf(req), detail: `admin-site:${method}` });
    return res.json({ token, username: user.username, expiresIn: sessionSeconds() });
  }

  const ticketFor = (user) => signToken({ uid: user.id, tv: user.token_version | 0, scope: 'admin_totp_setup' }, jwtSecret, 600);
  function userFromTicket(ticket) {
    try {
      const p = verifyToken(String(ticket || ''), jwtSecret);
      if (p.scope !== 'admin_totp_setup') return null;
      const u = userById(p.uid);
      return u && !u.disabled && (u.token_version | 0) === (p.tv | 0) ? u : null;
    } catch { return null; }
  }

  app.get('/api/admin-site/config', (_req, res) => res.json({ requireTotp: requireTotp() }));

  /* ---------------- đăng nhập ---------------- */
  app.post('/api/admin-site/login', loginLimit, userLimit, (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const code = String(req.body?.code || '').trim();
    const user = username ? findUserByUsername(db, username) : null;
    const ok = eligible(user, req);
    if (ok && failCount(user) >= LOCK_FAILS) return err(res, 429, 'locked');
    const match = verifyPassword(password, ok ? user.login_password_hash : DUMMY_HASH);
    if (!ok || !match) {
      if (user) audit(db, FAIL_EVENT, { userId: user.id, ip: ipOf(req), detail: 'password' });
      return err(res, 401, 'invalid_credentials');
    }
    if (user.totp_enabled) {
      if (!code) return err(res, 401, 'totp_required');
      const t = checkTotp(user, code, req);
      if (t.error) return err(res, t.status, t.error);
      return issueSession(user, req, res, 'password+totp');
    }
    if (requireTotp()) return res.json({ setupRequired: true, ticket: ticketFor(user) });
    return issueSession(user, req, res, 'password');
  });

  /* Đăng ký Authenticator lần đầu (sau khi đã đúng mật khẩu): vé 10 phút, chỉ dùng cho hai bước này. */
  app.post('/api/admin-site/totp/setup', loginLimit, (req, res) => {
    const user = userFromTicket(req.body?.ticket);
    if (!user) return err(res, 401, 'ticket_invalid');
    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(sealSecret(secret), user.id);
    res.json({ secret, uri: otpauthUri(secret, user.username, 'Admin PLC') });
  });

  app.post('/api/admin-site/totp/enable', loginLimit, (req, res) => {
    const user = userFromTicket(req.body?.ticket);
    if (!user) return err(res, 401, 'ticket_invalid');
    if (!user.totp_pending) return err(res, 400, 'totp_not_pending');
    const t = checkTotp(user, req.body?.code, req, user.totp_pending, 0, false);
    if (t.error) return err(res, t.status, t.error);
    db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(t.step, user.id);
    audit(db, 'totp_enabled', { userId: user.id, ip: ipOf(req), detail: 'admin-site' });
    issueSession(userById(user.id), req, res, 'totp-enrol');
  });

  /* ---------------- cần phiên admin-site (hoặc đường hầm SSH) ---------------- */
  const adminSession = [requireAuth, requireAdmin, (req, res, next) => {
    const sid = req.tokenPayload?.sid;
    const row = sid && db.prepare('SELECT device_id FROM app_sessions WHERE id = ? AND user_id = ?').get(sid, req.user.id);
    if (row && (row.device_id === ADMIN_DEVICE || row.device_id === 'ssh-local')) return next();
    return err(res, 401, 'admin_session_required');
  }];
  const write = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => `${ipOf(req)}:adminsite:${req.user?.id || 'na'}` });

  // Tên miền admin: /api/admin/* và /api/me chỉ dùng được với phiên admin-site (token đăng nhập của app không đủ).
  const runChain = (chain, req, res, done) => {
    let i = 0;
    const step = (e) => (e ? done(e) : i >= chain.length ? done() : chain[i++](req, res, step));
    step();
  };
  app.use(['/api/admin', '/api/me'], (req, res, next) => (onAdminHost(req) ? runChain(adminSession, req, res, next) : next()));

  app.get('/api/admin-site/me', ...adminSession, (req, res) => {
    const u = userById(req.user.id);
    const sessions = db.prepare('SELECT id, device_id, last_seen FROM app_sessions WHERE user_id = ? ORDER BY last_seen DESC LIMIT 20').all(u.id)
      .map((s) => ({ id: s.id.slice(0, 8), device: s.device_id, lastSeen: s.last_seen, current: s.id === req.tokenPayload.sid }));
    const history = db.prepare(
      "SELECT ts, event, ip, detail FROM audit_log WHERE user_id = ? AND event IN ('login_ok','admin_login_fail','admin_password_changed','admin_totp_changed','admin_sessions_revoked','totp_enabled') ORDER BY ts DESC LIMIT 30",
    ).all(u.id);
    res.json({
      username: u.username,
      totpEnabled: Boolean(u.totp_enabled),
      requireTotp: requireTotp(),
      sessions,
      history,
      server: {
        adminHost: adminHost() || null,
        sessionHours: sessionSeconds() / 3600,
        adminOnlyCidrs: env('ADMIN_ONLY_CIDRS') || null,
        adminInternetUsers: env('ADMIN_INTERNET_USERS') || null,
        reauthDisabled: truthy(env('REAUTH_DISABLED')),
        appLockDisabled: truthy(env('APP_LOCK_DISABLED')),
        sshLogin: truthy(env('ADMIN_SSH_LOGIN')),
      },
    });
  });

  /** Xác nhận lại bằng mật khẩu (+ TOTP nếu đã bật) trước thao tác nhạy cảm. Trả { status, error } nếu sai. */
  function confirm(user, body, req) {
    const fresh = userById(user.id);
    if (failCount(fresh) >= LOCK_FAILS) return { status: 429, error: 'locked' };
    if (!verifyPassword(String(body?.password || ''), fresh.login_password_hash)) {
      audit(db, FAIL_EVENT, { userId: fresh.id, ip: ipOf(req), detail: 'confirm' });
      return { status: 401, error: 'invalid_credentials' };
    }
    if (fresh.totp_enabled) {
      const t = checkTotp(fresh, body?.code, req);
      if (t.error) return t;
    }
    return null;
  }

  app.post('/api/admin-site/password', ...adminSession, write, (req, res) => {
    const bad = confirm(req.user, { password: req.body?.current, code: req.body?.code }, req);
    if (bad) return err(res, bad.status, bad.error);
    const next = String(req.body?.next || '');
    if (weakPassword(next, req.user.username)) return err(res, 400, 'password_weak');
    db.prepare('UPDATE users SET login_password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    // Đăng xuất mọi phiên khác (cả app) sau khi đổi mật khẩu
    db.prepare('DELETE FROM app_sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.tokenPayload.sid || '');
    audit(db, 'admin_password_changed', { userId: req.user.id, ip: ipOf(req) });
    res.json({ ok: true });
  });

  // Đổi Authenticator: xác nhận bằng mật khẩu + mã hiện tại → bí mật mới (pending) → nhập mã mới để bật.
  app.post('/api/admin-site/totp/change/start', ...adminSession, write, (req, res) => {
    const bad = confirm(req.user, req.body, req);
    if (bad) return err(res, bad.status, bad.error);
    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(sealSecret(secret), req.user.id);
    res.json({ secret, uri: otpauthUri(secret, req.user.username, 'Admin PLC') });
  });

  app.post('/api/admin-site/totp/change/finish', ...adminSession, write, (req, res) => {
    const u = userById(req.user.id);
    if (!u.totp_pending) return err(res, 400, 'totp_not_pending');
    const t = checkTotp(u, req.body?.code, req, u.totp_pending, 0, false);
    if (t.error) return err(res, t.status, t.error);
    db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(t.step, u.id);
    db.prepare('DELETE FROM app_sessions WHERE user_id = ? AND id != ?').run(u.id, req.tokenPayload.sid || '');
    audit(db, 'admin_totp_changed', { userId: u.id, ip: ipOf(req) });
    res.json({ ok: true });
  });

  app.post('/api/admin-site/sessions/revoke-others', ...adminSession, write, (req, res) => {
    const r = db.prepare('DELETE FROM app_sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.tokenPayload.sid || '');
    audit(db, 'admin_sessions_revoked', { userId: req.user.id, ip: ipOf(req), detail: String(r.changes) });
    res.json({ ok: true, revoked: r.changes });
  });
}
