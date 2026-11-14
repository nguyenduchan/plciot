/**
 * Kênh chat hỗ trợ giữa người dùng và quản trị viên (hỏi về nâng gói, sự cố…).
 *
 * RÀNG BUỘC PHÁP LÝ (docs/CHAT-COMPLIANCE.md) — giữ nguyên để không thành "website thương mại điện tử bán hàng":
 *  - Chỉ tin nhắn VĂN BẢN thuần. Không nút đặt/mua gói, không giỏ hàng, không tạo đơn, không bảng giá trong chat.
 *  - Không tích hợp cổng thanh toán, không sinh link/QR thanh toán, không ghi nhận thanh toán trong hệ thống.
 *  - Thỏa thuận giá + chuyển khoản làm thủ công giữa người với người ngoài hệ thống; admin tự gán gói sau khi nhận tiền.
 *  - Phía máy chủ không có endpoint nào tạo đơn/thanh toán từ chat; giao diện hiển thị bằng textContent (không tự biến chữ thành link/nút).
 */
import express from 'express';
import { rateLimit, clientIp, audit } from '@plciot/security';
import { subscriptionInfo, grantPlan, listPlans, PLAN_CATALOG } from './entitlements.js';

const MAX_LEN = 1000;
const DAILY_CAP = Number(process.env.SUPPORT_DAILY_CAP || 100);

export function initSupport(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      from_admin INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL,
      ts INTEGER NOT NULL,
      read_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_support_user ON support_messages(user_id, id);
    CREATE TABLE IF NOT EXISTS support_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  const cols = db.prepare('PRAGMA table_info(support_messages)').all().map((c) => c.name);
  if (!cols.includes('image_id')) db.exec('ALTER TABLE support_messages ADD COLUMN image_id INTEGER');
  // Gợi ý gói người dùng muốn được tư vấn (chỉ để admin chọn sẵn trong ô chọn; KHÔNG phải đơn hàng, không có trạng thái xử lý)
  if (!cols.includes('plan_hint')) db.exec('ALTER TABLE support_messages ADD COLUMN plan_hint TEXT');
  const days = Math.max(1, Number(process.env.SUPPORT_RETENTION_DAYS || 365));
  const purge = () => {
    try {
      const cutoff = Date.now() - days * 86400_000;
      db.prepare('DELETE FROM support_messages WHERE ts < ?').run(cutoff);
      db.prepare('DELETE FROM support_images WHERE ts < ?').run(cutoff);
    } catch (e) { console.error('support purge', e.message); }
  };
  purge();
  setInterval(purge, 3600_000).unref?.();
}

/** Chuẩn hoá nội dung: chuỗi văn bản, bỏ ký tự điều khiển, 1..1000 ký tự. Trả null nếu rỗng. */
export function cleanBody(raw) {
  const s = String(raw ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').trim();
  if (!s) return null;
  return s.slice(0, MAX_LEN);
}

const view = (m) => ({ id: m.id, from: m.from_admin ? 'admin' : 'user', body: m.body, ts: m.ts, image: m.image_id || null });

/* Ảnh chụp màn hình: chỉ JPEG/PNG (kiểm byte đầu tệp), tối đa 2 MB; client đã thu nhỏ + xoá EXIF bằng canvas. */
const IMG_MAX = Number(process.env.SUPPORT_IMAGE_MAX_BYTES || 2 * 1024 * 1024);
const IMG_DAILY_USER = Number(process.env.SUPPORT_IMAGE_DAILY || 20);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function imageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  return null;
}
const rawImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: IMG_MAX });

export function mountSupport(app, { db, requireAuth, requireAdmin }) {
  const ipOf = clientIp;
  const sendLimit = rateLimit({ windowMs: 60_000, max: 8, keyFn: (req) => `${ipOf(req)}:support:${req.user?.id || 'na'}` });
  const adminSendLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => `${ipOf(req)}:support-admin:${req.user?.id || 'na'}` });

  /* ---------------- người dùng ---------------- */
  app.get('/api/support/messages', requireAuth, (req, res) => {
    const after = Math.max(0, Number(req.query.after) || 0);
    const rows = db.prepare('SELECT * FROM support_messages WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 200').all(req.user.id, after);
    if (String(req.query.read) === '1') {
      db.prepare('UPDATE support_messages SET read_ts = ? WHERE user_id = ? AND from_admin = 1 AND read_ts IS NULL').run(Date.now(), req.user.id);
    }
    res.json({ messages: rows.map(view) });
  });

  app.get('/api/support/unread', requireAuth, (req, res) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND from_admin = 1 AND read_ts IS NULL').get(req.user.id).n;
    res.json({ unread: n });
  });

  app.post('/api/support/messages', requireAuth, sendLimit, (req, res) => {
    const body = cleanBody(req.body?.body);
    if (!body) return res.status(400).json({ error: 'empty_message' });
    const today = db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND from_admin = 0 AND ts > ?').get(req.user.id, Date.now() - 86400_000).n;
    if (today >= DAILY_CAP) return res.status(429).json({ error: 'rate_limited' });
    const hint = PLAN_CATALOG[String(req.body?.plan || '')] ? String(req.body.plan) : null;
    const r = db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts, plan_hint) VALUES (?, 0, ?, ?, ?)').run(req.user.id, body, Date.now(), hint);
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });

  /* ---------------- quản trị viên (đường dẫn /api/admin/* nên chịu cổng tên miền + phiên admin) ---------------- */
  const adminOnly = [requireAuth, requireAdmin];

  app.get('/api/admin/support/threads', ...adminOnly, (_req, res) => {
    const rows = db.prepare(`
      SELECT u.id AS user_id, u.username, u.role,
             (SELECT body FROM support_messages WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS last_body,
             (SELECT ts FROM support_messages WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS last_ts,
             (SELECT from_admin FROM support_messages WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS last_from_admin,
             (SELECT COUNT(*) FROM support_messages WHERE user_id = u.id AND from_admin = 0 AND read_ts IS NULL) AS unread
      FROM users u
      WHERE EXISTS (SELECT 1 FROM support_messages WHERE user_id = u.id)
      ORDER BY last_ts DESC LIMIT 200`).all();
    res.json({
      threads: rows.map((r) => {
        const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
        let plan = null;
        try { plan = subscriptionInfo(u)?.planLabel || null; } catch { /* */ }
        return { userId: r.user_id, username: r.username, plan, lastBody: String(r.last_body || '📷 Ảnh').slice(0, 120), lastTs: r.last_ts, lastFromAdmin: Boolean(r.last_from_admin), unread: r.unread };
      }),
      unread: rows.reduce((a, r) => a + r.unread, 0),
    });
  });

  app.get('/api/admin/support/threads/:uid', ...adminOnly, (req, res) => {
    const uid = Number(req.params.uid);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    const after = Math.max(0, Number(req.query.after) || 0);
    const rows = db.prepare('SELECT * FROM support_messages WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 200').all(uid, after);
    db.prepare('UPDATE support_messages SET read_ts = ? WHERE user_id = ? AND from_admin = 0 AND read_ts IS NULL').run(Date.now(), uid);
    let plan = null;
    try { plan = subscriptionInfo(u)?.planLabel || null; } catch { /* */ }
    const asked = db.prepare('SELECT plan_hint FROM support_messages WHERE user_id = ? AND from_admin = 0 AND plan_hint IS NOT NULL ORDER BY id DESC LIMIT 1').get(uid);
    res.json({
      userId: uid, username: u.username, plan, planId: subscriptionInfo(u)?.plan || null,
      requestedPlan: asked?.plan_hint || null,
      plans: listPlans().map((p) => ({ id: p.id, label: p.label })),
      messages: rows.map(view),
    });
  });

  /* Đồng ý / Từ chối yêu cầu tư vấn đổi gói. Đồng ý = admin gán gói THỦ CÔNG (như Console) + nhắn xác nhận bằng chữ.
     Từ chối = nhắn lý do bằng chữ. Không lưu "đơn hàng", không có trạng thái thanh toán. */
  const say = (uid, text) => db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts) VALUES (?, 1, ?, ?)').run(uid, text, Date.now());

  app.post('/api/admin/support/threads/:uid/approve', ...adminOnly, adminSendLimit, (req, res) => {
    const uid = Number(req.params.uid);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    const planId = String(req.body?.plan || '');
    if (!PLAN_CATALOG[planId]) return res.status(400).json({ error: 'unknown_plan' });
    const r = grantPlan(db, uid, planId, { expiresAt: req.body?.expiresAt || 'never', note: 'via_support_chat' });
    if (r.error) return res.status(r.status || 400).json(r);
    audit(db, 'admin_plan_grant', { userId: req.user.id, ip: ipOf(req), detail: `${uid} ${planId} never via_chat` });
    say(uid, `Quản trị viên đã đồng ý và chuyển tài khoản của bạn sang gói "${PLAN_CATALOG[planId].label}". Bạn tải lại ứng dụng là dùng được ngay, không cần đăng nhập lại.`);
    res.json({ ok: true, subscription: r.subscription });
  });

  app.post('/api/admin/support/threads/:uid/decline', ...adminOnly, adminSendLimit, (req, res) => {
    const uid = Number(req.params.uid);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return res.status(404).json({ error: 'user_not_found' });
    const reason = cleanBody(req.body?.reason)?.slice(0, 300);
    say(uid, `Quản trị viên chưa thể chuyển gói theo yêu cầu của bạn lúc này.${reason ? ` Lý do: ${reason}` : ''} Bạn có thể nhắn thêm tại đây nếu cần trao đổi.`);
    audit(db, 'support_decline', { userId: req.user.id, ip: ipOf(req), detail: `to:${uid}` });
    res.json({ ok: true });
  });

  app.post('/api/admin/support/threads/:uid', ...adminOnly, adminSendLimit, (req, res) => {
    const uid = Number(req.params.uid);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return res.status(404).json({ error: 'user_not_found' });
    const body = cleanBody(req.body?.body);
    if (!body) return res.status(400).json({ error: 'empty_message' });
    const r = db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts) VALUES (?, 1, ?, ?)').run(uid, body, Date.now());
    audit(db, 'support_reply', { userId: req.user.id, ip: ipOf(req), detail: `to:${uid}` });
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });

  /* ---------------- ảnh chụp màn hình ---------------- */
  /** Lưu ảnh + tin nhắn kèm theo. Trả { status, json }. */
  function saveImage(req, userId, fromAdmin, dailyCap) {
    const buf = req.body;
    const mime = imageMime(buf);
    if (!mime) return { status: 400, json: { error: 'bad_image' } };
    const caption = cleanBody(req.query.caption) || '';
    const used = db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND from_admin = ? AND image_id IS NOT NULL AND ts > ?')
      .get(userId, fromAdmin, Date.now() - 86400_000).n;
    if (used >= dailyCap) return { status: 429, json: { error: 'rate_limited' } };
    const now = Date.now();
    const img = db.prepare('INSERT INTO support_images (user_id, mime, data, ts) VALUES (?, ?, ?, ?)').run(userId, mime, buf, now);
    const r = db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts, image_id) VALUES (?, ?, ?, ?, ?)')
      .run(userId, fromAdmin, caption, now, Number(img.lastInsertRowid));
    return { status: 200, json: { ok: true, id: Number(r.lastInsertRowid), image: Number(img.lastInsertRowid) } };
  }
  function sendImage(res, row) {
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.set({ 'Content-Type': row.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline' });
    return res.send(row.data);
  }
  const imgLimit = rateLimit({ windowMs: 60_000, max: 6, keyFn: (req) => `${ipOf(req)}:support-img:${req.user?.id || 'na'}` });

  app.post('/api/support/images', requireAuth, imgLimit, rawImage, (req, res) => {
    const r = saveImage(req, req.user.id, 0, IMG_DAILY_USER);
    res.status(r.status).json(r.json);
  });
  // Người dùng chỉ xem được ảnh của chính mình (ảnh thuộc cuộc trò chuyện của họ).
  app.get('/api/support/images/:id', requireAuth, (req, res) => {
    sendImage(res, db.prepare('SELECT mime, data FROM support_images WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id));
  });
  app.post('/api/admin/support/threads/:uid/image', ...adminOnly, imgLimit, rawImage, (req, res) => {
    const uid = Number(req.params.uid);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return res.status(404).json({ error: 'user_not_found' });
    const r = saveImage(req, uid, 1, 200);
    if (r.status === 200) audit(db, 'support_reply', { userId: req.user.id, ip: ipOf(req), detail: `to:${uid}:image` });
    res.status(r.status).json(r.json);
  });
  app.get('/api/admin/support/images/:id', ...adminOnly, (req, res) => {
    sendImage(res, db.prepare('SELECT mime, data FROM support_images WHERE id = ?').get(Number(req.params.id)));
  });

  // Tìm người dùng để mở cuộc trò chuyện mới (admin chủ động nhắn).
  app.get('/api/admin/support/users', ...adminOnly, (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 48);
    const rows = db.prepare("SELECT id, username FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 20").all(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    res.json({ users: rows.map((r) => ({ userId: r.id, username: r.username })) });
  });
}
