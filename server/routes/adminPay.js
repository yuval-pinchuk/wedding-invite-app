import express from 'express';
import {
  adjustLinkSum,
  getPaymentStatus,
  setRoutingMode,
  updateLink,
} from '../services/paymentRouting.js';

const router = express.Router();

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

function requireAdminKey(req, res, next) {
  const expected = (process.env.ADMIN_API_KEY || '').trim();
  if (!expected) {
    return next();
  }
  const provided = String(req.get('x-admin-key') || req.query.key || '').trim();
  if (provided !== expected) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized. Provide a valid x-admin-key header.',
    });
  }
  return next();
}

router.use(requireAdminKey);

/**
 * GET /api/admin/pay/status
 */
router.get('/status', (_req, res) => {
  try {
    res.json({
      success: true,
      ...getPaymentStatus(),
      authRequired: Boolean((process.env.ADMIN_API_KEY || '').trim()),
    });
  } catch (error) {
    console.error('[admin/pay/status]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to load payment status',
    });
  }
});

/**
 * POST /api/admin/pay/mode
 * Body: { mode: 'auto' | 'manual', manualLinkId? }
 */
router.post('/mode', (req, res) => {
  try {
    const { mode, manualLinkId } = req.body || {};
    if (mode !== 'auto' && mode !== 'manual') {
      return res.status(400).json({
        success: false,
        error: 'mode must be "auto" or "manual"',
      });
    }
    const status = setRoutingMode(mode, manualLinkId || null);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/mode]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to update routing mode',
    });
  }
});

/**
 * POST /api/admin/pay/links/:linkId
 * Body: { threshold?, currentSum?, url?, label? }
 */
router.post('/links/:linkId', (req, res) => {
  try {
    const status = updateLink(req.params.linkId, req.body || {});
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to update link',
    });
  }
});

/**
 * POST /api/admin/pay/links/:linkId/adjust
 * Body: { amount, note? } — amount can be negative
 */
router.post('/links/:linkId/adjust', (req, res) => {
  try {
    const { amount, note } = req.body || {};
    const status = adjustLinkSum(req.params.linkId, amount, note);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/adjust]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to adjust link sum',
    });
  }
});

export default router;
