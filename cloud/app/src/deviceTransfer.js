/**
 * Ownership change of a device namespace (plc/<site>/<device>) and history wipe.
 * The previous owner's history must never reach the new owner, so the transfer
 * always erases stored events, hands the namespace over, and rotates broker credentials.
 */
import { findUserById } from './db.js';
import { wipeDeviceHistory } from './retention.js';
import { provisionUserMqtt } from './mqttProvision.js';
import { audit } from '@plciot/security';
import { notifyOwner } from './accountSecurity.js';

/** Owner-initiated: erase all stored history of own device (before selling, etc.). */
export function wipeOwnHistory(db, user, { reauthed, ip }) {
  if (reauthed !== true) {
    return { error: 'invalid_credentials', status: 401 };
  }
  const deleted = wipeDeviceHistory(db, user.notify_site, user.notify_device);
  audit(db, 'history_wiped', { userId: user.id, ip, detail: `${user.notify_site}/${user.notify_device} rows=${deleted}` });
  return { ok: true, deleted };
}

/**
 * Admin: move `from`'s device namespace to `to`. `from` is parked on a fresh empty namespace.
 * The gateway keeps publishing to the same topic, so the new owner sees live data immediately.
 */
export async function transferDevice(db, fromId, toId, { admin = 'admin' } = {}) {
  const from = findUserById(db, fromId);
  const to = findUserById(db, toId);
  if (!from || !to) return { error: 'user_not_found' };
  if (from.id === to.id) return { error: 'same_user' };
  const { notify_site: site, notify_device: device } = from;

  const wiped = wipeDeviceHistory(db, site, device);
  const parkedSite = `s${from.phone || from.username}`;
  const parkedDevice = 'plc01';
  // Never park on the namespace we just handed over.
  const parked = parkedSite === site && parkedDevice === device
    ? { site: `${parkedSite}-old`, device: parkedDevice } : { site: parkedSite, device: parkedDevice };

  db.transaction(() => {
    db.prepare('UPDATE users SET notify_site = ?, notify_device = ?, token_version = token_version + 1 WHERE id = ?')
      .run(parked.site, parked.device, from.id);
    db.prepare('UPDATE users SET notify_site = ?, notify_device = ?, token_version = token_version + 1 WHERE id = ?')
      .run(site, device, to.id);
  })();

  // New ACL scopes + rotated passwords; old sessions die via token_version.
  for (const id of [from.id, to.id]) {
    try { provisionUserMqtt(db, findUserById(db, id), { rotate: true }); } catch (e) { console.error('transfer provision', e.message); }
  }
  audit(db, 'device_transferred_out', { userId: from.id, detail: `${site}/${device} → user ${to.id} by ${admin}, wiped ${wiped}` });
  audit(db, 'device_transferred_in', { userId: to.id, detail: `${site}/${device} from user ${from.id} by ${admin}` });
  const text = `Thiết bị ${site}/${device} đã được chuyển quyền sở hữu. Dữ liệu lịch sử cũ đã bị xoá; hãy đăng nhập lại.`;
  notifyOwner(db, from, { subject: 'Thiết bị đã được chuyển quyền', text });
  notifyOwner(db, to, { subject: 'Bạn đã nhận quyền thiết bị', text });
  return { ok: true, site, device, wiped, parked };
}
