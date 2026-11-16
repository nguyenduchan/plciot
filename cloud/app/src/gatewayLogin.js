/**
 * Đăng nhập cho app C# (GatewayApp / GatewayAdmin) bằng DUYỆT QUA TRÌNH DUYỆT (kiểu "device code"):
 *
 *  1. App gọi POST /api/v1/gateway/login/start → nhận { deviceCode (bí mật, chỉ app giữ), userCode `XXXX-XXXX`, verifyUrl }.
 *  2. Người dùng mở verifyUrl trên webapp (đã đăng nhập đầy đủ: Face ID / TOTP như bình thường), đối chiếu mã rồi bấm Duyệt
 *     → POST /api/v1/gateway/login/approve (cần phiên webapp hợp lệ).
 *  3. App hỏi POST /api/v1/gateway/login/poll { deviceCode } → khi đã duyệt nhận MỘT token đăng ký ngắn hạn (scope riêng
 *     `gateway_register`, không dùng được làm phiên webapp), chỉ đủ để gọi POST /api/v1/gateway/register.
 *  4. App ký bằng khoá riêng của gateway rồi gọi register: server cấp tem + MQTT trong hạn mức của tài khoản.
 *
 * App C# không bao giờ cầm mật khẩu / passkey / TOTP của người dùng. Không có cửa vào ẩn danh nào tạo được tem.
 * Chống lạm dụng: giới hạn tốc độ theo IP + dải mạng; trần số phiên đăng nhập đang mở toàn cục; deviceCode chỉ lưu băm;
 * userCode hết hạn 10 phút, dùng một lần; poll quá nhanh bị 429 (`slow_down`).
 */
import crypto from 'node:crypto';
import { rateLimit, clientIp, signToken, verifyToken, audit } from '@plciot/security';
import { subnetOf } from './gatewayEnroll.js';
import { registerForUser } from './gatewayPairing.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const TTL_MS = 10 * 60_000;
const POLL_MIN_MS = 2_000;
const REG_TOKEN_SEC = 30 * 60;
const MAX_OPEN = Number(process.env.GATEWAY_LOGIN_MAX_OPEN || 300);
const sha = (s) => crypto.createHash('sha256').update(`gwlogin:${s}`).digest('hex');
const fmt = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
export const normalizeUserCode = (raw) => {
  const c = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(c) ? c : null;
};

export function migrateGatewayLogins(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_logins (
      id TEXT PRIMARY KEY,
      device_hash TEXT NOT NULL UNIQUE,
      user_code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      user_id INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_poll INTEGER NOT NULL DEFAULT 0,
      ip TEXT
    );
  `);
}

export function mountGatewayLogin(app, { db, requireAuth, jwtSecret, publicUrl }) {
  migrateGatewayLogins(db);
  const sweep = () => db.prepare('DELETE FROM gateway_logins WHERE expires_at < ?').run(Date.now() - 3600_000);

  const ipLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_GATEWAY_LOGIN || 10), keyFn: (req) => `${clientIp(req)}:gw-login` });
  const netLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_GATEWAY_LOGIN_NET || 40), keyFn: (req) => `${subnetOf(clientIp(req))}:gw-login-net` });
  const pollLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_GATEWAY_LOGIN_POLL || 60), keyFn: (req) => `${clientIp(req)}:gw-login-poll` });
  const approveLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_GATEWAY_LOGIN_APPROVE || 10), keyFn: (req) => `${clientIp(req)}:gw-login-approve` });
  const regLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_GATEWAY_REGISTER_USER || 6), keyFn: (req) => `${clientIp(req)}:gw-register` });

  app.post('/api/v1/gateway/login/start', ipLimit, netLimit, (req, res) => {
    sweep();
    const now = Date.now();
    const open = db.prepare("SELECT COUNT(*) AS n FROM gateway_logins WHERE status = 'pending' AND expires_at > ?").get(now).n;
    if (open >= MAX_OPEN) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'rate_limited' }); }
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    for (let i = 0; i < 5; i++) {
      let code = '';
      for (let k = 0; k < 8; k++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
      try {
        db.prepare("INSERT INTO gateway_logins (id, device_hash, user_code, status, created_at, expires_at, ip) VALUES (?, ?, ?, 'pending', ?, ?, ?)")
          .run(`gl_${crypto.randomBytes(6).toString('hex')}`, sha(deviceCode), code, now, now + TTL_MS, clientIp(req));
        const base = String(publicUrl || '').replace(/\/$/, '');
        return res.json({
          deviceCode, userCode: fmt(code), expiresIn: TTL_MS / 1000, interval: 3,
          verifyUrl: `${base}/gateway-login.html?code=${fmt(code)}`,
        });
      } catch { /* trùng mã (hiếm) → sinh lại */ }
    }
    res.status(500).json({ error: 'login_failed' });
  });

  app.post('/api/v1/gateway/login/poll', pollLimit, (req, res) => {
    const dc = String(req.body?.deviceCode ?? '');
    if (dc.length < 20 || dc.length > 100) return res.status(400).json({ error: 'invalid_request' });
    const row = db.prepare('SELECT * FROM gateway_logins WHERE device_hash = ?').get(sha(dc));
    if (!row) return res.status(404).json({ error: 'invalid_login' });
    const now = Date.now();
    if (row.expires_at < now || row.status === 'used' || row.status === 'denied') return res.status(410).json({ error: row.status === 'denied' ? 'denied' : 'expired' });
    if (now - row.last_poll < POLL_MIN_MS) return res.status(429).json({ error: 'slow_down' });
    db.prepare('UPDATE gateway_logins SET last_poll = ? WHERE id = ?').run(now, row.id);
    if (row.status !== 'approved') return res.json({ status: 'pending' });
    // Đổi trạng thái nguyên tử: token chỉ trao MỘT lần
    const used = db.prepare("UPDATE gateway_logins SET status = 'used' WHERE id = ? AND status = 'approved'").run(row.id).changes;
    if (!used) return res.status(410).json({ error: 'expired' });
    const user = db.prepare('SELECT id, username, token_version, disabled FROM users WHERE id = ?').get(row.user_id);
    if (!user || user.disabled) return res.status(403).json({ error: 'account_disabled' });
    const token = signToken({ uid: user.id, tv: user.token_version | 0, scope: 'gateway_register' }, jwtSecret, REG_TOKEN_SEC);
    audit(db, 'gateway_login_token', { userId: user.id, ip: clientIp(req), detail: row.id });
    res.json({ status: 'approved', token, expiresIn: REG_TOKEN_SEC, user: user.username, uid: user.id });
  });

  // Trang webapp gọi (cần phiên đăng nhập đầy đủ). GET xem trước mã, POST duyệt/từ chối.
  app.get('/api/v1/gateway/login/info', requireAuth, approveLimit, (req, res) => {
    const code = normalizeUserCode(req.query?.code);
    const row = code && db.prepare("SELECT created_at, expires_at, ip, status FROM gateway_logins WHERE user_code = ?").get(code);
    if (!row || row.status !== 'pending' || row.expires_at < Date.now()) return res.status(404).json({ error: 'invalid_login' });
    res.json({ ok: true, createdAt: row.created_at, expiresAt: row.expires_at, ip: row.ip });
  });

  app.post('/api/v1/gateway/login/approve', requireAuth, approveLimit, (req, res) => {
    const code = normalizeUserCode(req.body?.code);
    if (!code) return res.status(404).json({ error: 'invalid_login' });
    const approve = req.body?.approve !== false;
    const r = db.prepare("UPDATE gateway_logins SET status = ?, user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?")
      .run(approve ? 'approved' : 'denied', req.user.id, code, Date.now());
    if (!r.changes) return res.status(404).json({ error: 'invalid_login' });
    audit(db, approve ? 'gateway_login_approve' : 'gateway_login_deny', { userId: req.user.id, ip: clientIp(req) });
    res.json({ ok: true, approved: approve });
  });

  // Đăng ký gateway: token `gateway_register` (từ duyệt trình duyệt) + chữ ký khoá riêng của gateway
  app.post('/api/v1/gateway/register', regLimit, (req, res) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    let payload = null;
    try { payload = m ? verifyToken(m[1], jwtSecret) : null; } catch { payload = null; }
    if (!payload || payload.scope !== 'gateway_register' || !payload.uid) return res.status(401).json({ error: 'unauthorized' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user || user.disabled) return res.status(user?.disabled ? 403 : 401).json({ error: user?.disabled ? 'account_disabled' : 'unauthorized' });
    if ((payload.tv | 0) !== (user.token_version | 0)) return res.status(401).json({ error: 'session_revoked' });
    const r = registerForUser(db, user, req.body || {});
    if (r.ok) audit(db, 'gateway_register_user', { userId: user.id, ip: clientIp(req), detail: `${r.site}/${r.device}` });
    if (r.error) return res.status(r.status || 400).json(r);
    res.json(r);
  });
}
