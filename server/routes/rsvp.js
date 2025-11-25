import express from 'express';
import { saveRSVPResponse, initializeResponseSheet } from '../services/googleSheets.js';

const router = express.Router();

/**
 * POST /api/rsvp
 * Handle RSVP submission
 * Body: { name, phone, isAttending, numberOfGuests }
 */
router.post('/', async (req, res) => {
  try {
    const { name, phone, isAttending, numberOfGuests } = req.body;

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

    const guests = parseInt(numberOfGuests, 10);
    if (isNaN(guests) || guests < 0) {
      return res.status(400).json({
        success: false,
        error: 'Number of guests must be a non-negative integer',
      });
    }

    // Get spreadsheet ID from environment
    const responseSheetId = process.env.GOOGLE_RESPONSE_SHEET_ID;
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
      guests
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
          instructions: `To fix this:\n1. Open your Google Sheet (ID: ${process.env.GOOGLE_RESPONSE_SHEET_ID})\n2. Click the "Share" button\n3. Add this email: ${serviceAccountEmail}\n4. Give it "Editor" permissions\n5. Click "Send"`
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
    const guestSheetId = process.env.GOOGLE_GUEST_SHEET_ID;

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
        name: guest.name,
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

