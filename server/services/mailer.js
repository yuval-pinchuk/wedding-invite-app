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
  // #region agent log
  {
    const passRaw = String(process.env.SMTP_PASS || '');
    const passCompact = passRaw.replace(/\s+/g, '');
    fetch('http://127.0.0.1:7256/ingest/61c79d4c-5ece-4783-9102-c3a6465a4cec',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'82d556'},body:JSON.stringify({sessionId:'82d556',runId:'smtp-auth',hypothesisId:'A',location:'mailer.js:sendMail',message:'smtp auth preflight',data:{host:String(process.env.SMTP_HOST||''),userSet:Boolean(process.env.SMTP_USER),passLen:passRaw.length,passCompactLen:passCompact.length,looksLikeAppPassword:passCompact.length===16&&/^[a-zA-Z0-9]+$/.test(passCompact),secure:String(process.env.SMTP_SECURE||''),port:Number(process.env.SMTP_PORT||587)},timestamp:Date.now()})}).catch(()=>{});
  }
  // #endregion
  try {
    await transport().sendMail({
      from: stripEnvQuotes(process.env.SMTP_FROM),
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    // #region agent log
    fetch('http://127.0.0.1:7256/ingest/61c79d4c-5ece-4783-9102-c3a6465a4cec',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'82d556'},body:JSON.stringify({sessionId:'82d556',runId:'smtp-auth',hypothesisId:'E',location:'mailer.js:sendMail',message:'smtp send ok',data:{delivered:true},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return { delivered: true };
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7256/ingest/61c79d4c-5ece-4783-9102-c3a6465a4cec',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'82d556'},body:JSON.stringify({sessionId:'82d556',runId:'smtp-auth',hypothesisId:'A',location:'mailer.js:sendMail',message:'smtp send failed',data:{code:error?.code||'',responseCode:error?.responseCode||null,command:error?.command||'',responseSnippet:String(error?.response||error?.message||'').slice(0,180)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    console.error('[mail] send failed:', error?.code || '', error?.responseCode || '', error?.message || error);
    return { delivered: false, error: error?.code || 'SEND_FAILED' };
  }
}
