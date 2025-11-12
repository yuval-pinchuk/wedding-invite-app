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
    res.status(500).json({
      success: false,
      error: 'Failed to process RSVP. Please try again later.',
    });
  }
});

/**
 * GET /api/rsvp/:phone
 * Get existing RSVP for a phone number (optional feature)
 */
router.get('/:phone', async (req, res) => {
  try {
    // This is a placeholder - you can implement reading from the sheet if needed
    res.json({
      success: true,
      message: 'RSVP lookup not implemented yet',
    });
  } catch (error) {
    console.error('Error fetching RSVP:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch RSVP',
    });
  }
});

export default router;

