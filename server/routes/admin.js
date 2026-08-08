import express from 'express';
import { envGuestSheetId } from '../config/loadEnv.js';
import { getSenders, getGuestList, updateSendConfirmation, hasRsvpResponded } from '../services/googleSheets.js';
import {
  initializeWhatsApp,
  waitForReady,
  sendWhatsAppInvitation,
  sendWhatsAppText,
  renderReminderTemplate,
  DEFAULT_RSVP_REMINDER_TEMPLATE,
  getRsvpBaseUrl,
  getQRCode,
  getStatus,
  getClient,
  destroySession,
  baileysPairingToQrDataUrl,
} from '../services/whatsapp.js';
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
    const guestSheetId = envGuestSheetId();
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
    const guestSheetId = envGuestSheetId();

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
    const guestSheetId = envGuestSheetId();

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
    // #region agent log
    fetch('http://127.0.0.1:7256/ingest/61c79d4c-5ece-4783-9102-c3a6465a4cec',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4043e'},body:JSON.stringify({sessionId:'f4043e',location:'admin.js:init-whatsapp:start',message:'init start',data:{sender,ready:status.ready,hasQr:Boolean(qrCode)},timestamp:Date.now(),hypothesisId:'H1'})}).catch(()=>{});
    // #endregion

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

    const MAX_INIT_WAIT_MS = 8000;
    const waitStart = Date.now();
    let attempts = 0;
    while (!qrCode && !initError && Date.now() - waitStart < MAX_INIT_WAIT_MS) {
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

    // #region agent log
    fetch('http://127.0.0.1:7256/ingest/61c79d4c-5ece-4783-9102-c3a6465a4cec',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4043e'},body:JSON.stringify({sessionId:'f4043e',location:'admin.js:init-whatsapp:loop-exit',message:'wait loop ended',data:{sender,attempts,elapsedMs:Date.now()-waitStart,hasQr:Boolean(qrCode),ready:getStatus(sender).ready,initError:Boolean(initError),timedOut:Date.now()-waitStart>=MAX_INIT_WAIT_MS},timestamp:Date.now(),hypothesisId:'H1',runId:'post-fix'})}).catch(()=>{});
    // #endregion

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
 * @param {string} sender
 * @param {Array<{ name?: string, phone: string, addons?: string }>} guests
 * @param {(completed: number, guest: { name?: string, phone: string }, summary: { total: number, successful: number, failed: number, details: unknown[] }) => void} [afterEach]
 */
async function sendInvitationsSequential(sender, guests, afterEach) {
  await waitForReady(sender, null);
  const summary = {
    total: guests.length,
    successful: 0,
    failed: 0,
    details: [],
  };

  for (let i = 0; i < guests.length; i++) {
    const guest = guests[i];
    try {
      const result = await sendWhatsAppInvitation({
        to: guest.phone,
        senderName: sender,
        name: guest.name,
        addons: guest.addons,
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
    afterEach?.(i + 1, guest, summary);
  }

  return summary;
}

/**
 * POST /api/admin/send-invitations — sequential sends (one Baileys client per sender).
 * With `Accept: application/x-ndjson`, streams one JSON line per guest plus a final `done` or `error` line.
 */
router.post('/send-invitations', async (req, res) => {
  try {
    const { sender, guests } = req.body;

    if (!sender || !guests || !Array.isArray(guests)) {
      return res.status(400).json({
        success: false,
        error: 'Sender and guests array are required',
      });
    }

    console.log(`[send-invitations] sender=${sender} guests=${guests.length}`);

    const wantsNdjson = (req.get('accept') || '').includes('application/x-ndjson');

    if (wantsNdjson) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      try {
        const summary = await sendInvitationsSequential(sender, guests, (completed, guest, s) => {
          res.write(
            `${JSON.stringify({
              type: 'progress',
              completed,
              total: s.total,
              successful: s.successful,
              failed: s.failed,
              lastPhone: guest.phone,
            })}\n`,
          );
        });
        console.log(`[send-invitations] done success=${summary.successful} failed=${summary.failed}`);
        res.write(`${JSON.stringify({ type: 'done', success: true, ...summary })}\n`);
        res.end();
      } catch (error) {
        console.error('Error sending invitations (stream):', error);
        res.write(
          `${JSON.stringify({
            type: 'error',
            success: false,
            error: error.message || 'Failed to send invitations',
          })}\n`,
        );
        res.end();
      }
      return;
    }

    const summary = await sendInvitationsSequential(sender, guests);
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

/**
 * @param {string} sender
 * @param {Array<{ name?: string, fullName?: string, phoneTo: string }>} guests
 * @param {string} messageTemplate
 * @param {(completed: number, guest: object, summary: object) => void} [afterEach]
 */
async function sendRsvpRemindersSequential(sender, guests, messageTemplate, afterEach) {
  await waitForReady(sender, null);
  const summary = {
    total: guests.length,
    successful: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  for (let i = 0; i < guests.length; i++) {
    const guest = guests[i];
    if (!guest.phoneTo) {
      summary.skipped++;
      summary.details.push({
        name: guest.name,
        phone: guest.phoneTo,
        success: false,
        skipped: true,
        error: 'No phone number',
      });
      afterEach?.(i + 1, guest, summary);
      continue;
    }

    const text = renderReminderTemplate(messageTemplate, {
      name: guest.name,
      fullName: guest.fullName || guest.name,
      phone: guest.phoneTo,
    });

    try {
      const result = await sendWhatsAppText({
        to: guest.phoneTo,
        senderName: sender,
        text,
      });
      if (result.success) {
        summary.successful++;
      } else {
        summary.failed++;
      }
      summary.details.push({
        name: guest.name,
        phone: guest.phoneTo,
        ...result,
      });
    } catch (error) {
      summary.failed++;
      summary.details.push({
        name: guest.name,
        phone: guest.phoneTo,
        success: false,
        error: error.message,
      });
    }
    afterEach?.(i + 1, guest, summary);
  }

  return summary;
}

router.get('/rsvp-reminder-defaults', (_req, res) => {
  res.json({
    success: true,
    template: DEFAULT_RSVP_REMINDER_TEMPLATE,
    placeholders: ['{{name}}', '{{fullName}}', '{{link}}'],
    rsvpBaseUrl: getRsvpBaseUrl(),
    authRequired: Boolean((process.env.ADMIN_API_KEY || '').trim()),
  });
});

/**
 * POST /api/admin/send-rsvp-reminders
 * Body: { sender, message }
 */
router.post('/send-rsvp-reminders', async (req, res) => {
  try {
    const { sender, message } = req.body || {};
    const guestSheetId = envGuestSheetId();

    if (!guestSheetId) {
      return res.status(500).json({
        success: false,
        error: 'Guest sheet not configured',
      });
    }

    if (!sender) {
      return res.status(400).json({
        success: false,
        error: 'Sender is required',
      });
    }

    const messageTemplate = typeof message === 'string' ? message.trim() : '';
    if (!messageTemplate) {
      return res.status(400).json({
        success: false,
        error: 'Message is required',
      });
    }

    const allGuests = await getGuestList(guestSheetId);
    const pendingGuests = allGuests.filter((guest) => {
      const matchesSender = guest.sender && guest.sender.trim() === sender.trim();
      return matchesSender && !hasRsvpResponded(guest) && guest.phoneTo;
    });

    if (!pendingGuests.length) {
      return res.json({
        success: true,
        total: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        details: [],
        message: 'No pending guests to remind',
      });
    }

    console.log(`[send-rsvp-reminders] sender=${sender} pending=${pendingGuests.length}`);

    const wantsNdjson = (req.get('accept') || '').includes('application/x-ndjson');

    if (wantsNdjson) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      try {
        const summary = await sendRsvpRemindersSequential(
          sender,
          pendingGuests,
          messageTemplate,
          (completed, guest, s) => {
            res.write(
              `${JSON.stringify({
                type: 'progress',
                completed,
                total: s.total,
                successful: s.successful,
                failed: s.failed,
                skipped: s.skipped,
                lastPhone: guest.phoneTo,
              })}\n`,
            );
          },
        );
        console.log(
          `[send-rsvp-reminders] done success=${summary.successful} failed=${summary.failed} skipped=${summary.skipped}`,
        );
        res.write(`${JSON.stringify({ type: 'done', success: true, ...summary })}\n`);
        res.end();
      } catch (error) {
        console.error('Error sending RSVP reminders (stream):', error);
        res.write(
          `${JSON.stringify({
            type: 'error',
            success: false,
            error: error.message || 'Failed to send RSVP reminders',
          })}\n`,
        );
        res.end();
      }
      return;
    }

    const summary = await sendRsvpRemindersSequential(sender, pendingGuests, messageTemplate);
    console.log(
      `[send-rsvp-reminders] done success=${summary.successful} failed=${summary.failed} skipped=${summary.skipped}`,
    );

    res.json({
      success: true,
      ...summary,
    });
  } catch (error) {
    console.error('Error sending RSVP reminders:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send RSVP reminders',
    });
  }
});

export default router;
