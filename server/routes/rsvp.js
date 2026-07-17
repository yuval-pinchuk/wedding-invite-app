import express from 'express';
import { envGuestSheetId, envResponseSheetId } from '../config/loadEnv.js';
import { saveRSVPResponse, initializeResponseSheet } from '../services/googleSheets.js';

const router = express.Router();

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

    // Validation
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

    let notes = isAttending && typeof additionalNotes === 'string'
      ? additionalNotes.trim().slice(0, 60)
      : '';

    const responseSheetId = envResponseSheetId();
    if (!responseSheetId) {
      return res.status(500).json({
        success: false,
        error: 'Response sheet not configured',
      });
    }

    // Initialize sheet headers if needed
    await initializeResponseSheet(responseSheetId);

    // Save RSVP response
    await saveRSVPResponse(
      responseSheetId,
      name,
      phone,
      isAttending,
      guests,
      babies,
      vegan,
      notes
    );

    res.json({
      success: true,
      message: 'RSVP submitted successfully',
    });
  } catch (error) {
    console.error('Error processing RSVP:', error);
    
    // Handle permission errors specifically
    if (error.code === 'PERMISSION_DENIED' || error.message?.includes('Permission denied')) {
      const serviceAccountEmail = error.serviceAccountEmail || 'your-service-account@project.iam.gserviceaccount.com';
      return res.status(403).json({
        success: false,
        error: error.message || 'Permission denied. Please ensure the service account has access to the response sheet.',
        details: serviceAccountEmail ? {
          serviceAccountEmail,
          instructions: `To fix this:\n1. Open your Google Sheet (ID: ${envResponseSheetId()})\n2. Click the "Share" button\n3. Add this email: ${serviceAccountEmail}\n4. Give it "Editor" permissions\n5. Click "Send"`
        } : null
      });
    }
    
    // Handle other errors
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

    const { getGuestByPhone } = await import('../services/googleSheets.js');
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
        name: guest.fullName || guest.name, // Use full name (first + last)
        phone: guest.phoneTo,
        addons: guest.addons,
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

