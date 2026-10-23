import express from 'express';
import { getServiceAccountEmail, readHeaderRow } from '../services/googleSheets.js';
import { sendMail } from '../services/mailer.js';
import { getPaymentSeedUrls, seedPaymentFile, updatePaymentSeedUrls } from '../services/paymentRouting.js';
import {
  createAccount,
  findAccountByEmail,
  issueResetCode,
  issueUnlockCode,
  normalizeBabyMaxAge,
  publicAccount,
  recordFailedLogin,
  resetPassword,
  saveInviteImage,
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

router.get('/me', async (req, res) => {
  const account = await accountFromRequest(req);
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
      await seedPaymentFile(account.id, account.paymentSeed);
    }
    setSessionCookie(res, await createSession(account));
    res.json({ success: true, account: publicAccount(account) });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'יצירת החשבון נכשלה' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const account = await findAccountByEmail(email);
    if (!account) {
      return res.status(401).json({ success: false, error: 'אימייל או סיסמה שגויים' });
    }
    if (account.locked) {
      const code = await issueUnlockCode(account);
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
    await clearLoginFailures(account);
    const fresh = await findAccountByEmail(email);
    setSessionCookie(res, await createSession(fresh));
    return res.json({ success: true, account: publicAccount(fresh) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'ההתחברות נכשלה' });
  }
});

router.post('/logout', async (req, res) => {
  await destroySessionToken(readCookie(req, 'sid'));
  clearSessionCookie(res);
  res.json({ success: true });
});

router.post('/unlock', async (req, res) => {
  const result = await unlockWithCode(req.body?.email, req.body?.code);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  return res.json({ success: true });
});

router.post('/forgot', async (req, res) => {
  const account = await findAccountByEmail(req.body?.email);
  if (account) {
    const code = await issueResetCode(account);
    await sendMail({
      to: account.email,
      subject: 'קוד איפוס סיסמה',
      text: `קוד איפוס הסיסמה שלכם: ${code}\nהקוד תקף ל-15 דקות.`,
    });
  }
  res.json({ success: true });
});

router.post('/verify-reset-code', async (req, res) => {
  const result = await verifyResetCode(req.body?.email, req.body?.code);
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
    const guestSheetId = sheetIdFromInput(req.query.guestSheetId || req.account.guestSheetId);
    const sheetTab = String(req.query.sheetTab || req.account.sheetTab || 'חתונה').trim() || 'חתונה';
    const headers = await readHeaderRow(guestSheetId, sheetTab);
    res.json({ success: true, headers });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'לא הצלחנו לקרוא את שורת הכותרות. ודאו שהגיליון שותף עם חשבון השירות.',
    });
  }
});

router.post('/columns', requireAccount, async (req, res) => {
  const columnMap = req.body?.columnMap || {};
  const account = await updateAccount(req.account.id, { columnMap });
  res.json({ success: true, account: publicAccount(account) });
});

router.get('/settings', requireAccount, async (req, res) => {
  try {
    const paymentUrls = await getPaymentSeedUrls();
    res.json({
      success: true,
      account: publicAccount(req.account),
      paymentUrls,
      serviceAccountEmail: getServiceAccountEmail() || '',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'טעינת ההגדרות נכשלה' });
  }
});

router.put('/settings', requireAccount, async (req, res) => {
  try {
    const body = req.body || {};
    const brideName = String(body.brideName || '').trim();
    const groomName = String(body.groomName || '').trim();
    const weddingDate = String(body.weddingDate || '').trim();
    const guestSheetId = sheetIdFromInput(body.guestSheetId);
    const sheetTab = String(body.sheetTab || '').trim();
    if (!brideName || !groomName || !weddingDate || !guestSheetId || !sheetTab) {
      return res.status(400).json({
        success: false,
        error: 'יש למלא שמות, תאריך, גיליון אורחים ושם לשונית',
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weddingDate)) {
      return res.status(400).json({ success: false, error: 'יש לבחור תאריך חתונה' });
    }

    const patch = {
      brideName,
      groomName,
      weddingDate,
      wazeUrl: String(body.wazeUrl || '').trim(),
      mapsUrl: String(body.mapsUrl || '').trim(),
      guestSheetId,
      sheetTab,
      babyMaxAge: normalizeBabyMaxAge(body.babyMaxAge),
      columnMap: body.columnMap && typeof body.columnMap === 'object' ? body.columnMap : req.account.columnMap,
    };

    if (body.inviteImageDataUrl) {
      patch.inviteImageFile = saveInviteImage(req.account.id, body.inviteImageDataUrl);
    }

    const account = await updateAccount(req.account.id, patch);

    const paymentUrls = await updatePaymentSeedUrls({
      daniellePaybox: body.daniellePaybox,
      yuvalPaybox: body.yuvalPaybox,
      danielleBit: body.danielleBit,
      yuvalBit: body.yuvalBit,
    });

    res.json({
      success: true,
      account: publicAccount(account),
      paymentUrls,
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'שמירת ההגדרות נכשלה' });
  }
});

export default router;
