import express from 'express';
import { getServiceAccountEmail, readHeaderRow, verifySheetOwnership } from '../services/googleSheets.js';
import { sendMail } from '../services/mailer.js';
import { getPaymentSeedUrls, seedPaymentFile, updatePaymentSeedUrls } from '../services/paymentRouting.js';
import {
  createAccount,
  deleteAccount,
  ensureSheetVerifyCode,
  findAccountByEmail,
  findAccountByGuestSheetId,
  issueResetCode,
  issueUnlockCode,
  normalizeBabyMaxAge,
  normalizeLandingPrefs,
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
  destroySessionsForAccount,
  readCookie,
  refreshSessionCookieIfNeeded,
  requireAccount,
  setSessionCookie,
} from '../services/sessions.js';
import {
  clearCodeFailures,
  createSheetChallenge,
  rateLimit,
  recordCodeFailure,
  tooManyCodeAttempts,
  validateMapsUrl,
  validateWazeUrl,
  verifySheetChallengeToken,
} from '../middleware/security.js';

const router = express.Router();
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, name: 'auth' });

function sheetIdFromInput(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : text;
}

router.get('/setup', (_req, res) => {
  const challenge = createSheetChallenge();
  res.json({
    success: true,
    serviceAccountEmail: getServiceAccountEmail() || '',
    sheetVerifyCode: challenge.code,
    sheetVerifyToken: challenge.token,
  });
});

router.get('/me', async (req, res) => {
  const account = await accountFromRequest(req);
  if (!account) {
    return res.status(401).json({ success: false, error: 'יש להתחבר מחדש', reauth: true });
  }
  refreshSessionCookieIfNeeded(req, res);
  return res.json({ success: true, account: publicAccount(account) });
});

router.post('/register', authLimit, async (req, res) => {
  let createdId = '';
  try {
    const body = req.body || {};
    const guestSheetId = sheetIdFromInput(body.guestSheetId);
    const responseSheetId = sheetIdFromInput(body.responseSheetId);
    const sheetTab = String(body.sheetTab || '').trim() || 'חתונה';

    if (!guestSheetId || !sheetTab) {
      return res.status(400).json({ success: false, error: 'יש למלא את כל פרטי החתונה והגיליון' });
    }

    const existingOwner = await findAccountByGuestSheetId(guestSheetId);
    if (existingOwner) {
      return res.status(409).json({
        success: false,
        error: 'גיליון זה כבר משויך לחשבון אחר.',
      });
    }

    const challengeCode = verifySheetChallengeToken(body.sheetVerifyToken);
    if (!challengeCode) {
      return res.status(400).json({
        success: false,
        error: 'קוד אימות הגיליון חסר או פג תוקף. רעננו את העמוד ונסו שוב.',
      });
    }

    // Fail before creating a row if the sheet is not readable or ownership is not proven.
    try {
      const ownsSheet = await verifySheetOwnership(guestSheetId, sheetTab, challengeCode);
      if (!ownsSheet) {
        return res.status(400).json({
          success: false,
          error: `כדי לאמת בעלות על הגיליון, הוסיפו את הקוד ${challengeCode} לכותרת הגיליון או לאחד התאים בשורה 1 ונסו שוב.`,
        });
      }
      await readHeaderRow(guestSheetId, sheetTab);
    } catch (sheetError) {
      return res.status(400).json({
        success: false,
        error: sheetError.message
          || 'לא הצלחנו לקרוא את הגיליון. ודאו ששיתפתם אותו עם חשבון השירות והקישור נכון.',
      });
    }

    let account;
    try {
      account = await createAccount({
        ...body,
        guestSheetId,
        responseSheetId,
        sheetTab,
      });
      createdId = account.id;
    } catch (error) {
      if (error?.status === 409) {
        return res.status(409).json({
          success: false,
          error: 'כבר קיים חשבון עם האימייל הזה. התחברו דרך מסך ההתחברות.',
        });
      }
      if (error?.code === '23505') {
        return res.status(409).json({
          success: false,
          error: 'גיליון זה או האימייל כבר משויכים לחשבון קיים.',
        });
      }
      throw error;
    }

    try {
      await seedPaymentFile(account.id, account.paymentSeed || {});
    } catch (seedError) {
      await deleteAccount(account.id).catch(() => {});
      createdId = '';
      throw Object.assign(
        new Error(seedError.message || 'שמירת קישורי התשלום נכשלה'),
        { status: seedError.status || 500 },
      );
    }

    setSessionCookie(res, await createSession(account, req));
    res.json({ success: true, account: publicAccount(account) });
  } catch (error) {
    if (createdId) {
      await deleteAccount(createdId).catch(() => {});
    }
    res.status(error.status || 500).json({ success: false, error: error.message || 'יצירת החשבון נכשלה' });
  }
});

router.post('/login', authLimit, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const account = await findAccountByEmail(email);
    if (!account) {
      return res.status(401).json({ success: false, error: 'אימייל או סיסמה שגויים' });
    }
    if (account.locked) {
      const code = await issueUnlockCode(account);
      if (code) {
        await sendMail({
          to: account.email,
          subject: 'פתיחת חשבון ההזמנות',
          text: `החשבון נעול אחרי ניסיונות התחברות כושלים.\nקוד הפתיחה: ${code}\nהקוד תקף ל-15 דקות.`,
        });
      }
      return res.status(423).json({
        success: false,
        locked: true,
        error: 'החשבון נעול. אם אין קוד בתוקף, נשלח קוד לאימייל.',
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
    setSessionCookie(res, await createSession(fresh, req));
    return res.json({ success: true, account: publicAccount(fresh) });
  } catch (error) {
    console.error('[auth/login]', error);
    return res.status(500).json({ success: false, error: 'ההתחברות נכשלה' });
  }
});

router.post('/logout', async (req, res) => {
  await destroySessionToken(readCookie(req, 'sid'));
  clearSessionCookie(res);
  res.json({ success: true });
});

router.post('/unlock', authLimit, async (req, res) => {
  const email = req.body?.email;
  if (tooManyCodeAttempts('unlock', email)) {
    return res.status(429).json({ success: false, error: 'יותר מדי ניסיונות. בקשו קוד חדש מאוחר יותר.' });
  }
  const result = await unlockWithCode(email, req.body?.code);
  if (!result.ok) {
    if (recordCodeFailure('unlock', email)) {
      return res.status(429).json({ success: false, error: 'יותר מדי ניסיונות. בקשו קוד חדש מאוחר יותר.' });
    }
    return res.status(400).json({ success: false, error: result.error });
  }
  clearCodeFailures('unlock', email);
  return res.json({ success: true });
});

router.post('/forgot', authLimit, async (req, res) => {
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

router.post('/verify-reset-code', authLimit, async (req, res) => {
  const email = req.body?.email;
  if (tooManyCodeAttempts('reset', email)) {
    return res.status(429).json({ success: false, error: 'יותר מדי ניסיונות. בקשו קוד חדש.' });
  }
  const result = await verifyResetCode(email, req.body?.code);
  if (!result.ok) {
    if (recordCodeFailure('reset', email)) {
      return res.status(429).json({ success: false, error: 'יותר מדי ניסיונות. בקשו קוד חדש.' });
    }
    return res.status(400).json({ success: false, error: result.error });
  }
  return res.json({ success: true });
});

router.post('/reset', authLimit, async (req, res) => {
  try {
    const email = req.body?.email;
    if (tooManyCodeAttempts('reset', email)) {
      return res.status(429).json({ success: false, error: 'יותר מדי ניסיונות. בקשו קוד חדש.' });
    }
    await resetPassword(email, req.body?.code, req.body?.password);
    clearCodeFailures('reset', email);
    const account = await findAccountByEmail(String(email || '').trim().toLowerCase());
    if (account) await destroySessionsForAccount(account.id);
    res.json({ success: true });
  } catch (error) {
    if (error.status === 400) recordCodeFailure('reset', req.body?.email);
    res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'איפוס הסיסמה נכשל' });
  }
});

router.get('/headers', requireAccount, async (req, res) => {
  try {
    const guestSheetId = sheetIdFromInput(req.query.guestSheetId || req.account.guestSheetId);
    const sheetTab = String(req.query.sheetTab || req.account.sheetTab || 'חתונה').trim() || 'חתונה';
    if (!guestSheetId) {
      return res.status(400).json({ success: false, error: 'יש להזין קישור לגיליון אורחים' });
    }
    const otherOwner = await findAccountByGuestSheetId(guestSheetId, req.account.id);
    if (otherOwner) {
      return res.status(403).json({
        success: false,
        error: 'גיליון זה משויך לחשבון אחר.',
      });
    }
    if (guestSheetId !== req.account.guestSheetId) {
      const verifyCode = await ensureSheetVerifyCode(req.account);
      const ownsSheet = await verifySheetOwnership(guestSheetId, sheetTab, verifyCode);
      if (!ownsSheet) {
        return res.status(403).json({
          success: false,
          error: `כדי לקרוא גיליון חדש, הוסיפו את קוד האימות ${verifyCode} לכותרת הגיליון או לתא בשורה 1 ונסו שוב.`,
        });
      }
    }
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
    await ensureSheetVerifyCode(req.account);
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

router.get('/landing-prefs', requireAccount, async (req, res) => {
  const account = publicAccount(req.account);
  res.json({
    success: true,
    publicToken: account.publicToken,
    brideName: account.brideName,
    groomName: account.groomName,
    weddingDate: account.weddingDate,
    wazeUrl: account.wazeUrl,
    mapsUrl: account.mapsUrl,
    landingPrefs: account.landingPrefs,
  });
});

router.put('/landing-prefs', requireAccount, async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {
      landingPrefs: normalizeLandingPrefs(body.landingPrefs || body),
    };
    if (body.brideName !== undefined) patch.brideName = String(body.brideName || '').trim();
    if (body.groomName !== undefined) patch.groomName = String(body.groomName || '').trim();
    if (body.weddingDate !== undefined) {
      const weddingDate = String(body.weddingDate || '').trim();
      if (weddingDate && !/^\d{4}-\d{2}-\d{2}$/.test(weddingDate)) {
        return res.status(400).json({ success: false, error: 'יש לבחור תאריך חתונה תקין' });
      }
      patch.weddingDate = weddingDate;
    }
    if (body.wazeUrl !== undefined) patch.wazeUrl = validateWazeUrl(body.wazeUrl);
    if (body.mapsUrl !== undefined) patch.mapsUrl = validateMapsUrl(body.mapsUrl);

    if (patch.brideName !== undefined && !patch.brideName) {
      return res.status(400).json({ success: false, error: 'יש להזין שם כלה' });
    }
    if (patch.groomName !== undefined && !patch.groomName) {
      return res.status(400).json({ success: false, error: 'יש להזין שם חתן' });
    }

    const account = await updateAccount(req.account.id, patch);
    res.json({
      success: true,
      account: publicAccount(account),
      landingPrefs: publicAccount(account).landingPrefs,
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'שמירת דף הנחיתה נכשלה' });
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

    const wazeUrl = validateWazeUrl(body.wazeUrl);
    const mapsUrl = validateMapsUrl(body.mapsUrl);

    if (guestSheetId !== req.account.guestSheetId) {
      const otherOwner = await findAccountByGuestSheetId(guestSheetId, req.account.id);
      if (otherOwner) {
        return res.status(409).json({
          success: false,
          error: 'גיליון זה כבר משויך לחשבון אחר.',
        });
      }
      const verifyCode = await ensureSheetVerifyCode(req.account);
      let ownsSheet = false;
      try {
        ownsSheet = await verifySheetOwnership(guestSheetId, sheetTab, verifyCode);
      } catch (sheetError) {
        return res.status(400).json({
          success: false,
          error: sheetError.message || 'לא הצלחנו לקרוא את הגיליון החדש. ודאו שהוא משותף עם חשבון השירות.',
        });
      }
      if (!ownsSheet) {
        return res.status(400).json({
          success: false,
          error: `כדי להחליף לגיליון חדש, הוסיפו את קוד האימות ${verifyCode} לכותרת הגיליון או לאחד התאים בשורה 1 ונסו שוב.`,
        });
      }
    }

    const patch = {
      brideName,
      groomName,
      weddingDate,
      wazeUrl,
      mapsUrl,
      guestSheetId,
      sheetTab,
      babyMaxAge: normalizeBabyMaxAge(body.babyMaxAge),
      columnMap: body.columnMap && typeof body.columnMap === 'object' ? body.columnMap : req.account.columnMap,
    };

    if (body.inviteImageDataUrl) {
      patch.inviteImageFile = await saveInviteImage(req.account.id, body.inviteImageDataUrl);
    }

    const paymentUrls = await updatePaymentSeedUrls({
      daniellePaybox: body.daniellePaybox,
      yuvalPaybox: body.yuvalPaybox,
      danielleBit: body.danielleBit,
      yuvalBit: body.yuvalBit,
    });

    const account = await updateAccount(req.account.id, patch);

    res.json({
      success: true,
      account: publicAccount(account),
      paymentUrls,
    });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ success: false, error: 'גיליון זה כבר משויך לחשבון אחר.' });
    }
    res.status(error.status || 500).json({ success: false, error: error.message || 'שמירת ההגדרות נכשלה' });
  }
});

export default router;
