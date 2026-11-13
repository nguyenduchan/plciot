/**
 * Web Push (VAPID) — cảnh báo nguy hiểm tới điện thoại, KHÔNG lưu số điện thoại / email.
 *
 * Server chỉ lưu bộ ba ẩn danh của trình duyệt: endpoint + p256dh + auth, gắn với user_id (tên đăng nhập ẩn danh).
 * Không lưu IP, user-agent hay bất cứ định danh cá nhân nào. Nội dung push được mã hoá đầu cuối tới thiết bị.
 * Khoá VAPID: env VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY, hoặc tự sinh một lần và lưu DATA_DIR/vapid.json.
 * VAPID subject dùng URL của app (https), không dùng email.
 */
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const MAX_SUBS_PER_USER = Number(process.env.PUSH_MAX_SUBS || 5);
// Chỉ gửi tới push service đã biết (chống SSRF: endpoint do client cung cấp)
const DEFAULT_HOSTS = [
  /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[\w-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/, /^[\w.-]+\.push\.apple\.com$/, /\.notify\.windows\.com$/, /^updates-autopush\.[\w.-]+\.mozaws\.net$/,
];

let sender = (sub, body, opts) => webpush.sendNotification(sub, body, opts);
/** Cho test: thay hàm gửi thật. */
export function setPushSender(fn) { sender = fn || ((sub, body, opts) => webpush.sendNotification(sub, body, opts)); }

export function initPushTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs(user_id);
  `);
}

let vapidReady = null;
export function loadVapid(dataDir) {
  if (vapidReady) return vapidReady;
  let pub = process.env.VAPID_PUBLIC_KEY || '';
  let priv = process.env.VAPID_PRIVATE_KEY || '';
  if (!pub || !priv) {
    const f = path.join(dataDir || process.env.DATA_DIR || './data', 'vapid.json');
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      pub = j.publicKey; priv = j.privateKey;
    } catch {
      const k = webpush.generateVAPIDKeys();
      pub = k.publicKey; priv = k.privateKey;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ publicKey: pub, privateKey: priv }), { mode: 0o600 });
    }
  }
  let subject = process.env.VAPID_SUBJECT || process.env.WEBAPP_PUBLIC_URL || '';
  if (!/^(https:\/\/|mailto:)/.test(subject)) subject = 'https://plc.dieukhientudong.net';   // dev http://localhost không hợp lệ cho VAPID
  webpush.setVapidDetails(subject, pub, priv);
  vapidReady = { publicKey: pub };
  return vapidReady;
}

export function endpointAllowed(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const extra = String(process.env.PUSH_ENDPOINT_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return DEFAULT_HOSTS.some((re) => re.test(u.hostname)) || extra.includes(u.hostname);
}

const b64u = /^[A-Za-z0-9_-]{16,200}$/;

export function saveSubscription(db, userId, sub) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (endpoint.length > 600 || !endpointAllowed(endpoint)) return { error: 'invalid_endpoint', status: 400 };
  if (!b64u.test(p256dh) || !b64u.test(auth)) return { error: 'invalid_keys', status: 400 };
  const own = db.prepare('SELECT user_id FROM push_subs WHERE endpoint = ?').get(endpoint);
  if (own) {
    db.prepare('UPDATE push_subs SET user_id = ?, p256dh = ?, auth = ? WHERE endpoint = ?').run(userId, p256dh, auth, endpoint);
    return { ok: true, updated: true };
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(userId).n;
  if (n >= MAX_SUBS_PER_USER) {
    // bỏ đăng ký cũ nhất thay vì từ chối
    db.prepare('DELETE FROM push_subs WHERE id = (SELECT id FROM push_subs WHERE user_id = ? ORDER BY id LIMIT 1)').run(userId);
  }
  db.prepare('INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, endpoint, p256dh, auth, Date.now());
  return { ok: true };
}

export function removeSubscription(db, userId, endpoint) {
  const r = db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || ''));
  return { ok: true, removed: r.changes };
}

/** Gửi tới mọi thiết bị đã đăng ký của một user. Tự xoá đăng ký đã chết (404/410). */
export async function pushToUser(db, userId, payload) {
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').all(userId);
  const body = JSON.stringify(payload);
  let sent = 0; let failed = 0;
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600, urgency: 'high', timeout: 8000 });
      sent += 1;
    } catch (e) {
      failed += 1;
      if (e?.statusCode === 404 || e?.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
      else console.error('push send', e?.statusCode || e?.message);
    }
  }
  return { sent, failed };
}

/** Chủ / người dùng của một gateway (cùng cách xác định với syncUserDevices). */
export function usersOfGateway(db, site, device) {
  return db.prepare(`SELECT DISTINCT u.id FROM users u WHERE u.disabled = 0 AND (
      (u.notify_site = ? AND u.notify_device = ?)
      OR u.id IN (SELECT claimed_by FROM hardware_devices WHERE site = ? AND device = ? AND claimed_by IS NOT NULL)
      OR u.id IN (SELECT user_id FROM user_devices WHERE site = ? AND gateway_device = ?))
    AND u.id IN (SELECT user_id FROM push_subs)`).all(site, device, site, device, site, device).map((r) => r.id);
}

export async function pushToGatewayUsers(db, site, device, payload) {
  let sent = 0;
  for (const id of usersOfGateway(db, site, device)) sent += (await pushToUser(db, id, payload)).sent;
  return sent;
}

export function mountPush(app, { db, requireAuth, dataDir }) {
  const vapid = loadVapid(dataDir);
  const lastTest = new Map();

  app.get('/api/push/key', requireAuth, (_req, res) => res.json({ publicKey: vapid.publicKey }));

  app.get('/api/push/status', requireAuth, (req, res) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(req.user.id).n;
    res.json({ devices: n });
  });

  app.post('/api/push/subscribe', requireAuth, (req, res) => {
    const r = saveSubscription(db, req.user.id, req.body?.subscription);
    res.status(r.error ? r.status : 200).json(r);
  });

  app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
    res.json(removeSubscription(db, req.user.id, req.body?.endpoint));
  });

  app.post('/api/push/test', requireAuth, async (req, res) => {
    const now = Date.now();
    if (now - (lastTest.get(req.user.id) || 0) < 10_000) return res.status(429).json({ error: 'rate_limited' });
    lastTest.set(req.user.id, now);
    const r = await pushToUser(db, req.user.id, { t: 'Thông báo thử', b: 'Cảnh báo nguy hiểm sẽ hiện như thế này.', tag: 'test', url: '/' });
    res.json({ ok: true, ...r });
  });
}
