import express from 'express';
import { envGuestSheetId } from '../config/loadEnv.js';
import { updateGuestRsvpOnGuestSheet } from '../services/googleSheets.js';
import { findByPublicToken } from '../services/accounts.js';
import { runAsAccount, currentAccount } from '../services/accountContext.js';
import { upsertRsvpResponse } from '../services/rsvpResponses.js';

const router = express.Router();

async function accountForRequest(req) {
  const token = String(req.query.token || req.body?.inviteToken || '').trim();
  if (!token) return null;
  return await findByPublicToken(token);
}

router.use(async (req, res, next) => {
  try {
    const account = await accountForRequest(req);
    if (!account) return next();
    return runAsAccount(account, () => next());
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/rsvp
 * Handle RSVP submission
 * Body: { name, phone, isAttending, numberOfGuests, numberOfBabies?, numberOfVegan?, additionalNotes? }
 */
router.post('/', async (req, res) => {
  try {
    const {
      name,
      phone,
      isAttending,
      numberOfGuests,
      numberOfBabies,
      numberOfVegan,
      additionalNotes,
    } = req.body;

    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        error: 'Name and phone number are required',
      });
    }

    if (typeof isAttending !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'isAttending must be a boolean',
      });
    }

    // Not coming → guest count is always 0 in the guest sheet (column H)
    const guests = isAttending ? parseInt(numberOfGuests, 10) : 0;
    if (isNaN(guests) || guests < 0) {
      return res.status(400).json({
        success: false,
        error: 'Number of guests must be a non-negative integer',
      });
    }

    if (isAttending && guests < 1) {
      return res.status(400).json({
        success: false,
        error: 'Number of guests must be at least 1 when attending',
      });
    }

    const babies = isAttending ? parseInt(numberOfBabies, 10) || 0 : 0;
    if (isNaN(babies) || babies < 0) {
      return res.status(400).json({
        success: false,
        error: 'Number of babies must be a non-negative integer',
      });
    }

    const vegan = isAttending ? parseInt(numberOfVegan, 10) || 0 : 0;
    if (isNaN(vegan) || vegan < 0) {
      return res.status(400).json({
        success: false,
        error: 'Number of vegan/vegetarian guests must be a non-negative integer',
      });
    }

    const notes = isAttending && typeof additionalNotes === 'string'
      ? additionalNotes.trim().slice(0, 60)
      : '';

    if (!currentAccount()?.id) {
      return res.status(404).json({
        success: false,
        error: 'החתונה לא נמצאה',
      });
    }

    const guestSheetId = envGuestSheetId();
    if (!guestSheetId) {
      return res.status(500).json({
        success: false,
        error: 'Guest sheet not configured',
      });
    }

    await updateGuestRsvpOnGuestSheet(guestSheetId, phone, {
      isAttending,
      numberOfGuests: guests,
      numberOfBabies: babies,
      numberOfVegan: vegan,
      additionalNotes: notes,
    });

    await upsertRsvpResponse({
      name,
      phone,
      isAttending,
      numberOfGuests: guests,
      numberOfBabies: babies,
      numberOfVegan: vegan,
      additionalNotes: notes,
    });

    res.json({
      success: true,
      message: 'RSVP submitted successfully',
    });
  } catch (error) {
    console.error('Error processing RSVP:', error);

    if (error.status === 404) {
      return res.status(404).json({
        success: false,
        error: error.message || 'Guest not found in guest list',
      });
    }

    if (error.code === 'PERMISSION_DENIED' || error.message?.includes('Permission denied')) {
      const serviceAccountEmail = error.serviceAccountEmail || 'your-service-account@project.iam.gserviceaccount.com';
      return res.status(403).json({
        success: false,
        error: error.message || 'Permission denied. Please ensure the service account has access to the guest sheet.',
        details: serviceAccountEmail ? {
          serviceAccountEmail,
          instructions: `To fix this:\n1. Open your guest Google Sheet\n2. Click the "Share" button\n3. Add this email: ${serviceAccountEmail}\n4. Give it "Editor" permissions\n5. Click "Send"`,
        } : null,
      });
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process RSVP. Please try again later.',
    });
  }
});

/**
 * GET /api/rsvp/guest/:phone
 * Get guest information by phone number for auto-filling the form
 */
router.get('/guest/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const guestSheetId = envGuestSheetId();

    if (!guestSheetId) {
      return res.status(500).json({
        success: false,
        error: 'Guest sheet not configured',
      });
    }

    const { getGuestByPhone, parseStoredRsvp } = await import('../services/googleSheets.js');
    const guest = await getGuestByPhone(guestSheetId, phone);

    if (!guest) {
      return res.status(404).json({
        success: false,
        error: 'Guest not found',
      });
    }

    res.json({
      success: true,
      guest: {
        name: guest.fullName || guest.name,
        phone: guest.phoneTo,
        addons: guest.addons,
        rsvp: parseStoredRsvp(guest),
      },
    });
  } catch (error) {
    console.error('Error fetching guest:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch guest information',
    });
  }
});

export default router;
