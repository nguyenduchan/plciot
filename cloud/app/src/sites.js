/**
 * Nhà máy (site/device), chủ site và thành viên — để khách tự quản mà không cần admin nền tảng.
 *
 *   Nhận thiết bị  — site/device chưa có ai dùng nhưng gateway đang gửi telemetry: người dùng chứng minh đang ở
 *                    cạnh PLC bằng cách tác động vào một ngõ vào X trong 2 phút (plcProof) → thành chủ site.
 *   Mời thành viên — chủ site mời theo SĐT (operator/viewer); người được mời phải bấm chấp nhận.
 *   Gỡ thành viên  — chủ site; thành viên quay về vùng riêng và bị rotate mật khẩu MQTT.
 * Chủ site = users.site_owner = 1. Nếu site chưa có chủ thì người dùng operator/admin có id nhỏ nhất được nâng lên.
 */
import crypto from 'crypto';
import { audit, countAudit } from '@plciot/security';
import { normalizePhone, isValidVnPhone, formatVnLocal } from './phone.js';
import { provisionUserMqtt } from './mqttProvision.js';
import { notifyOwner } from './accountSecurity.js';
import { sendTelegramMessage, telegramConfigured } from './telegram.js';
import { resolveTelegramUser } from './sharedTg.js';
import { plcSnapshot, edgeSince, pickProofBit } from './plcProof.js';

const SAFE = /^[a-zA-Z0-9_-]{1,48}$/;
const DAY = 86_400_000;
const INVITE_TTL = 7 * DAY;
const CLAIM_WINDOW = 2 * 60_000;
const INVITE_ROLES = ['operator', 'viewer'];
const claims = new Map(); // userId -> { site, device, bit, since, expires }

const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const maskPhone = (p) => { const l = formatVnLocal(p); return l.length > 6 ? `${l.slice(0, 3)}****${l.slice(-3)}` : l; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function ensureOwner(db, site, device) {
  const has = db.prepare('SELECT 1 FROM users WHERE notify_site = ? AND notify_device = ? AND site_owner = 1 AND disabled = 0').get(site, device);
  if (has) return;
  const cand = db.prepare("SELECT id FROM users WHERE notify_site = ? AND notify_device = ? AND disabled = 0 AND role IN ('admin','operator') ORDER BY id LIMIT 1").get(site, device);
  if (cand) db.prepare('UPDATE users SET site_owner = 1 WHERE id = ?').run(cand.id);
}

/** Người dùng (đã nạp lại từ DB) có phải chủ site của chính mình không. */
export function isSiteOwner(db, user) {
  ensureOwner(db, user.notify_site, user.notify_device);
  return getUser(db, user.id)?.site_owner === 1;
}

function moveUser(db, userId, site, device, { role = null, owner = false }) {
  db.prepare('UPDATE users SET notify_site = ?, notify_device = ?, role = COALESCE(?, role), site_owner = ? WHERE id = ?')
    .run(site, device, role, owner ? 1 : 0, userId);
  try {
    provisionUserMqtt(db, getUser(db, userId), { site, device, rotate: true });
  } catch (e) {
    console.error('moveUser provision', e.message);
  }
  return getUser(db, userId);
}

const ownsOthers = (db, user) => db.prepare(
  'SELECT COUNT(*) AS n FROM users WHERE notify_site = ? AND notify_device = ? AND id != ? AND disabled = 0',
).get(user.notify_site, user.notify_device, user.id).n > 0;

/* ------------------------------------------------------------ thông tin */
export function siteInfo(db, user) {
  ensureOwner(db, user.notify_site, user.notify_device);
  const me = getUser(db, user.id);
  const owner = me.site_owner === 1;
  const snap = plcSnapshot(me.notify_site, me.notify_device);
  const out = {
    site: me.notify_site,
    device: me.notify_device,
    online: Boolean(snap.fresh),
    isOwner: owner,
    role: me.role,
    invitesIn: db.prepare("SELECT id, site, device, role, invited_by, expires_at FROM site_invites WHERE phone = ? AND status = 'pending' AND expires_at > ?")
      .all(normalizePhone(me.phone || me.username), Date.now()).map((i) => ({
        id: i.id, site: i.site, device: i.device, role: i.role, expiresAt: i.expires_at,
        from: maskPhone(getUser(db, i.invited_by)?.phone || ''),
      })),
  };
  out.memberCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE notify_site = ? AND notify_device = ? AND disabled = 0').get(me.notify_site, me.notify_device).n;
  if (!owner) return out;
  out.members = db.prepare('SELECT id, phone, role, site_owner FROM users WHERE notify_site = ? AND notify_device = ? AND disabled = 0 ORDER BY site_owner DESC, id')
    .all(me.notify_site, me.notify_device).map((u) => ({ id: u.id, phone: maskPhone(u.phone || ''), role: u.role, owner: u.site_owner === 1, me: u.id === me.id }));
  out.invitesOut = db.prepare("SELECT id, phone, role, expires_at FROM site_invites WHERE site = ? AND device = ? AND status = 'pending' AND expires_at > ?")
    .all(me.notify_site, me.notify_device, Date.now()).map((i) => ({ id: i.id, phone: maskPhone(i.phone), role: i.role, expiresAt: i.expires_at }));
  out.stations = db.prepare("SELECT id, name, last_seen_at, last_ip, created_at FROM stations WHERE kind = 'paired' AND site = ? AND device = ? ORDER BY created_at")
    .all(me.notify_site, me.notify_device).map((s) => ({ id: s.id, name: s.name, lastSeenAt: s.last_seen_at, ip: s.last_ip, createdAt: s.created_at }));
  return out;
}

/* ------------------------------------------------------- nhận thiết bị */
export function startClaim(db, user, { site, device, ip }) {
  const s = String(site || '').trim(); const d = String(device || 'plc01').trim();
  if (!SAFE.test(s) || !SAFE.test(d)) return { error: 'invalid_site_or_device', status: 400 };
  if (s === user.notify_site && d === user.notify_device) return { error: 'already_yours', status: 409 };
  if (ownsOthers(db, user)) return { error: 'owner_has_members', status: 409 };
  if (countAudit(db, user.id, 'site_claim_start', Date.now() - DAY) >= 10) return { error: 'rate_limited', status: 429 };
  const taken = db.prepare('SELECT 1 FROM users WHERE notify_site = ? AND notify_device = ? AND disabled = 0 AND id != ?').get(s, d, user.id);
  if (taken) return { error: 'site_taken', status: 409 }; // đã có người dùng: hãy nhờ chủ site mời
  if (!plcSnapshot(s, d).fresh) return { error: 'device_offline', status: 404 };
  const bit = pickProofBit();
  claims.set(user.id, { site: s, device: d, bit, since: Date.now(), expires: Date.now() + CLAIM_WINDOW });
  audit(db, 'site_claim_start', { userId: user.id, ip, detail: `${s}/${d}` });
  return { ok: true, bit, expiresIn: CLAIM_WINDOW / 1000 };
}

export function checkClaim(db, user, { ip }) {
  const c = claims.get(user.id);
  if (!c) return { error: 'claim_not_started', status: 404 };
  if (Date.now() > c.expires) { claims.delete(user.id); return { error: 'claim_expired', status: 410 }; }
  if (!edgeSince(c.site, c.device, c.bit, c.since)) return { ok: true, waiting: true, bit: c.bit };
  claims.delete(user.id);
  // kiểm tra lại: trong lúc chờ có thể đã có người khác nhận
  if (db.prepare('SELECT 1 FROM users WHERE notify_site = ? AND notify_device = ? AND disabled = 0 AND id != ?').get(c.site, c.device, user.id)) {
    return { error: 'site_taken', status: 409 };
  }
  const u = moveUser(db, user.id, c.site, c.device, { owner: true });
  audit(db, 'site_claimed', { userId: user.id, ip, detail: `${c.site}/${c.device}` });
  return { ok: true, claimed: true, site: u.notify_site, device: u.notify_device };
}

/* ----------------------------------------------------------- mời / gỡ */
async function tryTelegram(db, phone, html) {
  try {
    if (!telegramConfigured()) return;
    const tg = await resolveTelegramUser(db, phone);
    if (tg?.chat_id) await sendTelegramMessage(tg.chat_id, html);
  } catch (e) {
    console.error('invite notify', e.message);
  }
}

export async function createInvite(db, owner, { phone, role, ip }) {
  const me = getUser(db, owner.id);
  const p = normalizePhone(phone);
  if (!isValidVnPhone(p)) return { error: 'invalid_phone', status: 400 };
  const r = INVITE_ROLES.includes(role) ? role : 'operator';
  if (p === normalizePhone(me.phone || me.username)) return { error: 'same_phone', status: 400 };
  const exist = db.prepare('SELECT id, notify_site, notify_device FROM users WHERE (phone = ? OR username = ?) AND disabled = 0').get(p, p);
  if (exist && exist.notify_site === me.notify_site && exist.notify_device === me.notify_device) return { error: 'already_member', status: 409 };
  if (countAudit(db, me.id, 'site_invite', Date.now() - DAY) >= 20) return { error: 'rate_limited', status: 429 };
  db.prepare("UPDATE site_invites SET status = 'cancelled' WHERE site = ? AND device = ? AND phone = ? AND status = 'pending'").run(me.notify_site, me.notify_device, p);
  const id = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  db.prepare("INSERT INTO site_invites (id, site, device, phone, role, invited_by, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
    .run(id, me.notify_site, me.notify_device, p, r, me.id, now, now + INVITE_TTL);
  audit(db, 'site_invite', { userId: me.id, ip, detail: `${p} ${r}` });
  const url = (process.env.WEBAPP_PUBLIC_URL || '').replace(/\/$/, '');
  tryTelegram(db, p, `<b>📨 Lời mời vào nhà máy</b>\n${esc(maskPhone(me.phone || ''))} mời bạn tham gia <b>${esc(me.notify_site)}/${esc(me.notify_device)}</b> với quyền <b>${r === 'viewer' ? 'chỉ xem' : 'điều khiển'}</b>.\nĐăng nhập ${url ? esc(url) : 'ứng dụng'} để chấp nhận (hiệu lực 7 ngày).`);
  return { ok: true, id, role: r, expiresAt: now + INVITE_TTL };
}

export function cancelInvite(db, owner, id, { ip }) {
  const me = getUser(db, owner.id);
  const n = db.prepare("UPDATE site_invites SET status = 'cancelled' WHERE id = ? AND site = ? AND device = ? AND status = 'pending'").run(String(id), me.notify_site, me.notify_device).changes;
  if (!n) return { error: 'not_found', status: 404 };
  audit(db, 'site_invite_cancelled', { userId: me.id, ip, detail: String(id) });
  return { ok: true };
}

export function answerInvite(db, user, id, accept, { ip }) {
  const me = getUser(db, user.id);
  const inv = db.prepare("SELECT * FROM site_invites WHERE id = ? AND status = 'pending'").get(String(id));
  if (!inv || inv.phone !== normalizePhone(me.phone || me.username)) return { error: 'not_found', status: 404 };
  if (Date.now() > inv.expires_at) {
    db.prepare("UPDATE site_invites SET status = 'expired' WHERE id = ?").run(inv.id);
    return { error: 'invite_expired', status: 410 };
  }
  if (!accept) {
    db.prepare("UPDATE site_invites SET status = 'declined' WHERE id = ?").run(inv.id);
    return { ok: true };
  }
  if (ownsOthers(db, me)) return { error: 'owner_has_members', status: 409 };
  const role = me.role === 'admin' ? 'admin' : inv.role;
  const u = moveUser(db, me.id, inv.site, inv.device, { role, owner: false });
  db.prepare("UPDATE site_invites SET status = 'accepted' WHERE id = ?").run(inv.id);
  audit(db, 'site_invite_accepted', { userId: me.id, ip, detail: `${inv.site}/${inv.device} ${role}` });
  const inviter = getUser(db, inv.invited_by);
  if (inviter) notifyOwner(db, inviter, { subject: 'Thành viên mới', html: `<b>👤 ${esc(maskPhone(me.phone || ''))} đã chấp nhận lời mời</b> vào ${esc(inv.site)}/${esc(inv.device)}.` });
  return { ok: true, site: u.notify_site, device: u.notify_device, role: u.role };
}

export function removeMember(db, owner, memberId, { ip }) {
  const me = getUser(db, owner.id);
  const m = getUser(db, Number(memberId));
  if (!m || m.notify_site !== me.notify_site || m.notify_device !== me.notify_device) return { error: 'not_found', status: 404 };
  if (m.id === me.id || m.site_owner === 1) return { error: 'cannot_remove_owner', status: 409 };
  const p = normalizePhone(m.phone || m.username);
  moveUser(db, m.id, `s${p}`, 'plc01', { owner: true });
  db.prepare('UPDATE control_sessions SET revoked = 1 WHERE user_id = ?').run(m.id); // mất quyền điều khiển ngay
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(m.id);
  audit(db, 'site_member_removed', { userId: me.id, ip, detail: String(m.id) });
  notifyOwner(db, m, { subject: 'Bạn đã bị gỡ khỏi nhà máy', html: `<b>🚪 Bạn không còn là thành viên của ${esc(me.notify_site)}/${esc(me.notify_device)}.</b>` });
  return { ok: true };
}

/** Test/bảo trì: dọn lời mời quá hạn. */
export function sweepInvites(db) {
  db.prepare("UPDATE site_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(Date.now());
}
