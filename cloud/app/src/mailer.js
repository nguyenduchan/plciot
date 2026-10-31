import nodemailer from 'nodemailer';

let transport = null;

/**
 * Cấu hình gửi email, hai cách (cách 1 ưu tiên nếu có đủ):
 *   1) SMTP_USER + SMTP_PASSWORD (mặc định Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465). Mật khẩu ứng dụng Gmail 16 ký tự, khoảng trắng tự bỏ.
 *   2) SMTP_URL đầy đủ, vd smtps://user:pass@smtp.example.com:465
 * MAIL_FROM vd "Giám sát PLC <no-reply@example.com>"; để trống thì dùng SMTP_USER.
 */
const smtpUser = () => String(process.env.SMTP_USER || '').trim();
const smtpPassword = () => String(process.env.SMTP_PASSWORD || '').replace(/\s/g, '');

export function emailConfigured() {
  return Boolean((smtpUser() && smtpPassword()) || process.env.SMTP_URL);
}

function createTransport() {
  if (smtpUser() && smtpPassword()) {
    const port = Number(process.env.SMTP_PORT) || 465;
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: smtpUser(), pass: smtpPassword() },
    });
  }
  return nodemailer.createTransport(process.env.SMTP_URL);
}

export async function sendEmail(to, subject, text) {
  if (!emailConfigured()) throw new Error('SMTP not configured');
  if (!transport) transport = createTransport();
  await transport.sendMail({
    from: process.env.MAIL_FROM || (smtpUser() ? `Giám sát PLC <${smtpUser()}>` : 'PLC <no-reply@localhost>'),
    to,
    subject,
    text,
  });
}

export function isValidEmail(s) {
  return typeof s === 'string' && s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}
