import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { configure, emailChannelAvailable, htmlToText, hashPassword } from '@plciot/security';
import { upsertUser, upsertTelegramUser, findUserById } from './db.js';
import { copyDir, resolveBundleRoot } from './bundle.js';
import { shellVersion } from './bundleSync.js';
import { resolveTelegramUser } from './sharedTg.js';
import { sendTelegramMessage, telegramConfigured } from './telegram.js';
import { sendEmail, emailConfigured, isValidEmail } from './mailer.js';
import { provisionUserMqtt } from './mqttProvision.js';
import { retentionInfo } from './retention.js';
import { applyDefaultSubscription, subscriptionInfo } from './entitlements.js';
import { plcSnapshot, edgeSince, pickProofBit } from './plcProof.js';

export async function notifyOwner(db, user, { subject, html, text }) {
  const jobs = [];
  if (user?.chat_id && telegramConfigured()) jobs.push(sendTelegramMessage(user.chat_id, html || text || subject));
  if (user?.email && user.email_verified && emailConfigured()) jobs.push(sendEmail(user.email, subject, text || htmlToText(html)));
  const results = await Promise.allSettled(jobs);
  return { delivered: results.some((result) => result.status === 'fulfilled'), failed: results.filter((result) => result.status === 'rejected').length };
}

configure({
  notify: notifyOwner,
  email: {
    configured: emailConfigured, available: emailChannelAvailable, validate: isValidEmail,
    send: (user, subject, text) => sendEmail(user.email, subject, text), sendAddress: sendEmail,
  },
  identity: {
    contact: (user) => user.chat_id ? String(user.chat_id) : null,
    resolveContact: async (db, phone) => { const found = await resolveTelegramUser(db, phone); return found?.chat_id ? String(found.chat_id) : null; },
    sendCode: (contact, code, purpose) => sendTelegramMessage(Number(contact), `<b>${purpose}</b>\n\n<code>${code}</code>\n\nMã có hiệu lực 5 phút. Không chia sẻ mã này.`),
    findContactOwner: (db, contact, userId) => db.prepare('SELECT id FROM users WHERE chat_id = ? AND id != ?').get(contact, userId),
    unavailableError: 'telegram_not_linked', sendError: 'telegram_send_failed',
    createAccount: async (db, { phone, contact, dataDir, webappSrc }) => {
      if (!fs.existsSync(webappSrc)) return { error: 'webapp_src_missing', status: 500 };
      const folder = `u${phone}`;
      copyDir(webappSrc, resolveBundleRoot(dataDir, folder));
      const user = upsertUser(db, {
        username: phone, phone, chatId: Number(contact), folderPath: folder, version: shellVersion(webappSrc),
        passwordHash: hashPassword(crypto.randomBytes(24).toString('hex')), notifySite: `s${phone}`, notifyDevice: 'plc01',
      });
      const provisioned = provisionUserMqtt(db, user).user;
      // Thống nhất với thiết bị/partner: gói mặc định (monitor), admin kích hoạt pro trên Console
      applyDefaultSubscription(db, provisioned.id);
      return findUserById(db, provisioned.id);
    },
    applyContact: (db, user, contact, phone) => {
      db.prepare('UPDATE users SET chat_id = ? WHERE id = ?').run(Number(contact), user.id);
      upsertTelegramUser(db, phone, Number(contact));
    },
    beforePhoneApplied: async (db, user) => {
      const result = provisionUserMqtt(db, user, { rotate: true });
      if (!result.provision.password.ok || !result.provision.reload.ok) throw new Error('credential_rotation_failed');
      if (result.provision.reload.via === 'socket') {
        await new Promise((resolve, reject) => {
          const container = process.env.MQTT_DOCKER_CONTAINER || 'plciot-mqtt';
          const request = http.request({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock', method: 'POST',
            path: `/containers/${encodeURIComponent(container)}/kill?signal=HUP` }, (response) => {
            response.resume();
            if (response.statusCode >= 200 && response.statusCode < 300) resolve(); else reject(new Error('credential_rotation_failed'));
          });
          request.on('error', reject);
          request.setTimeout(5000, () => request.destroy(new Error('credential_rotation_failed')));
          request.end();
        });
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