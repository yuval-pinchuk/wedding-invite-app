import express from 'express';
import { getPaymentStatus, recordGiftAndGetLink } from '../services/paymentRouting.js';

const router = express.Router();

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

/**
 * GET /api/pay/status — public snapshot for the gift UI (no history).
 */
router.get('/status', (_req, res) => {
  try {
    const status = getPaymentStatus();
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
 * Records amount against the currently active link and returns its URL.
 */
router.post('/checkout', (req, res) => {
  try {
    const { amount, guestPhone, guestName } = req.body || {};
    const result = recordGiftAndGetLink(amount, { guestPhone, guestName });
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
