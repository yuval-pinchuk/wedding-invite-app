import express from 'express';
import { randomUUID } from 'crypto';
import { envGuestSheetId } from '../config/loadEnv.js';
import { getSenders, getGuestList, updateSendConfirmation, hasRsvpResponded, hasWhatsappSent, updateWhatsappSentAt, clearWhatsappSentMarks } from '../services/googleSheets.js';
import {
  initializeWhatsApp,
  waitForReady,
  SEND_READY_TIMEOUT_MS,
  sendWhatsAppInvitation,
  sendWhatsAppText,
  renderReminderTemplate,
  defaultReminderTemplate,
  getRsvpBaseUrl,
  getQRCode,
  getStatus,
  getClient,
  destroySession,
  baileysPairingToQrDataUrl,
  getSendPacingConfig,
  sleepBatchPause,
  estimateSendRemainingMs,
} from '../services/whatsapp.js';
import { requireAccount } from '../services/sessions.js';
import { getPaymentStatus } from '../services/paymentRouting.js';
import { publicAccount } from '../services/accounts.js';
const router = express.Router();

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

router.use(requireAccount);

/** @type {Map<string, object>} job id → in-memory reminder send */
const sendJobs = new Map();
/** @type {Map<string, string>} sender → running job id */
const runningJobBySender = new Map();

function publicSendJob(job) {
  return {
    id: job.id,
    sender: job.sender,
    status: job.status,
    total: job.total,
    completed: job.completed,
    successful: job.successful,
    failed: job.failed,
    skipped: job.skipped,
    lastPhone: job.lastPhone,
    lastName: job.lastName,
    lastSuccess: job.lastSuccess,
    currentName: job.currentName,
    currentPhone: job.currentPhone,
    whatsappSentAt: job.whatsappSentAt,
    remainingMsEstimate: job.remainingMsEstimate,
    error: job.error,
  };
}

function pruneSendJobs() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, job] of sendJobs) {
    if (job.finishedAt && job.finishedAt < cutoff) sendJobs.delete(id);
  }
}

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

/**
 * GET /api/admin/dashboard — aggregate guest + payment stats for the home page.
 */
router.get('/dashboard', async (req, res) => {
  try {
    const guestSheetId = envGuestSheetId();
    let guests = [];
    if (guestSheetId) {
      try {
        guests = await getGuestList(guestSheetId);
      } catch (error) {
        console.error('[admin/dashboard] guests', error);
      }
    }

    let attending = 0;
    let notAttending = 0;
    let pendingRsvp = 0;
    let waSent = 0;
    let waUnsent = 0;
    let withPhone = 0;

    for (const guest of guests) {
      const hasPhone = Boolean(String(guest.phoneTo || '').trim());
      if (hasPhone) withPhone += 1;

      const raw = String(guest.rsvpGuestCount || '').trim();
      if (!raw) pendingRsvp += 1;
      else if (raw === '0') notAttending += 1;
      else attending += 1;

      if (hasPhone) {
        if (hasWhatsappSent(guest)) waSent += 1;
        else waUnsent += 1;
      }
    }

    let payment = {
      totalReceived: 0,
      totalCapacity: 0,
      activeLinkLabel: '',
      mode: 'auto',
    };
    try {
      const status = getPaymentStatus();
      const active = (status.links || []).find((l) => l.isActive);
      payment = {
        totalReceived: status.totalReceived || 0,
        totalCapacity: status.totalCapacity || 0,
        activeLinkLabel: active?.label || '',
        mode: status.mode || 'auto',
      };
    } catch (error) {
      console.error('[admin/dashboard] payment', error);
    }

    res.json({
      success: true,
      account: publicAccount(req.account),
      guests: {
        total: guests.length,
        withPhone,
        attending,
        notAttending,
        pendingRsvp,
        waSent,
        waUnsent,
      },
      payment,
    });
  } catch (error) {
    console.error('[admin/dashboard]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to load dashboard',
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
 * POST /api/admin/clear-whatsapp-sent
 * Body: { phones: string[] } — clears V from column N for those guests.
 */
router.post('/clear-whatsapp-sent', async (req, res) => {
  try {
    const guestSheetId = envGuestSheetId();
    if (!guestSheetId) {
      return res.status(500).json({
        success: false,
        error: 'Guest sheet not configured',
      });
    }

    const phones = Array.isArray(req.body?.phones) ? req.body.phones : [];
    if (!phones.length) {
      return res.status(400).json({
        success: false,
        error: 'phones array is required',
      });
    }

    const result = await clearWhatsappSentMarks(guestSheetId, phones);
    res.json({
      success: true,
      message: `Cleared sent mark for ${result.cleared} guest(s)`,
      ...result,
    });
  } catch (error) {
    console.error('Error clearing WhatsApp sent marks:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear sent marks',
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
 * Write one NDJSON line; ignore client/proxy disconnects so the send loop can continue.
 * @param {import('express').Response} res
 * @param {object} payload
 */
function writeNdjsonLine(res, payload) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    return res.write(`${JSON.stringify(payload)}\n`);
  } catch {
    return false;
  }
}

function guestPhone(guest) {
  return String(guest?.phoneTo || guest?.phone || '').trim();
}

/**
 * Persist a successful WhatsApp send to column N as "V". Sheet errors must not fail the send.
 * @param {string | undefined} spreadsheetId
 * @param {string} phone
 * @returns {Promise<string | ''>}
 */
async function persistWhatsappSent(spreadsheetId, phone) {
  if (!spreadsheetId || !phone) return '';
  try {
    const result = await updateWhatsappSentAt(spreadsheetId, phone);
    return result.stamp || 'V';
  } catch (error) {
    console.error(`[whatsapp-sent] failed to write column N for ${phone}:`, error.message || error);
    return '';
  }
}

/**
 * @param {string} sender
 * @param {Array<{ name?: string, phone: string, addons?: string }>} guests
 * @param {(completed: number, guest: { name?: string, phone: string }, summary: object) => void} [afterEach]
 * @param {{ spreadsheetId?: string }} [options]
 */
async function sendInvitationsSequential(sender, guests, afterEach, options = {}) {
  await waitForReady(sender, SEND_READY_TIMEOUT_MS);
  const spreadsheetId = options.spreadsheetId || envGuestSheetId();
  const { batchSize } = getSendPacingConfig();
  const summary = {
    total: guests.length,
    successful: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };
  let consecutiveFailures = 0;

  for (let i = 0; i < guests.length; i++) {
    const guest = guests[i];
    const phone = guestPhone(guest);
    let result;
    try {
      result = await sendWhatsAppInvitation({
        to: guest.phone || guest.phoneTo,
        senderName: sender,
        name: guest.name,
        addons: guest.addons,
      });
    } catch (error) {
      result = { success: false, error: error.message, to: phone };
    }

    let whatsappSentAt = '';
    if (result.success) {
      summary.successful++;
      consecutiveFailures = 0;
      whatsappSentAt = await persistWhatsappSent(spreadsheetId, phone);
      console.log(`[send-invitations] OK ${guest.name || ''} ${phone}`);
      if (summary.successful % batchSize === 0 && i < guests.length - 1) {
        await sleepBatchPause();
      }
    } else if (result.skipped) {
      summary.skipped++;
      consecutiveFailures = 0;
      console.log(`[send-invitations] SKIP ${guest.name || ''} ${phone}: ${result.error || 'skipped'}`);
    } else {
      summary.failed++;
      consecutiveFailures += 1;
      console.log(`[send-invitations] ERR ${guest.name || ''} ${phone}: ${result.error || 'failed'}`);
      if (consecutiveFailures >= 5) {
        const stopped = new Error('Stopped after 5 consecutive send failures. Check the WhatsApp session.');
        summary.details.push({
          name: guest.name,
          phone,
          ...result,
          whatsappSentAt,
        });
        afterEach?.(i + 1, guest, summary);
        throw stopped;
      }
    }
    summary.details.push({
      name: guest.name,
      phone,
      ...result,
      whatsappSentAt,
    });
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

    const spreadsheetId = envGuestSheetId();
    const wantsNdjson = (req.get('accept') || '').includes('application/x-ndjson');

    if (wantsNdjson) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      try {
        const summary = await sendInvitationsSequential(
          sender,
          guests,
          (completed, guest, s) => {
            const lastDetail = s.details[s.details.length - 1] || {};
            writeNdjsonLine(res, {
              type: 'progress',
              completed,
              total: s.total,
              successful: s.successful,
              failed: s.failed,
              lastPhone: guestPhone(guest),
              lastName: guest.name || '',
              lastSuccess: Boolean(lastDetail.success),
              whatsappSentAt: lastDetail.whatsappSentAt || '',
            });
          },
          { spreadsheetId },
        );
        console.log(`[send-invitations] done success=${summary.successful} failed=${summary.failed}`);
        writeNdjsonLine(res, { type: 'done', success: true, ...summary });
      } catch (error) {
        console.error('Error sending invitations (stream):', error);
        writeNdjsonLine(res, {
          type: 'error',
          success: false,
          error: error.message || 'Failed to send invitations',
        });
      }
      try {
        res.end();
      } catch {
        /* client already gone */
      }
      return;
    }

    const summary = await sendInvitationsSequential(sender, guests, undefined, { spreadsheetId });
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
 * @param {{ spreadsheetId?: string, includeImage?: boolean }} [options]
 */
async function sendRsvpRemindersSequential(sender, guests, messageTemplate, afterEach, options = {}) {
  await waitForReady(sender, SEND_READY_TIMEOUT_MS);
  const spreadsheetId = options.spreadsheetId || envGuestSheetId();
  const { batchSize } = getSendPacingConfig();
  const summary = {
    total: guests.length,
    successful: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };
  let consecutiveFailures = 0;

  for (let i = 0; i < guests.length; i++) {
    const guest = guests[i];
    const phone = guestPhone(guest);
    if (!phone) {
      summary.skipped++;
      summary.details.push({
        name: guest.name,
        phone: guest.phoneTo,
        success: false,
        skipped: true,
        error: 'No phone number',
      });
      console.log(`[send-rsvp-reminders] SKIP ${guest.name || ''} (no phone)`);
      afterEach?.(i + 1, guest, summary);
      continue;
    }

    const text = renderReminderTemplate(messageTemplate, {
      name: guest.name,
      fullName: guest.fullName || guest.name,
      phone,
      addons: guest.addons,
    });
    options.beforeEach?.(i, guest);

    let result;
    try {
      result = await sendWhatsAppText({
        to: phone,
        senderName: sender,
        text,
        includeImage: options.includeImage !== false,
      });
    } catch (error) {
      result = { success: false, error: error.message, to: phone };
    }

    let whatsappSentAt = '';
    if (result.success) {
      summary.successful++;
      consecutiveFailures = 0;
      whatsappSentAt = await persistWhatsappSent(spreadsheetId, phone);
      console.log(`[send-rsvp-reminders] OK ${guest.name || ''} ${phone}`);
      if (summary.successful % batchSize === 0 && i < guests.length - 1) {
        await sleepBatchPause();
      }
    } else if (result.skipped) {
      summary.skipped++;
      consecutiveFailures = 0;
      console.log(`[send-rsvp-reminders] SKIP ${guest.name || ''} ${phone}: ${result.error || 'skipped'}`);
    } else {
      summary.failed++;
      consecutiveFailures += 1;
      console.log(`[send-rsvp-reminders] ERR ${guest.name || ''} ${phone}: ${result.error || 'failed'}`);
      if (consecutiveFailures >= 5) {
        summary.details.push({
          name: guest.name,
          phone,
          ...result,
          whatsappSentAt,
        });
        afterEach?.(i + 1, guest, summary);
        throw new Error('Stopped after 5 consecutive send failures. Check the WhatsApp session.');
      }
    }
    summary.details.push({
      name: guest.name,
      phone,
      ...result,
      whatsappSentAt,
    });
    afterEach?.(i + 1, guest, summary);
  }

  return summary;
}

function runReminderJob(job, guests, messageTemplate, options) {
  void sendRsvpRemindersSequential(
    job.sender,
    guests,
    messageTemplate,
    (completed, guest, summary) => {
      const lastDetail = summary.details[summary.details.length - 1] || {};
      job.completed = completed;
      job.successful = summary.successful;
      job.failed = summary.failed;
      job.skipped = summary.skipped;
      job.lastPhone = guestPhone(guest);
      job.lastName = guest.name || guest.fullName || '';
      job.lastSuccess = Boolean(lastDetail.success);
      job.whatsappSentAt = lastDetail.whatsappSentAt || '';
      job.remainingMsEstimate = estimateSendRemainingMs(
        Math.max(0, summary.total - completed),
        summary.successful,
      );
    },
    {
      ...options,
      beforeEach(_index, guest) {
        job.currentName = guest.name || guest.fullName || '';
        job.currentPhone = guestPhone(guest);
      },
    },
  ).then((summary) => {
    job.status = 'done';
    job.completed = summary.total;
    job.successful = summary.successful;
    job.failed = summary.failed;
    job.skipped = summary.skipped;
    job.finishedAt = Date.now();
    console.log(
      `[send-rsvp-reminders] job ${job.id} done success=${summary.successful} failed=${summary.failed} skipped=${summary.skipped}`,
    );
  }).catch((error) => {
    job.status = 'error';
    job.error = error.message || 'Failed to send RSVP reminders';
    job.finishedAt = Date.now();
    console.error(`[send-rsvp-reminders] job ${job.id} failed:`, error);
  }).finally(() => {
    if (runningJobBySender.get(job.sender) === job.id) {
      runningJobBySender.delete(job.sender);
    }
  });
}

router.get('/send-jobs/:id', (req, res) => {
  const job = sendJobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'Send job not found. The server may have restarted.',
    });
  }
  return res.json({ success: true, job: publicSendJob(job) });
});

router.get('/rsvp-reminder-defaults', (_req, res) => {
  const pacing = getSendPacingConfig();
  res.json({
    success: true,
    template: defaultReminderTemplate(),
    placeholders: ['{{greeting}}', '{{name}}', '{{fullName}}', '{{link}}'],
    rsvpBaseUrl: getRsvpBaseUrl(),
    authRequired: true,
    pacing,
  });
});

/**
 * POST /api/admin/send-rsvp-reminders
 * Body: { sender, message, guests? }
 * If guests is provided, sends only to those phone numbers (must belong to sender).
 * Otherwise sends to all pending guests for the sender.
 */
router.post('/send-rsvp-reminders', async (req, res) => {
  try {
    const { sender, message, guests: requestedGuests, includeImage } = req.body || {};
    const withImage = includeImage !== false;
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
    const senderGuests = allGuests.filter(
      (guest) => guest.sender && guest.sender.trim() === sender.trim(),
    );

    let targetGuests;
    if (Array.isArray(requestedGuests) && requestedGuests.length) {
      const byPhone = new Map(
        senderGuests.map((guest) => [(guest.phoneTo || '').trim(), guest]),
      );
      targetGuests = [];
      for (const reqGuest of requestedGuests) {
        const phone = String(reqGuest.phoneTo || reqGuest.phone || '').trim();
        if (!phone) continue;
        const sheetGuest = byPhone.get(phone);
        if (sheetGuest) {
          targetGuests.push(sheetGuest);
        } else {
          targetGuests.push({
            name: reqGuest.name,
            fullName: reqGuest.fullName || reqGuest.name,
            phoneTo: phone,
            addons: reqGuest.addons || '',
          });
        }
      }
    } else {
      targetGuests = senderGuests.filter(
        (guest) => !hasRsvpResponded(guest) && guest.phoneTo && !hasWhatsappSent(guest),
      );
    }

    if (!targetGuests.length) {
      return res.json({
        success: true,
        total: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        details: [],
        message: 'No guests to remind',
      });
    }

    console.log(`[send-rsvp-reminders] sender=${sender} targets=${targetGuests.length} includeImage=${withImage}`);

    if (req.body?.background) {
      pruneSendJobs();
      const senderKey = sender.trim();
      const existingId = runningJobBySender.get(senderKey);
      const existing = existingId ? sendJobs.get(existingId) : null;
      if (existing && existing.status === 'running') {
        return res.status(202).json({
          success: true,
          alreadyRunning: true,
          job: publicSendJob(existing),
        });
      }

      const job = {
        id: randomUUID(),
        sender: senderKey,
        status: 'running',
        total: targetGuests.length,
        completed: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        lastPhone: '',
        lastName: '',
        lastSuccess: false,
        currentName: '',
        currentPhone: '',
        whatsappSentAt: '',
        remainingMsEstimate: estimateSendRemainingMs(targetGuests.length, 0),
        error: '',
        finishedAt: 0,
      };
      sendJobs.set(job.id, job);
      runningJobBySender.set(senderKey, job.id);
      runReminderJob(job, targetGuests, messageTemplate, {
        spreadsheetId: guestSheetId,
        includeImage: withImage,
      });
      return res.status(202).json({ success: true, job: publicSendJob(job) });
    }

    const wantsNdjson = (req.get('accept') || '').includes('application/x-ndjson');

    if (wantsNdjson) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      try {
        const summary = await sendRsvpRemindersSequential(
          sender,
          targetGuests,
          messageTemplate,
          (completed, guest, s) => {
            const lastDetail = s.details[s.details.length - 1] || {};
            writeNdjsonLine(res, {
              type: 'progress',
              completed,
              total: s.total,
              successful: s.successful,
              failed: s.failed,
              skipped: s.skipped,
              lastPhone: guestPhone(guest),
              lastName: guest.name || guest.fullName || '',
              lastSuccess: Boolean(lastDetail.success),
              whatsappSentAt: lastDetail.whatsappSentAt || '',
            });
          },
          { spreadsheetId: guestSheetId, includeImage: withImage },
        );
        console.log(
          `[send-rsvp-reminders] done success=${summary.successful} failed=${summary.failed} skipped=${summary.skipped}`,
        );
        writeNdjsonLine(res, { type: 'done', success: true, ...summary });
      } catch (error) {
        console.error('Error sending RSVP reminders (stream):', error);
        writeNdjsonLine(res, {
          type: 'error',
          success: false,
          error: error.message || 'Failed to send RSVP reminders',
        });
      }
      try {
        res.end();
      } catch {
        /* client already gone */
      }
      return;
    }

    const summary = await sendRsvpRemindersSequential(
      sender,
      targetGuests,
      messageTemplate,
      undefined,
      { spreadsheetId: guestSheetId, includeImage: withImage },
    );
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
