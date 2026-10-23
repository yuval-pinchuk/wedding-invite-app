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

router.get('/status', async (_req, res) => {
  try {
    res.json({
      success: true,
      ...(await getPaymentStatus()),
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

router.post('/mode', async (req, res) => {
  try {
    const { mode, manualLinkId } = req.body || {};
    if (mode !== 'auto' && mode !== 'manual') {
      return res.status(400).json({
        success: false,
        error: 'mode must be "auto" or "manual"',
      });
    }
    const status = await setRoutingMode(mode, manualLinkId || null);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/mode]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to update routing mode',
    });
  }
});

router.post('/links', async (req, res) => {
  try {
    const status = await addLink(req.body || {});
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links/add]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to add link',
    });
  }
});

router.post('/links/reorder', async (req, res) => {
  try {
    const status = await reorderLinks(req.body?.orderedIds || []);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links/reorder]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to reorder links',
    });
  }
});

router.post('/links/:linkId/move', async (req, res) => {
  try {
    const direction = req.body?.direction === 'up' ? 'up' : 'down';
    const status = await moveLink(req.params.linkId, direction);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links/move]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to move link',
    });
  }
});

router.post('/links/:linkId', async (req, res) => {
  try {
    const status = await updateLink(req.params.linkId, req.body || {});
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to update link',
    });
  }
});

router.delete('/links/:linkId', async (req, res) => {
  try {
    const status = await removeLink(req.params.linkId);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links/delete]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to remove link',
    });
  }
});

router.post('/links/:linkId/adjust', async (req, res) => {
  try {
    const { amount, note } = req.body || {};
    const status = await adjustLinkSum(req.params.linkId, amount, note);
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[admin/pay/links/adjust]', error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to adjust link sum',
    });
  }
});

export default router;
