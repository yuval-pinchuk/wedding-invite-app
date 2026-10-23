import express from 'express';
import { envGuestSheetId } from '../config/loadEnv.js';
import { addGuestGiftAmount } from '../services/googleSheets.js';
import { getPaymentStatus, recordGiftAndGetLink } from '../services/paymentRouting.js';
import { findByPublicToken } from '../services/accounts.js';
import { runAsAccount } from '../services/accountContext.js';
import { rateLimit } from '../middleware/security.js';

const router = express.Router();
const checkoutLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, name: 'pay' });

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

router.use(async (req, res, next) => {
  try {
    const token = String(req.query.token || req.body?.inviteToken || '').trim();
    const account = token ? await findByPublicToken(token) : null;
    if (!account) {
      return res.status(404).json({ success: false, error: 'החתונה לא נמצאה' });
    }
    return runAsAccount(account, () => next());
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/pay/status — public snapshot for the gift UI (no history).
 */
router.get('/status', async (_req, res) => {
  try {
    const status = await getPaymentStatus();
    res.json({
      success: true,
      activeLinkId: status.activeLinkId,
      mode: status.mode,
      provider: status.links.find((l) => l.isActive)?.provider || null,
      label: status.links.find((l) => l.isActive)?.label || null,
    });
  } catch (error) {
    console.error('[pay/status]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to load payment status',
    });
  }
});

/**
 * POST /api/pay/checkout
 * Body: { amount, guestPhone?, guestName? }
 */
router.post('/checkout', checkoutLimit, async (req, res) => {
  try {
    const { amount, guestPhone, guestName } = req.body || {};
    const result = await recordGiftAndGetLink(amount, { guestPhone, guestName });
    const phone = String(guestPhone || '').trim();
    const spreadsheetId = envGuestSheetId();
    if (!phone) {
      console.warn('[pay/checkout] no guest phone; skipped gift sheet update');
    } else if (!spreadsheetId) {
      console.warn('[pay/checkout] guest sheet not configured; skipped gift sheet update');
    } else {
      try {
        await addGuestGiftAmount(spreadsheetId, phone, result.amount, result.label);
      } catch (sheetError) {
        console.error('[pay/checkout] gift sheet update failed:', sheetError.message || sheetError);
      }
    }
    res.json({
      success: true,
      url: result.url,
      linkId: result.linkId,
      label: result.label,
      provider: result.provider,
      amount: result.amount,
    });
  } catch (error) {
    console.error('[pay/checkout]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to start payment',
    });
  }
});

export default router;
