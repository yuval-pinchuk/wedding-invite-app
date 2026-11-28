import nodemailer from 'nodemailer';

function stripEnvQuotes(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function smtpPass() {
  // Gmail app passwords are often pasted with spaces; nodemailer needs a non-empty pass.
  return stripEnvQuotes(process.env.SMTP_PASS).replace(/\s+/g, '');
}

function smtpConfigured() {
  return Boolean(
    stripEnvQuotes(process.env.SMTP_HOST)
    && stripEnvQuotes(process.env.SMTP_FROM)
    && stripEnvQuotes(process.env.SMTP_USER)
    && smtpPass()
  );
}

function transport() {
  return nodemailer.createTransport({
    host: stripEnvQuotes(process.env.SMTP_HOST),
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').trim() === 'true',
    auth: {
      user: stripEnvQuotes(process.env.SMTP_USER),
      pass: smtpPass(),
    },
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
  try {
    await transport().sendMail({
      from: stripEnvQuotes(process.env.SMTP_FROM),
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return { delivered: true };
  } catch (error) {
    console.error('[mail] send failed:', error?.code || '', error?.responseCode || '', error?.message || error);
    return { delivered: false, error: error?.code || 'SEND_FAILED' };
  }
}
