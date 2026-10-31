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
    // Mã nằm ngay dòng đầu để xem được cả trong bản xem trước thông báo; hạn theo OTP_CODE_TTL_SEC.
    // Gửi đồng thời Telegram và (nếu tài khoản có email đã xác minh, qua thời gian chờ, và máy chủ bật SMTP) email: cùng một mã, dùng kênh nào cũng được.
    // Chỉ coi là lỗi khi không kênh nào gửi được.
    sendCode: async (contact, code, purpose, { user } = {}) => {
      const ttl = Math.min(600, Math.max(60, Number(process.env.OTP_CODE_TTL_SEC) || 180));
      const hh = ttl % 60 === 0 ? `${ttl / 60} phút` : `${ttl} giây`;
      const jobs = [sendTelegramMessage(Number(contact), `🔐 Mã OTP: <code>${code}</code>\n<b>${purpose}</b>\n\nMã có hiệu lực ${hh}. Không chia sẻ mã này.`)];
      if (user && emailChannelAvailable(user)) {
        jobs.push(sendEmail(user.email, `Mã OTP ${code} — Giám sát PLC`, `Mã OTP của bạn: ${code}\n${purpose}. Mã có hiệu lực ${hh}.\nKhông chia sẻ mã này. Nếu không phải bạn yêu cầu, hãy bỏ qua email này.`));
      }
      const results = await Promise.allSettled(jobs);
      if (!results.some((r) => r.status === 'fulfilled')) throw results[0].reason;
    },
    findContactOwner: (db, contact, userId) => db.prepare('SELECT id FROM users WHERE chat_id = ? AND id != ?').get(contact, userId),
    unavailableError: 'telegram_not_linked', sendError: 'telegram_send_failed',
    // Sau OTP chỉ tạo dòng tạm (chưa có gói dữ liệu, chưa có tài khoản MQTT); activateAccount làm phần còn lại khi hoàn tất mọi bước.
    createAccount: async (db, { phone, contact, webappSrc }) => {
      if (!fs.existsSync(webappSrc)) return { error: 'webapp_src_missing', status: 500 };
      return upsertUser(db, {
        username: phone, phone, chatId: Number(contact), folderPath: `u${phone}`, version: shellVersion(webappSrc),
        passwordHash: hashPassword(crypto.randomBytes(24).toString('hex')), notifySite: `s${phone}`, notifyDevice: 'plc01',
      });
    },
    activateAccount: async (db, user, { dataDir, webappSrc }) => {
      if (!fs.existsSync(webappSrc)) return { error: 'webapp_src_missing', status: 500 };
      copyDir(webappSrc, resolveBundleRoot(dataDir, user.folder_path || `u${user.phone}`));
      const provisioned = provisionUserMqtt(db, user).user;
      // Thống nhất với thiết bị/partner: gói mặc định (monitor), admin kích hoạt pro trên Console
      applyDefaultSubscription(db, provisioned.id);
      return { ok: true };
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