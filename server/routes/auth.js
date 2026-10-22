import express from 'express';
import { getServiceAccountEmail, readHeaderRow } from '../services/googleSheets.js';
import { sendMail } from '../services/mailer.js';
import { seedPaymentFile } from '../services/paymentRouting.js';
import {
  createAccount,
  findAccountByEmail,
  issueResetCode,
  issueUnlockCode,
  publicAccount,
  recordFailedLogin,
  resetPassword,
  unlockWithCode,
  updateAccount,
  verifyPassword,
  verifyResetCode,
  clearLoginFailures,
} from '../services/accounts.js';
import {
  accountFromRequest,
  clearSessionCookie,
  createSession,
  destroySessionToken,
  readCookie,
  requireAccount,
  setSessionCookie,
} from '../services/sessions.js';

const router = express.Router();

function sheetIdFromInput(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : text;
}

router.get('/setup', (_req, res) => {
  res.json({
    success: true,
    serviceAccountEmail: getServiceAccountEmail() || '',
  });
});

router.get('/me', (req, res) => {
  const account = accountFromRequest(req);
  if (!account) return res.status(401).json({ success: false, error: 'יש להתחבר' });
  return res.json({ success: true, account: publicAccount(account) });
});

router.post('/register', async (req, res) => {
  try {
    const body = req.body || {};
    const account = await createAccount({
      ...body,
      guestSheetId: sheetIdFromInput(body.guestSheetId),
      responseSheetId: sheetIdFromInput(body.responseSheetId),
    });
    if (account.paymentSeed) {
      seedPaymentFile(account.id, account.paymentSeed);
    }
    setSessionCookie(res, createSession(account));
    res.json({ success: true, account: publicAccount(account) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'יצירת החשבון נכשלה' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const account = findAccountByEmail(email);
    if (!account) {
      return res.status(401).json({ success: false, error: 'אימייל או סיסמה שגויים' });
    }
    if (account.locked) {
      const code = issueUnlockCode(account);
      await sendMail({
        to: account.email,
        subject: 'פתיחת חשבון ההזמנות',
        text: `החשבון נעול אחרי ניסיונות התחברות כושלים.\nקוד הפתיחה: ${code}\nהקוד תקף ל-15 דקות.`,
      });
      return res.status(423).json({
        success: false,
        locked: true,
        error: 'החשבון נעול. נשלח קוד לאימייל לאימות.',
      });
    }
    const ok = await verifyPassword(password, account.passwordHash);
    if (!ok) {
      const result = await recordFailedLogin(account);
      if (result.locked) {
        await sendMail({
          to: account.email,
          subject: 'החשבון ננעל',
          text: `הזנתם סיסמה שגויה 5 פעמים.\nקוד הפתיחה: ${result.unlockCode}\nהקוד תקף ל-15 דקות.`,
        });
        return res.status(423).json({
          success: false,
          locked: true,
          error: 'החשבון ננעל אחרי 5 ניסיונות. נשלח קוד לאימייל.',
        });
      }
      return res.status(401).json({ success: false, error: 'אימייל או סיסמה שגויים' });
    }
    clearLoginFailures(account);
    setSessionCookie(res, createSession(findAccountByEmail(email)));
    return res.json({ success: true, account: publicAccount(findAccountByEmail(email)) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'ההתחברות נכשלה' });
  }
});

router.post('/logout', (req, res) => {
  destroySessionToken(readCookie(req, 'sid'));
  clearSessionCookie(res);
  res.json({ success: true });
});

router.post('/unlock', (req, res) => {
  const result = unlockWithCode(req.body?.email, req.body?.code);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  return res.json({ success: true });
});

router.post('/forgot', async (req, res) => {
  const account = findAccountByEmail(req.body?.email);
  if (account) {
    const code = issueResetCode(account);
    await sendMail({
      to: account.email,
      subject: 'קוד איפוס סיסמה',
      text: `קוד איפוס הסיסמה שלכם: ${code}\nהקוד תקף ל-15 דקות.`,
    });
  }
  // Always succeed so we do not reveal whether the email exists.
  res.json({ success: true });
});

router.post('/verify-reset-code', (req, res) => {
  const result = verifyResetCode(req.body?.email, req.body?.code);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  return res.json({ success: true });
});

router.post('/reset', async (req, res) => {
  try {
    await resetPassword(req.body?.email, req.body?.code, req.body?.password);
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'איפוס הסיסמה נכשל' });
  }
});

router.get('/headers', requireAccount, async (req, res) => {
  try {
    const headers = await readHeaderRow(req.account.guestSheetId, req.account.sheetTab);
    res.json({ success: true, headers });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'לא הצלחנו לקרוא את שורת הכותרות. ודאו שהגיליון שותף עם חשבון השירות.',
    });
  }
});

router.post('/columns', requireAccount, (req, res) => {
  const columnMap = req.body?.columnMap || {};
  const account = updateAccount(req.account.id, { columnMap });
  res.json({ success: true, account: publicAccount(account) });
});

export default router;
