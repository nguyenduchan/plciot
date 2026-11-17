/**
 * ĐỔI CHỦ gateway — có kiểm soát của chủ cũ.
 *
 * Người mới (B) đăng nhập gateway đủ tên + mật khẩu + mã ghép và giữ đúng khoá riêng của gateway → server KHÔNG chuyển ngay,
 * chỉ tạo một yêu cầu chờ:
 *   - Chủ cũ (A) được báo (push + audit) và vào webapp DUYỆT (cần Face ID/TOTP) → chuyển ngay; hoặc TỪ CHỐI → huỷ.
 *   - A không làm gì trong TRANSFER_WAIT_HOURS (mặc định 24 giờ) → tự chuyển (A có thể đã mất tài khoản/điện thoại).
 *   - A không còn (tài khoản bị xoá/khoá) → chuyển ngay, không có ai để hỏi.
 * Vì sao: chiếm được máy gateway không còn đồng nghĩa chiếm ngay quyền sở hữu trên cloud; A luôn có thời gian chặn lại.
 * Trong lúc chờ gateway vẫn thuộc A và chạy bình thường. Bị từ chối → cùng B không xin lại được trong TRANSFER_WAIT_HOURS.
 */
import crypto from 'node:crypto';
import { audit, clientIp, getHardwareDeviceQr, rateLimit } from '@plciot/security';
import { reassignPairing, userGatewayCount, USER_MAX_GATEWAYS } from './gatewayPairing.js';
import { addDeviceFromQr, removeGateway } from './userDevices.js';
import { notifyGateway } from './gatewayNotify.js';
import { pushToUser } from './webPush.js';

const WAIT_MS = Math.max(0, Number(process.env.TRANSFER_WAIT_HOURS ?? 24)) * 3600_000;
const SWEEP_MS = 5 * 60_000;

export function migrateGatewayTransfers(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_transfers (
      id TEXT PRIMARY KEY,
      pairing_id TEXT NOT NULL,
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      from_user INTEGER NOT NULL,
      to_user INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      decided_at INTEGER,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS gateway_transfers_from ON gateway_transfers (from_user, status);
    CREATE INDEX IF NOT EXISTS gateway_transfers_pairing ON gateway_transfers (pairing_id, status);
  `);
}

const userById = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const alive = (u) => Boolean(u && !u.disabled);
const push = (db, uid, t, b, url = '/') => pushToUser(db, uid, { t, b, tag: 'gw-transfer', url }).catch(() => {});

/**
 * Gateway (B) xin nhận gateway đang thuộc A. Gọi SAU khi đã kiểm chữ ký khoá riêng + hạn mức (checkTransferRequest).
 * Trả { status: 'transfer_pending', dueAt } (202) hoặc { status: 'transfer_done' } khi A không còn, hoặc lỗi.
 */
export async function requestTransfer(db, toUser, pairing, { ip } = {}) {
  migrateGatewayTransfers(db);
  const now = Date.now();
  const open = db.prepare("SELECT * FROM gateway_transfers WHERE pairing_id = ? AND status = 'pending'").get(pairing.id);
  if (open && open.to_user !== toUser.id) return { error: 'transfer_in_progress', status: 409 };   // không cho người thứ ba chen/ghi đè yêu cầu đang chờ
  if (open) return { ok: true, status: 'transfer_pending', transferId: open.id, dueAt: open.due_at };
  const refused = db.prepare("SELECT 1 FROM gateway_transfers WHERE pairing_id = ? AND to_user = ? AND status = 'rejected' AND decided_at > ?").get(pairing.id, toUser.id, now - WAIT_MS);
  if (refused) return { error: 'transfer_rejected', status: 403 };

  const id = `gt_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare("INSERT INTO gateway_transfers (id, pairing_id, site, device, from_user, to_user, status, created_at, due_at, ip) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
    .run(id, pairing.id, pairing.site, pairing.device, pairing.user_id, toUser.id, now, now + WAIT_MS, ip || null);
  audit(db, 'gateway_transfer_requested', { userId: pairing.user_id, ip, detail: `${pairing.site}/${pairing.device} → ${toUser.username} (${id})` });

  const from = userById(db, pairing.user_id);
  if (!alive(from) || WAIT_MS === 0) {
    const done = await completeTransfer(db, id, { reason: alive(from) ? 'no_wait' : 'owner_gone' });
    return done.ok ? { ok: true, status: 'transfer_done', transferId: id } : done;
  }
  const hours = Math.round(WAIT_MS / 3600_000);
  push(db, from.id, '⚠ Có người xin nhận gateway của bạn',
    `${pairing.site}/${pairing.device}: tài khoản "${toUser.username}" xin chuyển gateway về họ. Mở để DUYỆT hoặc TỪ CHỐI — không làm gì thì tự chuyển sau ${hours} giờ.`,
    `/gateway-login.html?transfer=${id}`);
  return { ok: true, status: 'transfer_pending', transferId: id, dueAt: now + WAIT_MS };
}

/** Thực hiện chuyển (A duyệt, hết hạn chờ, hoặc A không còn). Kiểm lại mọi điều kiện vì trạng thái có thể đã đổi trong lúc chờ. */
export async function completeTransfer(db, id, { reason = 'approved', ip } = {}) {
  const t = db.prepare("SELECT * FROM gateway_transfers WHERE id = ? AND status = 'pending'").get(id);
  if (!t) return { error: 'not_found', status: 404 };
  const cancel = (why) => {
    db.prepare("UPDATE gateway_transfers SET status = 'cancelled', decided_at = ? WHERE id = ?").run(Date.now(), id);
    audit(db, 'gateway_transfer_cancelled', { userId: t.from_user, detail: `${t.site}/${t.device} (${id}): ${why}` });
    return { error: why, status: 409 };
  };
  const pairing = db.prepare(`SELECT * FROM gateway_pairings p WHERE id = ? AND user_id = ? AND status = 'approved'
    AND EXISTS (SELECT 1 FROM hardware_devices h WHERE h.site = p.site AND h.device = p.device)`).get(t.pairing_id, t.from_user);
  if (!pairing) return cancel('gateway_changed');
  const to = userById(db, t.to_user);
  if (!alive(to)) return cancel('new_owner_gone');
  if (userGatewayCount(db, to.id) >= USER_MAX_GATEWAYS) return cancel('too_many_gateways');
  // Đánh dấu trước (chống chạy đôi giữa duyệt tay và bộ quét hết hạn)
  if (!db.prepare("UPDATE gateway_transfers SET status = 'done', decided_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), id).changes) return { error: 'not_found', status: 404 };

  reassignPairing(db, pairing.id, to.id);
  const from = userById(db, t.from_user);
  if (from) { try { removeGateway(db, from, t.site, t.device, { ip }); } catch (e) { console.error('transfer remove old', e.message); } }
  let claimed = false;
  const q = getHardwareDeviceQr(db, { site: t.site, device: t.device });
  if (!q.error) {
    try { const c = await addDeviceFromQr(db, to, { qr: q.qr, ip }); claimed = Boolean(c?.ok); if (!claimed) console.error('transfer claim', c?.error); }
    catch (e) { console.error('transfer claim', e.message); }
  }
  if (claimed) notifyGateway(db, t.site, t.device, 'claimed');
  audit(db, 'gateway_owner_changed', { userId: to.id, ip, detail: `${t.site}/${t.device} from:${t.from_user} (${id}, ${reason})` });
  audit(db, 'gateway_transferred_out', { userId: t.from_user, ip, detail: `${t.site}/${t.device} → ${to.username} (${id}, ${reason})` });
  if (alive(from)) push(db, from.id, 'Gateway đã chuyển sang tài khoản khác', `${t.site}/${t.device} nay thuộc tài khoản "${to.username}". Nếu không phải bạn cho phép, hãy đổi mật khẩu ngay.`);
  push(db, to.id, 'Đã nhận gateway', `${t.site}/${t.device} đã chuyển về tài khoản của bạn.`);
  return { ok: true, site: t.site, device: t.device, claimed };
}

/** Tự chuyển các yêu cầu đã hết hạn chờ mà chủ cũ không từ chối. */
export async function sweepTransfers(db) {
  migrateGatewayTransfers(db);
  const due = db.prepare("SELECT id FROM gateway_transfers WHERE status = 'pending' AND due_at <= ?").all(Date.now());
  for (const r of due) { try { await completeTransfer(db, r.id, { reason: 'timeout' }); } catch (e) { console.error('transfer sweep', e.message); } }
  return due.length;
}

/** API cho chủ cũ trên webapp: xem / duyệt (cần Face ID/TOTP) / từ chối các yêu cầu nhận gateway của mình. */
export function mountGatewayTransfers(app, { db, requireAuth, requireOtp }) {
  migrateGatewayTransfers(db);
  const limit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_GATEWAY_TRANSFER || 20), keyFn: (req) => `${clientIp(req)}:gw-transfer` });
  const view = (t) => {
    const to = userById(db, t.to_user);
    return { id: t.id, site: t.site, device: t.device, toUser: to?.username || '?', createdAt: t.created_at, dueAt: t.due_at, ip: t.ip || '' };
  };
  const mine = (req) => db.prepare("SELECT * FROM gateway_transfers WHERE id = ? AND from_user = ? AND status = 'pending'").get(String(req.params.id || ''), req.user.id);

  app.get('/api/v1/gateway/transfers', requireAuth, limit, (req, res) => {
    const rows = db.prepare("SELECT * FROM gateway_transfers WHERE from_user = ? AND status = 'pending' ORDER BY created_at DESC").all(req.user.id);
    res.json({ transfers: rows.map(view) });
  });
  app.post('/api/v1/gateway/transfers/:id/approve', requireAuth, requireOtp, limit, async (req, res) => {
    try {
      if (!mine(req)) return res.status(404).json({ error: 'not_found' });
      const r = await completeTransfer(db, req.params.id, { reason: 'approved', ip: clientIp(req) });
      if (r.error) return res.status(r.status || 400).json(r);
      res.json(r);
    } catch (e) { console.error('transfer approve', e.message); res.status(500).json({ error: 'transfer_failed' }); }
  });
  // Từ chối là thao tác BẢO VỆ → chỉ cần phiên đăng nhập (không bắt OTP, để chặn kịp cả khi đang không có Authenticator bên cạnh)
  app.post('/api/v1/gateway/transfers/:id/reject', requireAuth, limit, (req, res) => {
    const t = mine(req);
    if (!t) return res.status(404).json({ error: 'not_found' });
    db.prepare("UPDATE gateway_transfers SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), t.id);
    audit(db, 'gateway_transfer_rejected', { userId: req.user.id, ip: clientIp(req), detail: `${t.site}/${t.device} (${t.id})` });
    push(db, t.to_user, 'Yêu cầu nhận gateway bị từ chối', `Chủ gateway ${t.site}/${t.device} đã từ chối chuyển.`);
    res.json({ ok: true });
  });

  const timer = setInterval(() => { sweepTransfers(db).catch((e) => console.error('transfer sweep', e.message)); }, SWEEP_MS);
  timer.unref?.();
}
