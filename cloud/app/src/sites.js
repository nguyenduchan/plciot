/**
 * Nhà máy (site/device), chủ site và thành viên — danh tính theo thiết bị (QR), không SĐT/Telegram.
 *
 *   Claim thiết bị — sau đăng nhập, dán QR tem (POST /api/devices/claim, requireAuth).
 *   Mời thành viên — chủ tạo mã mời; người nhận redeem tại login.
 *   Gỡ thành viên  — về vùng riêng, rotate MQTT.
 */
import crypto from 'crypto';
import { audit, countAudit } from '@plciot/security';
import { provisionUserMqtt } from './mqttProvision.js';
import { notifyOwner } from './accountSecurity.js';
import { plcSnapshot } from './plcProof.js';

const SAFE = /^[a-zA-Z0-9_-]{1,48}$/;
const DAY = 86_400_000;
const INVITE_TTL = 7 * DAY;
const INVITE_ROLES = ['operator', 'viewer'];

const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const maskUser = (u) => {
  const n = String(u?.username || u?.id || '');
  return n.length > 8 ? `${n.slice(0, 4)}…${n.slice(-3)}` : n;
};

export function ensureOwner(db, site, device) {
  const has = db.prepare('SELECT 1 FROM users WHERE notify_site = ? AND notify_device = ? AND site_owner = 1 AND disabled = 0').get(site, device);
  if (has) return;
  const cand = db.prepare("SELECT id FROM users WHERE notify_site = ? AND notify_device = ? AND disabled = 0 AND role IN ('admin','operator') ORDER BY id LIMIT 1").get(site, device);
  if (cand) db.prepare('UPDATE users SET site_owner = 1 WHERE id = ?').run(cand.id);
}

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
    username: me.username,
    invitesIn: [],
  };
  out.memberCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE notify_site = ? AND notify_device = ? AND disabled = 0').get(me.notify_site, me.notify_device).n;
  if (!owner) return out;
  out.members = db.prepare('SELECT id, username, role, site_owner FROM users WHERE notify_site = ? AND notify_device = ? AND disabled = 0 ORDER BY site_owner DESC, id')
    .all(me.notify_site, me.notify_device).map((u) => ({
      id: u.id, username: u.username, role: u.role, owner: u.site_owner === 1, me: u.id === me.id,
    }));
  out.invitesOut = db.prepare("SELECT id, invite_token, role, expires_at FROM site_invites WHERE site = ? AND device = ? AND status = 'pending' AND expires_at > ?")
    .all(me.notify_site, me.notify_device, Date.now())
    .map((i) => ({
      id: i.id,
      code: i.invite_token || i.id,
      role: i.role,
      expiresAt: i.expires_at,
      qrPath: `/login.html?invite=${encodeURIComponent(i.invite_token || i.id)}`,
    }));
  out.stations = db.prepare("SELECT id, name, last_seen_at, last_ip, created_at FROM stations WHERE kind = 'paired' AND site = ? AND device = ? ORDER BY created_at")
    .all(me.notify_site, me.notify_device).map((s) => ({ id: s.id, name: s.name, lastSeenAt: s.last_seen_at, ip: s.last_ip, createdAt: s.created_at }));
  return out;
}

/** Claim vật lý (ngõ X) đã thay bằng QR — giữ stub tương thích. */
export function startClaim() {
  return { error: 'use_device_qr_claim', status: 410 };
}
export function checkClaim() {
  return { error: 'use_device_qr_claim', status: 410 };
}

/** Chủ tạo mã mời (token). Không cần SĐT. */
export async function createInvite(db, owner, { role, ip }) {
  const me = getUser(db, owner.id);
  const r = INVITE_ROLES.includes(role) ? role : 'operator';
  if (countAudit(db, me.id, 'site_invite', Date.now() - DAY) >= 20) return { error: 'rate_limited', status: 429 };
  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(12).toString('base64url');
  const now = Date.now();
  db.prepare("INSERT INTO site_invites (id, site, device, phone, invite_token, role, invited_by, status, created_at, expires_at) VALUES (?, ?, ?, '', ?, ?, ?, 'pending', ?, ?)")
    .run(id, me.notify_site, me.notify_device, token, r, me.id, now, now + INVITE_TTL);
  audit(db, 'site_invite', { userId: me.id, ip, detail: `${token} ${r}` });
  const url = (process.env.WEBAPP_PUBLIC_URL || '').replace(/\/$/, '');
  return {
    ok: true,
    id,
    code: token,
    role: r,
    expiresAt: now + INVITE_TTL,
    url: url ? `${url}/login.html?invite=${encodeURIComponent(token)}` : `login.html?invite=${encodeURIComponent(token)}`,
  };
}

export function cancelInvite(db, owner, id, { ip }) {
  const me = getUser(db, owner.id);
  const n = db.prepare("UPDATE site_invites SET status = 'cancelled' WHERE (id = ? OR invite_token = ?) AND site = ? AND device = ? AND status = 'pending'")
    .run(String(id), String(id), me.notify_site, me.notify_device).changes;
  if (!n) return { error: 'not_found', status: 404 };
  audit(db, 'site_invite_cancelled', { userId: me.id, ip, detail: String(id) });
  return { ok: true };
}

/** Chấp nhận lời mời khi đã có tài khoản (đường cũ). Redeem tạo tài khoản mới nằm ở /api/invites/redeem. */
export function answerInvite(db, user, id, accept, { ip }) {
  const me = getUser(db, user.id);
  const inv = db.prepare("SELECT * FROM site_invites WHERE (id = ? OR invite_token = ?) AND status = 'pending'").get(String(id), String(id));
  if (!inv) return { error: 'not_found', status: 404 };
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
  if (inviter) {
    notifyOwner(db, inviter, {
      subject: 'Thành viên mới',
      html: `<b>👤 ${esc(maskUser(me))} đã chấp nhận lời mời</b> vào ${esc(inv.site)}/${esc(inv.device)}.`,
    });
  }
  return { ok: true, site: u.notify_site, device: u.notify_device, role: u.role };
}

export function removeMember(db, owner, memberId, { ip }) {
  const me = getUser(db, owner.id);
  const m = getUser(db, Number(memberId));
  if (!m || m.notify_site !== me.notify_site || m.notify_device !== me.notify_device) return { error: 'not_found', status: 404 };
  if (m.id === me.id || m.site_owner === 1) return { error: 'cannot_remove_owner', status: 409 };
  const personal = `d_u${m.id}`;
  moveUser(db, m.id, personal, 'plc01', { owner: true });
  db.prepare('UPDATE control_sessions SET revoked = 1 WHERE user_id = ?').run(m.id);
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(m.id);
  audit(db, 'site_member_removed', { userId: me.id, ip, detail: String(m.id) });
  notifyOwner(db, m, {
    subject: 'Bạn đã bị gỡ khỏi nhà máy',
    html: `<b>🚪 Bạn không còn là thành viên của ${esc(me.notify_site)}/${esc(me.notify_device)}.</b>`,
  });
  return { ok: true };
}

/**
 * Người dùng xoá hết thiết bị của một nhà máy khỏi app → nhả tem (claimed_by = NULL) và đưa họ về vùng riêng,
 * để bất kỳ ai có QR (sau khi reset thiết bị) đều thêm lại được.
 * Không nhả khi còn thiết bị khác cùng nhà máy, hoặc còn thành viên khác dùng chung nhà máy.
 */
export function releaseSiteIfEmpty(db, userId, site, { ip } = {}) {
  const me = getUser(db, userId);
  if (!me) return { released: false };
  if (me.notify_site === site && ownsOthers(db, me)) return { released: false };
  // Thiết bị con luôn gắn với gateway hiện tại của người dùng (notify_device), nên đơn vị nhả là cả nhà máy:
  // còn thiết bị nào cùng nhà máy thì giữ nguyên tem.
  const left = db.prepare('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ? AND site = ?').get(userId, site).n;
  if (left > 0) return { released: false };
  const freed = db.prepare('UPDATE hardware_devices SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by = ? AND site = ?')
    .run(userId, site).changes;
  if (me.notify_site === site) moveUser(db, userId, `d_u${userId}`, 'plc01', { owner: true });
  audit(db, 'device_released', { userId, ip, detail: `${site}/${me.notify_device} freed=${freed}` });
  return { released: true, freed };
}

/**
 * Admin thu hồi tem đã dùng: gỡ thiết bị khỏi mọi tài khoản đang dùng nó, đưa các tài khoản đó về vùng riêng
 * (MQTT cấp lại, mất quyền theo topic cũ, thu hồi phiên điều khiển) và bỏ chủ (claimed_by = NULL).
 * Gọi trước khi cấp QR mới để người tiếp theo thêm được mà không bị `site_taken`.
 */
export function revokeDeviceBinding(db, site, device, { ip, adminId } = {}) {
  const ids = new Set(db.prepare('SELECT id FROM users WHERE notify_site = ? AND notify_device = ?').all(site, device).map((u) => u.id));
  const owner = db.prepare('SELECT claimed_by FROM hardware_devices WHERE site = ? AND device = ?').get(site, device)?.claimed_by;
  if (owner) ids.add(owner);
  const removed = db.prepare('DELETE FROM user_devices WHERE site = ? AND (gateway_device = ? OR child_id = ?)')
    .run(site, device, device).changes;
  let moved = 0;
  for (const id of ids) {
    const u = getUser(db, id);
    if (!u) continue;
    db.prepare('UPDATE control_sessions SET revoked = 1 WHERE user_id = ?').run(id);
    if (u.notify_site === site && u.notify_device === device) {
      moveUser(db, id, `d_u${id}`, 'plc01', { owner: true });
      moved += 1;
    }
  }
  db.prepare('UPDATE hardware_devices SET claimed_by = NULL, claimed_at = NULL WHERE site = ? AND device = ?').run(site, device);
  audit(db, 'device_revoked', { userId: adminId, ip, detail: `${site}/${device} users=${ids.size} removed=${removed}` });
  return { ok: true, users: ids.size, moved, removedDevices: removed };
}

export function sweepInvites(db) {
  db.prepare("UPDATE site_invites SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").run(Date.now());
}
