import express from 'express';
import { getSenders, getGuestList, updateSendConfirmation } from '../services/googleSheets.js';
import {
  initializeWhatsApp,
  waitForReady,
  sendWhatsAppInvitation,
  getQRCode,
  getStatus,
  getClient,
  destroySession,
  baileysPairingToQrDataUrl,
} from '../services/whatsapp.js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

/** @type {Map<string, string>} raw pairing string → PNG data URL */
const qrPngByPairing = new Map();
const QR_PNG_CACHE_MAX = 12;

async function qrDataUrlForPairing(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const cached = qrPngByPairing.get(raw);
  if (cached) {
    return cached;
  }
  const dataUrl = await baileysPairingToQrDataUrl(raw);
  if (qrPngByPairing.size >= QR_PNG_CACHE_MAX) {
    const oldest = qrPngByPairing.keys().next().value;
    if (oldest !== undefined) {
      qrPngByPairing.delete(oldest);
    }
  }
  qrPngByPairing.set(raw, dataUrl);
  return dataUrl;
}

async function safeQrDataUrl(raw) {
  try {
    return await qrDataUrlForPairing(raw);
  } catch (e) {
    console.error('[admin] QR PNG encode failed', e);
    return null;
  }
}

router.get('/senders', async (req, res) => {
  try {
    const guestSheetId = process.env.GOOGLE_GUEST_SHEET_ID;
    if (!guestSheetId) {
      return res.status(500).json({
        success: false,
        error: 'Guest sheet not configured',
      });
    }

    const senders = await getSenders(guestSheetId);
    res.json({
      success: true,
      senders,
    });
  } catch (error) {
    console.error('Error getting senders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get senders',
    });
  }
});

router.get('/guests/:sender', async (req, res) => {
  try {
    const { sender } = req.params;
    const guestSheetId = process.env.GOOGLE_GUEST_SHEET_ID;

    if (!guestSheetId) {
      return res.status(500).json({
        success: false,
        error: 'Guest sheet not configured',
      });
    }

    const allGuests = await getGuestList(guestSheetId);
    const senderGuests = allGuests.filter((guest) => {
      const matchesSender = guest.sender && guest.sender.trim() === sender.trim();
      return matchesSender;
    });

    res.json({
      success: true,
      guests: senderGuests,
    });
  } catch (error) {
    console.error('Error getting guests:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get guests',
    });
  }
});

router.post('/update-send-status', async (req, res) => {
  try {
    const { phone, shouldSend } = req.body;
    const guestSheetId = process.env.GOOGLE_GUEST_SHEET_ID;

    if (!guestSheetId) {
      return res.status(500).json({
        success: false,
        error: 'Guest sheet not configured',
      });
    }

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required',
      });
    }

    await updateSendConfirmation(guestSheetId, phone, shouldSend);
    res.json({
      success: true,
      message: 'Send status updated',
    });
  } catch (error) {
    console.error('Error updating send status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update send status',
    });
  }
});

/**
 * POST /api/admin/init-whatsapp — start Baileys; poll until QR or open.
 */
router.post('/init-whatsapp', async (req, res) => {
  try {
    const { sender } = req.body;

    if (!sender) {
      return res.status(400).json({
        success: false,
        error: 'Sender is required',
      });
    }

    let qrCode = getQRCode(sender);
    const status = getStatus(sender);

    if (status.ready) {
      return res.json({
        success: true,
        qrCode: null,
        ready: true,
      });
    }

    if (qrCode) {
      const qrDataUrl = await safeQrDataUrl(qrCode);
      return res.json({
        success: true,
        qrCode,
        qrDataUrl,
        ready: false,
      });
    }

    let initError = null;
    const initPromise = initializeWhatsApp(sender).catch((err) => {
      console.error('[init-whatsapp]', err);
      initError = err;
    });

    let attempts = 0;
    while (!qrCode && !initError) {
      await new Promise((r) => setTimeout(r, 400));
      attempts += 1;
      if (getStatus(sender).ready) {
        return res.json({
          success: true,
          qrCode: null,
          ready: true,
        });
      }
      qrCode = getQRCode(sender);
      const cur = getStatus(sender);
      if (cur.ready) {
        return res.json({
          success: true,
          qrCode: null,
          ready: true,
        });
      }
      if (attempts % 25 === 0) {
        try {
          await Promise.race([
            initPromise,
            new Promise((r) => setTimeout(r, 50)),
          ]);
        } catch (e) {
          initError = e;
        }
      }
    }

    if (initError) {
      return res.status(500).json({
        success: false,
        error: initError.message || String(initError),
      });
    }

    if (getStatus(sender).ready) {
      return res.json({
        success: true,
        qrCode: null,
        ready: true,
      });
    }

    const qrDataUrl = qrCode ? await safeQrDataUrl(qrCode) : null;
    return res.json({
      success: true,
      qrCode,
      qrDataUrl,
      ready: false,
    });
  } catch (error) {
    console.error('[init-whatsapp]', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to initialize WhatsApp',
    });
  }
});

/**
 * GET /api/admin/whatsapp-status/:sender
 */
router.get('/whatsapp-status/:sender', async (req, res) => {
  try {
    const { sender } = req.params;
    let status = getStatus(sender);

    try {
      const client = getClient(sender);
      if (client?.user?.id) {
        status = { ready: true, qrCode: null };
      }
    } catch {
      /* ignore */
    }

    const raw = status.qrCode || null;
    const qrDataUrl = raw ? await safeQrDataUrl(raw) : null;
    res.json({
      success: true,
      ready: status.ready || false,
      qr: raw,
      qrDataUrl,
    });
  } catch (error) {
    console.error('[whatsapp-status]', error);
    res.json({
      success: true,
      ready: false,
      qr: null,
      qrDataUrl: null,
    });
  }
});

/**
 * DELETE /api/admin/clear-session/:sender — logout Baileys and delete auth folder.
 */
router.delete('/clear-session/:sender', async (req, res) => {
  try {
    const { sender } = req.params;
    await destroySession(sender);

    res.json({
      success: true,
      message: `Session cleared for ${sender}. Next connect will show a new QR code.`,
    });
  } catch (error) {
    console.error('Error clearing session:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear session',
    });
  }
});

/**
 * POST /api/admin/send-invitations — sequential sends (one Baileys client per sender).
 */
router.post('/send-invitations', async (req, res) => {
  try {
    const { sender, guests } = req.body;
    const rsvpBaseUrl = process.env.RSVP_BASE_URL || 'http://localhost:8080';

    if (!sender || !guests || !Array.isArray(guests)) {
      return res.status(400).json({
        success: false,
        error: 'Sender and guests array are required',
      });
    }

    console.log(`[send-invitations] sender=${sender} guests=${guests.length}`);

    await waitForReady(sender, null);

    const summary = {
      total: guests.length,
      successful: 0,
      failed: 0,
      details: [],
    };

    for (let i = 0; i < guests.length; i++) {
      const guest = guests[i];
      const rsvpLink = `${rsvpBaseUrl}?phone=${encodeURIComponent(guest.phone)}`;
      try {
        const result = await sendWhatsAppInvitation({
          to: guest.phone,
          senderName: sender,
          name: guest.name,
          addons: guest.addons,
          rsvpLink,
        });
        if (result.success) {
          summary.successful++;
        } else {
          summary.failed++;
        }
        summary.details.push({
          name: guest.name,
          phone: guest.phone,
          ...result,
        });
      } catch (error) {
        summary.failed++;
        summary.details.push({
          name: guest.name,
          phone: guest.phone,
          success: false,
          error: error.message,
        });
      }
    }

    console.log(`[send-invitations] done success=${summary.successful} failed=${summary.failed}`);

    res.json({
      success: true,
      ...summary,
    });
  } catch (error) {
    console.error('Error sending invitations:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send invitations',
    });
  }
});

export default router;
