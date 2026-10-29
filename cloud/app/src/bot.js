import TelegramBot from 'node-telegram-bot-api';
import { upsertTelegramUser, findUserByPhone } from './db.js';
import { normalizePhone, isValidVnPhone, formatVnLocal } from './phone.js';
import { telegramConfigured } from './telegram.js';
import { canBindVerifiedContact } from '@plciot/security';

/**
 * Optional local long-polling bot.
 * When sharing a bot with mqtt_server, keep TELEGRAM_BOT_POLLING=false
 * (only one process may call getUpdates). mqtt_server/telegram_bot owns /start + contact.
 */
export function startTelegramBot(db) {
  if (!telegramConfigured()) {
    console.warn('TELEGRAM_BOT_TOKEN not set — Telegram send disabled');
    return null;
  }
  const polling = String(process.env.TELEGRAM_BOT_POLLING || 'false').toLowerCase() === 'true';
  if (!polling) {
    console.log('Telegram bot polling off — dùng chung bot với mqtt_server (chỉ sendMessage)');
    return null;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId,
      'Chào mừng Giám sát PLC!\n\n'
      + 'Tài khoản = số điện thoại Việt Nam.\n'
      + 'Nhấn nút bên dưới để chia sẻ SĐT (đồng bộ Telegram ↔ webapp).',
      {
        reply_markup: {
          keyboard: [[{ text: '📍 Chia sẻ số điện thoại VN', request_contact: true }]],
          one_time_keyboard: true,
          resize_keyboard: true,
        },
      });
  });

  bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const contact = msg.contact;
    if (!contact?.phone_number) {
      await bot.sendMessage(chatId, 'Không nhận được số điện thoại. Thử lại /start.');
      return;
    }
    const evidence = { actorId: msg.from?.id, contactOwnerId: contact.user_id, isPrivate: msg.chat.type === 'private', newContact: chatId };
    if (!canBindVerifiedContact(evidence)) {
      await bot.sendMessage(chatId, 'Vui lòng chia sẻ số điện thoại của chính bạn.');
      return;
    }
    try {
      const phone = normalizePhone(contact.phone_number);
      if (!isValidVnPhone(phone)) {
        await bot.sendMessage(chatId,
          '❌ Cần số di động Việt Nam (ví dụ 09xxxxxxxx).\nThử lại /start.');
        return;
      }
      const appUser = findUserByPhone(db, phone);
      if (!canBindVerifiedContact({ ...evidence, currentContact: appUser?.chat_id })) {
        await bot.sendMessage(chatId, 'Số này đã có kênh xác thực. Hãy đổi kênh qua quy trình khôi phục trong ứng dụng.');
        return;
      }
      upsertTelegramUser(db, phone, chatId);
      if (appUser) {
        // Only refresh the Telegram link; username/phone change solely via the verified
        // change-phone flow (accountSecurity.js), never as a side effect of sharing a contact.
        db.prepare('UPDATE users SET chat_id = ? WHERE id = ?').run(chatId, appUser.id);
      }
      await bot.sendMessage(chatId,
        `✅ Đã liên kết ${formatVnLocal(phone)} (+${phone}).\n`
        + 'Username webapp = số này. Quay lại app để đăng ký/OTP.',
        { reply_markup: { remove_keyboard: true } });
    } catch (e) {
      console.error('telegram contact save', e);
      await bot.sendMessage(chatId, '❌ Lỗi lưu số điện thoại. Thử lại sau.');
    }
  });

  bot.on('polling_error', (err) => {
    console.error('telegram polling_error', err?.message || err);
  });

  console.log('Telegram bot polling started');
  return bot;
}
