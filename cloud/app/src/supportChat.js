/**
 * Kênh chat hỗ trợ giữa người dùng và quản trị viên (hỏi về nâng gói, hỗ trợ kỹ thuật, sự cố…).
 *
 * RÀNG BUỘC PHÁP LÝ (docs/CHAT-COMPLIANCE.md) — giữ nguyên để không thành "website thương mại điện tử bán hàng":
 *  - Chỉ tin nhắn VĂN BẢN thuần (+ ảnh chụp màn hình). Không nút đặt/mua gói, không giỏ hàng, không tạo đơn, không bảng giá trong chat.
 *  - Không tích hợp cổng thanh toán, không sinh link/QR thanh toán, không ghi nhận thanh toán trong hệ thống.
 *  - Thỏa thuận giá + chuyển khoản làm thủ công giữa người với người ngoài hệ thống; admin tự gán gói sau khi nhận tiền.
 *  - Phía máy chủ không có endpoint nào tạo đơn/thanh toán từ chat; giao diện hiển thị bằng textContent (không tự biến chữ thành link/nút).
 *
 * LƯU TRỮ & CHỐNG ĐẦY DB (docs/CHAT-COMPLIANCE.md):
 *  - support_messages: tối đa SUPPORT_MAX_MESSAGES tin gần nhất / người dùng (hiển thị mặc định).
 *  - support_archive : tin cũ hơn được CHUYỂN vào đây (không xoá), tối đa SUPPORT_ARCHIVE_MAX / người dùng.
 *  - Ảnh ở support_images: hạn dung lượng / người dùng, hạn toàn hệ thống, hạn tuổi riêng (SUPPORT_IMAGE_ARCHIVE_DAYS).
 *  - Chống spam: giới hạn tốc độ theo người dùng + IP + toàn cục, chặn tin trùng, cầu dao toàn cục.
 */
import express from 'express';
import { rateLimit, clientIp, audit } from '@plciot/security';
import { quotesForWidgets, pricingAssumptions } from './pricing.js';
import { listUserDevices } from './userDevices.js';
import { deviceToUiNode, applyWidgetLimit } from './uiContract.js';
import { subscriptionInfo, grantPlan, listPlans, planRank, PLAN_CATALOG, setRemoteControl } from './entitlements.js';
import { retentionInfo } from './retention.js';

const MAX_LEN = 1000;
const DAILY_CAP = Number(process.env.SUPPORT_DAILY_CAP || 100);
const MAX_PER_USER = Math.max(20, Number(process.env.SUPPORT_MAX_MESSAGES || 200));
const ARCHIVE_MAX = Math.max(MAX_PER_USER, Number(process.env.SUPPORT_ARCHIVE_MAX || 5000));
const USER_IMG_BYTES = Number(process.env.SUPPORT_USER_IMAGE_BYTES || 30 * 1024 * 1024);
const GLOBAL_IMG_BYTES = Number(process.env.SUPPORT_GLOBAL_IMAGE_BYTES || 1024 * 1024 * 1024);
const GLOBAL_MESSAGES = Number(process.env.SUPPORT_GLOBAL_MESSAGES || 300000);

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
    CREATE INDEX IF NOT EXISTS idx_support_images_user ON support_images(user_id);
    CREATE TABLE IF NOT EXISTS support_archive (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      from_admin INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL,
      ts INTEGER NOT NULL,
      image_id INTEGER,
      archived_ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_support_archive_user ON support_archive(user_id, id);
    -- Yêu cầu tư vấn đổi gói đang chờ admin (tối đa 1 / người dùng). KHÔNG phải đơn hàng: không giá, không thanh toán.
    CREATE TABLE IF NOT EXISTS support_requests (
      user_id INTEGER PRIMARY KEY,
      plan TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  const cols = db.prepare('PRAGMA table_info(support_messages)').all().map((c) => c.name);
  if (!cols.includes('image_id')) db.exec('ALTER TABLE support_messages ADD COLUMN image_id INTEGER');
  if (!cols.includes('plan_hint')) db.exec('ALTER TABLE support_messages ADD COLUMN plan_hint TEXT');
  // Mã do client sinh khi gửi: gửi lại khi rớt mạng không tạo tin trùng
  if (!cols.includes('cid')) db.exec('ALTER TABLE support_messages ADD COLUMN cid TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_support_cid ON support_messages(user_id, cid) WHERE cid IS NOT NULL');

  // Mặc định KHÔNG xoá chữ theo thời gian (tránh mất dữ liệu). Ảnh chiếm dung lượng nhất: mặc định xoá sau 730 ngày (0 = giữ mãi).
  const days = Math.max(0, Number(process.env.SUPPORT_RETENTION_DAYS || 0));
  const imgDays = Math.max(0, Number(process.env.SUPPORT_IMAGE_ARCHIVE_DAYS ?? 730));
  // Hạ gói theo lịch: giữ gói hiện tại đến hết hạn rồi tự chuyển sang gói thấp hơn (cột users.sub_next_plan)
  try {
    const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!ucols.includes('sub_next_plan')) db.exec('ALTER TABLE users ADD COLUMN sub_next_plan TEXT');
  } catch (e) { console.error('sub_next_plan', e.message); }
  const switchDue = () => {
    try {
      const due = db.prepare('SELECT id FROM users WHERE sub_next_plan IS NOT NULL AND sub_expires_at IS NOT NULL AND sub_expires_at <= ?').all(Date.now());
      for (const { id } of due) {
        const u = db.prepare('SELECT sub_next_plan FROM users WHERE id = ?').get(id);
        const r = grantPlan(db, id, u.sub_next_plan, { expiresAt: 'never', note: 'scheduled_downgrade' });
        if (r.ok) {
          db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts) VALUES (?, 1, ?, ?)')
            .run(id, `Gói trước đã hết hạn, tài khoản của bạn đã tự chuyển sang gói "${PLAN_CATALOG[u.sub_next_plan].label}" như đã thông báo. Bạn tải lại ứng dụng để cập nhật.`, Date.now());
          audit(db, 'plan_scheduled_switch', { userId: id, detail: `${id} -> ${u.sub_next_plan}` });
        }
      }
    } catch (e) { console.error('switchDue', e.message); }
  };
  switchDue();
  setInterval(switchDue, 60_000).unref?.();
  const purge = () => {
    try {
      if (days > 0) {
        const cutoff = Date.now() - days * 86400_000;
        db.prepare('DELETE FROM support_messages WHERE ts < ?').run(cutoff);
        db.prepare('DELETE FROM support_archive WHERE ts < ?').run(cutoff);
        db.prepare('DELETE FROM support_images WHERE ts < ?').run(cutoff);
      }
      if (imgDays > 0) db.prepare('DELETE FROM support_images WHERE ts < ?').run(Date.now() - imgDays * 86400_000);
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

/** Mã gửi do client sinh: 8..40 ký tự chữ/số/gạch. */
const cleanCid = (raw) => { const s = String(raw ?? ''); return /^[A-Za-z0-9_-]{8,40}$/.test(s) ? s : null; };

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
  // Chống nhiều tài khoản từ một IP, và cầu dao toàn cục chống làm đầy DB khi bị tấn công phân tán
  const ipLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.SUPPORT_IP_PER_MIN || 30), keyFn: (req) => `${ipOf(req)}:support-ip` });
  const globalLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.SUPPORT_GLOBAL_PER_MIN || 300), keyFn: () => 'support-global' });
  const userLimits = [ipLimit, globalLimit];

  /** Mức dùng toàn hệ thống (cache 30 giây để mỗi request không phải quét bảng). */
  let usageCache = { at: 0, msgs: 0, imgBytes: 0 };
  function usage() {
    if (Date.now() - usageCache.at > 30_000) {
      usageCache = {
        at: Date.now(),
        msgs: db.prepare('SELECT COUNT(*) AS n FROM support_messages').get().n + db.prepare('SELECT COUNT(*) AS n FROM support_archive').get().n,
        imgBytes: db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS n FROM support_images').get().n,
      };
    }
    return usageCache;
  }

  /** Giữ tối đa MAX_PER_USER tin hiển thị: tin cũ hơn CHUYỂN sang kho lưu trữ (không xoá). */
  function trim(uid) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ?').get(uid).n;
    if (n <= MAX_PER_USER) return;
    db.transaction(() => {
      const cut = db.prepare('SELECT id FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?').get(uid, MAX_PER_USER)?.id;
      if (!cut) return;
      db.prepare(`INSERT OR IGNORE INTO support_archive (id, user_id, from_admin, body, ts, image_id, archived_ts)
        SELECT id, user_id, from_admin, body, ts, image_id, ? FROM support_messages WHERE user_id = ? AND id <= ?`).run(Date.now(), uid, cut);
      db.prepare('DELETE FROM support_messages WHERE user_id = ? AND id <= ?').run(uid, cut);
      // Kho lưu trữ cũng có trần để DB không phình vô hạn: vượt thì bỏ tin lưu trữ cũ nhất (và ảnh mồ côi)
      const ac = db.prepare('SELECT COUNT(*) AS n FROM support_archive WHERE user_id = ?').get(uid).n;
      if (ac > ARCHIVE_MAX) {
        const acut = db.prepare('SELECT id FROM support_archive WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?').get(uid, ARCHIVE_MAX)?.id;
        if (acut) db.prepare('DELETE FROM support_archive WHERE user_id = ? AND id <= ?').run(uid, acut);
      }
      db.prepare(`DELETE FROM support_images WHERE user_id = ? AND id NOT IN (
        SELECT image_id FROM support_messages WHERE user_id = ? AND image_id IS NOT NULL
        UNION SELECT image_id FROM support_archive WHERE user_id = ? AND image_id IS NOT NULL)`).run(uid, uid, uid);
    })();
  }

  /** Lịch sử cũ (tin hiển thị + kho lưu trữ) có id < before, theo thứ tự đọc. */
  function history(uid, before, limit) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 50));
    const b = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(`SELECT id, from_admin, body, ts, image_id FROM (
        SELECT id, from_admin, body, ts, image_id FROM support_messages WHERE user_id = ? AND id < ?
        UNION ALL
        SELECT id, from_admin, body, ts, image_id FROM support_archive WHERE user_id = ? AND id < ?)
      ORDER BY id DESC LIMIT ?`).all(uid, b, uid, b, lim + 1);
    return { messages: rows.slice(0, lim).reverse().map(view), more: rows.length > lim };
  }

  /* ---------------- người dùng ---------------- */
  app.get('/api/support/messages', requireAuth, (req, res) => {
    const after = Math.max(0, Number(req.query.after) || 0);
    const rows = db.prepare('SELECT * FROM support_messages WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 200').all(req.user.id, after);
    if (String(req.query.read) === '1') {
      db.prepare('UPDATE support_messages SET read_ts = ? WHERE user_id = ? AND from_admin = 1 AND read_ts IS NULL').run(Date.now(), req.user.id);
    }
    res.json({ messages: rows.map(view) });
  });

  app.get('/api/support/history', requireAuth, (req, res) => {
    res.json(history(req.user.id, req.query.before, req.query.limit));
  });

  app.get('/api/support/unread', requireAuth, (req, res) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND from_admin = 1 AND read_ts IS NULL').get(req.user.id).n;
    const pr = db.prepare('SELECT plan, ts FROM support_requests WHERE user_id = ?').get(req.user.id);
    res.json({ unread: n, pendingPlan: pr?.plan || null });
  });

  app.post('/api/support/messages', requireAuth, ...userLimits, sendLimit, (req, res) => {
    const body = cleanBody(req.body?.body);
    if (!body) return res.status(400).json({ error: 'empty_message' });
    const cid = cleanCid(req.body?.cid);
    if (cid) {   // gửi lại cùng mã (rớt mạng): trả tin đã có, không tạo trùng
      const ex = db.prepare('SELECT id FROM support_messages WHERE user_id = ? AND cid = ?').get(req.user.id, cid);
      if (ex) return res.json({ ok: true, id: ex.id, duplicate: true });
    }
    // Gói này đã được xin tư vấn và đang chờ admin xử lý: báo "đã đăng ký rồi", không tạo thêm tin
    const planAsked = PLAN_CATALOG[String(req.body?.plan || '')] ? String(req.body.plan) : null;
    if (planAsked && db.prepare('SELECT 1 FROM support_requests WHERE user_id = ? AND plan = ?').get(req.user.id, planAsked)) {
      return res.status(409).json({ error: 'already_requested', plan: planAsked });
    }
    if (usage().msgs >= GLOBAL_MESSAGES) return res.status(503).json({ error: 'busy' });
    const today = db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND from_admin = 0 AND ts > ?').get(req.user.id, Date.now() - 86400_000).n;
    if (today >= DAILY_CAP) return res.status(429).json({ error: 'rate_limited' });
    // Chặn gửi đi gửi lại cùng một nội dung (spam)
    const same = db.prepare('SELECT 1 FROM support_messages WHERE user_id = ? AND from_admin = 0 AND body = ? AND ts > ? LIMIT 1').get(req.user.id, body, Date.now() - 60_000);
    if (same) return res.status(429).json({ error: 'duplicate' });
    const hint = PLAN_CATALOG[String(req.body?.plan || '')] ? String(req.body.plan) : null;
    const r = db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts, plan_hint, cid) VALUES (?, 0, ?, ?, ?, ?)').run(req.user.id, body, Date.now(), hint, cid);
    if (hint) db.prepare('INSERT INTO support_requests (user_id, plan, ts) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, ts = excluded.ts').run(req.user.id, hint, Date.now());
    trim(req.user.id);
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
        return { userId: r.user_id, username: r.username, plan, lastBody: String(r.last_body || '📷 Ảnh').slice(0, 120), lastTs: r.last_ts, lastFromAdmin: Boolean(r.last_from_admin), unread: r.unread,
          pendingPlan: db.prepare('SELECT plan FROM support_requests WHERE user_id = ?').get(r.user_id)?.plan || null };
      }),
      unread: rows.reduce((a, r) => a + r.unread, 0),
      pending: db.prepare('SELECT COUNT(*) AS n FROM support_requests').get().n,
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
    const asked = db.prepare('SELECT plan AS plan_hint FROM support_requests WHERE user_id = ?').get(uid);
    res.json({
      profile: profileOf(u),
      userId: uid, username: u.username, plan, planId: subscriptionInfo(u)?.plan || null,
      requestedPlan: asked?.plan_hint || null,
      quotes: (() => { try { return quotesForWidgets(applyWidgetLimit(listUserDevices(db, u).map(deviceToUiNode), null).total); } catch { return null; } })(),
      pricing: pricingAssumptions(),
      expiresAt: subscriptionInfo(u)?.expiresAt ?? null,
      nextPlan: subscriptionInfo(u)?.nextPlan || null,
      plans: listPlans().map((p) => ({ id: p.id, label: p.label })),
      messages: rows.map(view),
    });
  });

  // Thông tin cơ bản của người dùng trong DB để admin tra cứu ngay trong cuộc chat (chỉ đọc, trừ các trường sửa được bên dưới)
  try { if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'admin_note')) db.exec('ALTER TABLE users ADD COLUMN admin_note TEXT'); } catch { /* */ }
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
  function profileOf(u) {
    const sub = (() => { try { return subscriptionInfo(u); } catch { return {}; } })();
    const devs = (() => { try { return applyWidgetLimit(listUserDevices(db, u).map(deviceToUiNode), null); } catch { return null; } })();
    const login = one("SELECT ts, ip FROM audit_log WHERE user_id = ? AND event = 'login_ok' ORDER BY ts DESC LIMIT 1", u.id);
    const tele = one("SELECT MAX(ts) AS t FROM mqtt_events WHERE site = ? AND device = ? AND kind = 'telemetry'", u.notify_site, u.notify_device);
    const creator = u.created_by ? one('SELECT username FROM users WHERE id = ?', u.created_by) : null;
    const msgs = one('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ?', u.id);
    const arch = one('SELECT COUNT(*) AS n FROM support_archive WHERE user_id = ?', u.id);
    const ret = (() => { try { return retentionInfo(u); } catch { return {}; } })();
    return {
      id: u.id, username: u.username, role: u.role, disabled: Boolean(u.disabled), createdAt: u.created_at || null, createdBy: creator?.username || null,
      site: u.notify_site, device: u.notify_device, tenantId: u.tenant_id || null,
      planId: sub?.plan || null, plan: sub?.planLabel || null, expiresAt: sub?.expiresAt ?? null, nextPlan: sub?.nextPlan || null,
      retentionDays: ret.retentionDays ?? null, unlimitedHistory: Boolean(ret.unlimited),
      remoteControl: u.remote_control == null ? null : Boolean(u.remote_control),
      widgets: devs?.total ?? null, widgetLimit: devs?.limit ?? null,
      setupComplete: u.setup_complete !== 0, totpEnabled: Boolean(u.totp_enabled),
      passkeys: one('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', u.id)?.n ?? 0,
      privacyConsentAt: u.privacy_consent_at || null,
      lastLoginAt: login?.ts || null, lastLoginIp: login?.ip || null, lastTelemetryAt: tele?.t || null,
      chatMessages: (msgs?.n || 0) + (arch?.n || 0),
      note: u.admin_note || '',
    };
  }

  app.post('/api/admin/support/threads/:uid/profile', ...adminOnly, adminSendLimit, (req, res) => {
    const uid = Number(req.params.uid);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    const b = req.body || {};
    const changed = [];
    if (b.note !== undefined) { db.prepare('UPDATE users SET admin_note = ? WHERE id = ?').run(String(b.note).slice(0, 1000), uid); changed.push('note'); }
    if (b.planId !== undefined) {
      if (!PLAN_CATALOG[b.planId]) return res.status(400).json({ error: 'invalid_plan' });
      let exp = null;
      if (b.expiresAt !== undefined && b.expiresAt !== null && b.expiresAt !== '') {
        exp = Number(b.expiresAt);
        if (!Number.isFinite(exp) || exp < Date.now() - 86_400_000) return res.status(400).json({ error: 'invalid_expiry' });
      }
      grantPlan(db, uid, b.planId, { expiresAt: exp, note: `admin-profile:${req.user.username}` });
      changed.push(`plan=${b.planId}${exp ? `@${new Date(exp).toISOString().slice(0, 10)}` : ''}`);
    } else if (b.expiresAt !== undefined) {
      const cur = subscriptionInfo(u)?.plan;
      if (!cur) return res.status(400).json({ error: 'no_plan' });
      const exp = b.expiresAt === null || b.expiresAt === '' ? null : Number(b.expiresAt);
      if (exp !== null && (!Number.isFinite(exp) || exp < Date.now() - 86_400_000)) return res.status(400).json({ error: 'invalid_expiry' });
      grantPlan(db, uid, cur, { expiresAt: exp, note: `admin-profile:${req.user.username}` });
      changed.push(`expiry=${exp ? new Date(exp).toISOString().slice(0, 10) : 'none'}`);
    }
    if (b.remoteControl !== undefined) { setRemoteControl(db, uid, Boolean(b.remoteControl)); changed.push(`remoteControl=${Boolean(b.remoteControl)}`); }
    if (changed.length) audit(db, 'support_profile_update', { userId: req.user.id, ip: clientIp(req), detail: `${u.username}: ${changed.join(', ')}` });
    res.json({ ok: true, profile: profileOf(db.prepare('SELECT * FROM users WHERE id = ?').get(uid)) });
  });

  // Lịch sử cũ của một người dùng (kể cả kho lưu trữ), phân trang theo id
  app.get('/api/admin/support/threads/:uid/history', ...adminOnly, (req, res) => {
    const uid = Number(req.params.uid);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return res.status(404).json({ error: 'user_not_found' });
    res.json(history(uid, req.query.before, req.query.limit));
  });

  // Xuất toàn bộ hội thoại để đối soát: ?format=txt (mặc định) hoặc json (&images=1 kèm ảnh base64)
  app.get('/api/admin/support/threads/:uid/export', ...adminOnly, (req, res) => {
    const uid = Number(req.params.uid);
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(uid);
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    const rows = db.prepare(`SELECT id, from_admin, body, ts, image_id FROM (
        SELECT id, from_admin, body, ts, image_id FROM support_messages WHERE user_id = ?
        UNION ALL SELECT id, from_admin, body, ts, image_id FROM support_archive WHERE user_id = ?) ORDER BY id ASC`).all(uid, uid);
    audit(db, 'support_export', { userId: req.user.id, ip: ipOf(req), detail: `to:${uid}` });
    const safe = String(u.username).replace(/[^\w.-]/g, '_');
    if (String(req.query.format) === 'json') {
      const withImg = String(req.query.images) === '1';
      const out = rows.map((m) => {
        const o = view(m);
        if (withImg && m.image_id) {
          const im = db.prepare('SELECT mime, data FROM support_images WHERE id = ? AND user_id = ?').get(m.image_id, uid);
          if (im) o.imageData = `data:${im.mime};base64,${im.data.toString('base64')}`;
        }
        return o;
      });
      res.set('Content-Disposition', `attachment; filename="chat-${safe}.json"`);
      return res.json({ username: u.username, exportedAt: Date.now(), messages: out });
    }
    const txt = rows.map((m) => `[${new Date(m.ts).toISOString()}] ${m.from_admin ? 'Admin' : u.username}: ${m.image_id ? `[ảnh #${m.image_id}] ` : ''}${m.body}`).join('\n');
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="chat-${safe}.txt"`, 'X-Content-Type-Options': 'nosniff' });
    return res.send(txt + '\n');
  });

  /* Đồng ý / Từ chối yêu cầu tư vấn đổi gói. Đồng ý = admin gán gói THỦ CÔNG (như Console) + nhắn xác nhận bằng chữ.
     Từ chối = nhắn lý do bằng chữ. Không lưu "đơn hàng", không có trạng thái thanh toán. */
  const say = (uid, text) => { db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts) VALUES (?, 1, ?, ?)').run(uid, text, Date.now()); trim(uid); };
  const clearPending = (uid) => db.prepare('DELETE FROM support_requests WHERE user_id = ?').run(uid);

  app.post('/api/admin/support/threads/:uid/approve', ...adminOnly, adminSendLimit, (req, res) => {
    const uid = Number(req.params.uid);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    const planId = String(req.body?.plan || '');
    if (!PLAN_CATALOG[planId]) return res.status(400).json({ error: 'unknown_plan' });
    const curId = subscriptionInfo(u)?.plan;
    const fmt = (t) => new Date(t).toLocaleDateString('vi-VN');
    // Hạ gói: giữ gói cũ đến hết hạn rồi mới chuyển (trừ khi admin chọn "đổi ngay")
    if (planRank(planId) < planRank(curId) && !req.body?.immediate) {
      const exp = u.sub_expires_at != null ? Number(u.sub_expires_at) : null;
      if (!exp || exp <= Date.now()) return res.status(409).json({ error: 'no_expiry', hint: 'Gói hiện tại không có ngày hết hạn trong tương lai: hãy tick "Đổi ngay" hoặc đặt hạn trước.' });
      db.prepare('UPDATE users SET sub_next_plan = ? WHERE id = ?').run(planId, uid);
      clearPending(uid);
      audit(db, 'admin_plan_schedule', { userId: req.user.id, ip: ipOf(req), detail: `${uid} ${curId}->${planId} at ${exp}` });
      say(uid, `Quản trị viên đã ghi nhận yêu cầu chuyển xuống gói "${PLAN_CATALOG[planId].label}". Gói hiện tại "${PLAN_CATALOG[curId]?.label || curId}" của bạn vẫn được giữ đến hết ngày ${fmt(exp)}; sau đó tài khoản sẽ tự chuyển sang gói "${PLAN_CATALOG[planId].label}".`);
      return res.json({ ok: true, scheduled: true, switchAt: exp, subscription: subscriptionInfo(db.prepare('SELECT * FROM users WHERE id = ?').get(uid)) });
    }
    const r = grantPlan(db, uid, planId, { expiresAt: req.body?.expiresAt || 'never', note: 'via_support_chat' });
    if (r.error) return res.status(r.status || 400).json(r);
    clearPending(uid);
    audit(db, 'admin_plan_grant', { userId: req.user.id, ip: ipOf(req), detail: `${uid} ${planId} never via_chat` });
    say(uid, `Quản trị viên đã đồng ý và chuyển tài khoản của bạn sang gói "${PLAN_CATALOG[planId].label}". Bạn tải lại ứng dụng là dùng được ngay, không cần đăng nhập lại.`);
    res.json({ ok: true, subscription: r.subscription });
  });

  app.post('/api/admin/support/threads/:uid/decline', ...adminOnly, adminSendLimit, (req, res) => {
    const uid = Number(req.params.uid);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return res.status(404).json({ error: 'user_not_found' });
    const reason = cleanBody(req.body?.reason)?.slice(0, 300);
    say(uid, `Quản trị viên chưa thể chuyển gói theo yêu cầu của bạn lúc này.${reason ? ` Lý do: ${reason}` : ''} Bạn có thể nhắn thêm tại đây nếu cần trao đổi.`);
    clearPending(uid);
    audit(db, 'support_decline', { userId: req.user.id, ip: ipOf(req), detail: `to:${uid}` });
    res.json({ ok: true });
  });

  app.post('/api/admin/support/threads/:uid', ...adminOnly, adminSendLimit, (req, res) => {
    const uid = Number(req.params.uid);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return res.status(404).json({ error: 'user_not_found' });
    const body = cleanBody(req.body?.body);
    if (!body) return res.status(400).json({ error: 'empty_message' });
    const r = db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts) VALUES (?, 1, ?, ?)').run(uid, body, Date.now());
    trim(uid);
    audit(db, 'support_reply', { userId: req.user.id, ip: ipOf(req), detail: `to:${uid}` });
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });

  /* ---------------- ảnh chụp màn hình ---------------- */
  /** Lưu ảnh + tin nhắn kèm theo. Trả { status, json }. */
  function saveImage(req, userId, fromAdmin, dailyCap) {
    const buf = req.body;
    const mime = imageMime(buf);
    if (!mime) return { status: 400, json: { error: 'bad_image' } };
    const cid = cleanCid(req.query.cid);
    if (cid) {
      const ex = db.prepare('SELECT id, image_id FROM support_messages WHERE user_id = ? AND cid = ?').get(userId, cid);
      if (ex) return { status: 200, json: { ok: true, id: ex.id, image: ex.image_id, duplicate: true } };
    }
    const caption = cleanBody(req.query.caption) || '';
    const used = db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND from_admin = ? AND image_id IS NOT NULL AND ts > ?')
      .get(userId, fromAdmin, Date.now() - 86400_000).n;
    if (used >= dailyCap) return { status: 429, json: { error: 'rate_limited' } };
    // Hạn mức dung lượng: mỗi người dùng và toàn hệ thống (chống làm đầy đĩa/DB bằng ảnh)
    if (!fromAdmin) {
      const mine = db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS n FROM support_images WHERE user_id = ?').get(userId).n;
      if (mine + buf.length > USER_IMG_BYTES) return { status: 413, json: { error: 'quota_exceeded' } };
    }
    if (usage().imgBytes + buf.length > GLOBAL_IMG_BYTES || usage().msgs >= GLOBAL_MESSAGES) return { status: 503, json: { error: 'busy' } };
    const now = Date.now();
    const img = db.prepare('INSERT INTO support_images (user_id, mime, data, ts) VALUES (?, ?, ?, ?)').run(userId, mime, buf, now);
    const r = db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts, image_id, cid) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, fromAdmin, caption, now, Number(img.lastInsertRowid), cid);
    usageCache.imgBytes += buf.length;
    trim(userId);
    return { status: 200, json: { ok: true, id: Number(r.lastInsertRowid), image: Number(img.lastInsertRowid) } };
  }
  function sendImage(res, row) {
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.set({ 'Content-Type': row.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline' });
    return res.send(row.data);
  }
  const imgLimit = rateLimit({ windowMs: 60_000, max: 6, keyFn: (req) => `${ipOf(req)}:support-img:${req.user?.id || 'na'}` });

  app.post('/api/support/images', requireAuth, ...userLimits, imgLimit, rawImage, (req, res) => {
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
