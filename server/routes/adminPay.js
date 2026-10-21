import express from 'express';
import {
  addLink,
  adjustLinkSum,
  getPaymentStatus,
  moveLink,
  removeLink,
  reorderLinks,
  setRoutingMode,
  updateLink,
} from '../services/paymentRouting.js';
import { requireAccount } from '../services/sessions.js';

const router = express.Router();

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

router.use(requireAccount);

/**
 * GET /api/admin/pay/status
 */
router.get('/status', (_req, res) => {
  try {
    res.json({
      success: true,
      ...getPaymentStatus(),
      authRequired: true,
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
 * POST /api/admin/pay/links
 * Body: { label, url, provider?, owner?, threshold? }
 */
router.post('/links', (req, res) => {
  try {
    const status = addLink(req.body || {});
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links/add]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to add link',
    });
  }
});

/**
 * POST /api/admin/pay/links/reorder
 * Body: { orderedIds: string[] }
 */
router.post('/links/reorder', (req, res) => {
  try {
    const status = reorderLinks(req.body?.orderedIds || []);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links/reorder]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to reorder links',
    });
  }
});

/**
 * POST /api/admin/pay/links/:linkId/move
 * Body: { direction: 'up' | 'down' }
 */
router.post('/links/:linkId/move', (req, res) => {
  try {
    const direction = req.body?.direction === 'up' ? 'up' : 'down';
    const status = moveLink(req.params.linkId, direction);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links/move]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to move link',
    });
  }
});

/**
 * POST /api/admin/pay/links/:linkId
 * Body: { threshold?, currentSum?, url?, label?, provider?, owner? }
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
 * DELETE /api/admin/pay/links/:linkId
 */
router.delete('/links/:linkId', (req, res) => {
  try {
    const status = removeLink(req.params.linkId);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links/delete]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to remove link',
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
