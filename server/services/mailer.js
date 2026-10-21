import nodemailer from 'nodemailer';

function smtpConfigured() {
  return Boolean(String(process.env.SMTP_HOST || '').trim() && String(process.env.SMTP_FROM || '').trim());
}

function transport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').trim() === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
  });
}

/**
 * Send a plain email. If SMTP is not configured, log the message so local setup still works.
 * @param {{ to: string, subject: string, text: string }} message
 */
export async function sendMail(message) {
  if (!smtpConfigured()) {
    console.warn(`[mail] SMTP not configured. To ${message.to}\n${message.subject}\n${message.text}`);
    return { delivered: false };
  }
  await transport().sendMail({
    from: process.env.SMTP_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
  return { delivered: true };
}
