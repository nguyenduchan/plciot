import nodemailer from 'nodemailer';

let transport = null;

/** SMTP_URL e.g. smtps://user:pass@smtp.example.com:465 ; MAIL_FROM e.g. "PLC <no-reply@example.com>" */
export function emailConfigured() {
  return Boolean(process.env.SMTP_URL);
}

export async function sendEmail(to, subject, text) {
  if (!emailConfigured()) throw new Error('SMTP_URL missing');
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL);
  await transport.sendMail({
    from: process.env.MAIL_FROM || 'PLC <no-reply@localhost>',
    to,
    subject,
    text,
  });
}

export function isValidEmail(s) {
  return typeof s === 'string' && s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}
