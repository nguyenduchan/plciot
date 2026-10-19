const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';

export function telegramConfigured() {
  return Boolean(TOKEN());
}

export async function sendTelegramMessage(chatId, text, extra = {}) {
  const token = TOKEN();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    ...extra,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.description || `Telegram HTTP ${res.status}`);
  }
  return data;
}

export function otpMessage(code) {
  return (
    `<b>🔐 Mã xác thực (OTP) của bạn là:</b>\n\n` +
    `<code>${code}</code>\n\n` +
    `<i>Mã có hiệu lực trong 5 phút. Không chia sẻ mã này.</i>`
  );
}

export function countDoneMessage({ site, device, count, target, appUrl }) {
  const link = appUrl.replace(/\/$/, '') + '/';
  return (
    `<b>✅ Băng tải đã đếm đủ</b>\n\n` +
    `Nhà máy: <code>${site}</code> / thiết bị <code>${device}</code>\n` +
    `Số lượng: <b>${count}</b> / ${target}\n\n` +
    `👉 <a href="${link}">Mở Giám sát PLC</a>`
  );
}
