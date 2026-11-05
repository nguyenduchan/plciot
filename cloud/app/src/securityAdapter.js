import fs from 'node:fs';
import crypto from 'node:crypto';
import { configure, htmlToText, hashPassword } from '@plciot/security';
import { upsertUser, findUserById } from './db.js';
import { copyDir, resolveBundleRoot } from './bundle.js';
import { shellVersion } from './bundleSync.js';
import { provisionUserMqtt } from './mqttProvision.js';
import { retentionInfo } from './retention.js';
import { applyDefaultSubscription, subscriptionInfo } from './entitlements.js';
import { plcSnapshot, edgeSince, pickProofBit } from './plcProof.js';
import { audit } from '@plciot/security';

/** Notify chỉ ghi audit (không Telegram/email). */
export async function notifyOwner(db, user, { subject, html, text }) {
  try {
    audit(db, 'notify_local', {
      userId: user?.id,
      detail: subject || text || (html ? htmlToText(html).slice(0, 200) : ''),
    });
  } catch { /* ignore */ }
  return { delivered: true, failed: 0 };
}

configure({
  notify: notifyOwner,
  identity: {
    /** Tạo user ẩn danh gắn site/device (claim QR hoặc invite). */
    createAccount: async (db, { site, device, webappSrc, role = 'operator', owner = true, username: chosen } = {}) => {
      if (!fs.existsSync(webappSrc)) return { error: 'webapp_src_missing', status: 500 };
      const username = chosen || `u_${crypto.randomBytes(8).toString('hex')}`;
      const siteId = String(site || 'device').trim();
      const deviceId = String(device || 'plc01').trim();
      const user = upsertUser(db, {
        username,
        folderPath: `u_${username}`,
        version: shellVersion(webappSrc),
        passwordHash: hashPassword(crypto.randomBytes(24).toString('hex')),
        notifySite: siteId,
        notifyDevice: deviceId,
      });
      db.prepare('UPDATE users SET setup_complete = 0, site_owner = ?, role = ? WHERE id = ?')
        .run(owner ? 1 : 0, role === 'viewer' ? 'viewer' : (role === 'admin' ? 'admin' : 'operator'), user.id);
      return findUserById(db, user.id);
    },
    activateAccount: async (db, user, { dataDir, webappSrc }) => {
      if (!fs.existsSync(webappSrc)) return { error: 'webapp_src_missing', status: 500 };
      const folder = user.folder_path || `u_${user.username || user.id}`;
      copyDir(webappSrc, resolveBundleRoot(dataDir, folder));
      const provisioned = provisionUserMqtt(db, user).user;
      applyDefaultSubscription(db, provisioned.id);
      return { ok: true };
    },
    /** Sau khi user đã login gắn QR tem → xoay MQTT ACL theo site/device mới. */
    onDeviceClaimed: async (db, user, { site, device }) => {
      try {
        provisionUserMqtt(db, user, { site, device, rotate: true });
        return { ok: true };
      } catch (e) {
        console.error('onDeviceClaimed', e.message);
        return { error: 'provision_failed', status: 500 };
      }
    },
  },
  accountExtra: (user) => ({ ...retentionInfo(user), subscription: subscriptionInfo(user) }),
  presence: {
    enabled: true,
    start: (_db, user) => plcSnapshot(user.notify_site, user.notify_device).fresh ? { bit: pickProofBit() } : { error: 'plc_offline', status: 409 },
    check: (_db, user, request) => ({ ok: edgeSince(user.notify_site, user.notify_device, request.plc_bit, request.plc_base) }),
  },
});
