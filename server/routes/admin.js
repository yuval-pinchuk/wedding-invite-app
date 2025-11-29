import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSenders, getGuestList, filterGuestsBySender, updateSendConfirmation } from '../services/googleSheets.js';
import { initializeWhatsApp, waitForReady, sendWhatsAppInvitation, getQRCode, getStatus, getClient } from '../services/whatsapp.js';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const router = express.Router();

// QR codes and status are now stored in whatsapp.js service

/**
 * GET /api/admin/senders
 * Get list of all senders
 */
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

/**
 * GET /api/admin/guests/:sender
 * Get guests for a specific sender (all guests, not just those marked to send)
 */
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
    // Filter by sender only (not by sendConfirmation)
    const senderGuests = allGuests.filter(guest => {
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

/**
 * POST /api/admin/update-send-status
 * Update send confirmation status for a guest
 */
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
 * POST /api/admin/init-whatsapp
 * Initialize WhatsApp and return QR code
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

    console.log(`[init-whatsapp] Request for sender: ${sender}`);

    // Check if QR code already exists
    let qrCode = getQRCode(sender);
    const status = getStatus(sender);

    console.log(`[init-whatsapp] Current status - ready: ${status.ready}, hasQR: ${!!qrCode}`);

    // If already ready, return immediately
    if (status.ready) {
      return res.json({
        success: true,
        qrCode: status.qrCode,
        ready: true,
      });
    }

    // If QR code exists but not ready, return it
    if (qrCode) {
      return res.json({
        success: true,
        qrCode,
        ready: false,
      });
    }

    // Check if there's a saved session that might prevent QR generation
    const sessionPath = path.resolve(__dirname, `../.wwebjs_auth_${encodeURIComponent(sender)}`);
    const hasSession = fs.existsSync(sessionPath);
    
    if (hasSession) {
      console.log(`[init-whatsapp] Found existing session for ${sender} at ${sessionPath}`);
      console.log(`[init-whatsapp] QR code may not be generated if session is valid`);
    }

    // Initialize WhatsApp (this will trigger QR code generation)
    // Don't wait for ready, just start initialization
    let initError = null;
    let initPromise = null;
    
    console.log(`[init-whatsapp] Starting WhatsApp initialization for ${sender}...`);
    
    try {
      initPromise = initializeWhatsApp(sender);
      // Set up error handler
      initPromise.catch(err => {
        console.error('[init-whatsapp] Error initializing WhatsApp:', err);
        initError = err;
      });
    } catch (err) {
      console.error('[init-whatsapp] Exception during initializeWhatsApp call:', err);
      initError = err;
    }

    // Wait for either QR code OR client to become ready (unlimited time)
    // If session exists, client will go straight to ready without QR
    console.log(`[init-whatsapp] Waiting for QR code or ready status...`);
    let attempts = 0;
    
    while (!qrCode && !initError) {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check for QR code
      qrCode = getQRCode(sender);
      
      // Check if client became ready (from saved session)
      const currentStatus = getStatus(sender);
      if (currentStatus.ready) {
        console.log(`[init-whatsapp] Client is ready (saved session used, no QR needed)`);
        return res.json({
          success: true,
          qrCode: null,
          ready: true,
          message: 'WhatsApp is ready using saved session. No QR code needed.',
        });
      }
      
      attempts++;
      
      if (attempts % 10 === 0) {
        console.log(`[init-whatsapp] Still waiting... (${attempts * 0.5}s elapsed)`);
      }
      
      // Check if initialization promise rejected (non-blocking check)
      if (initPromise && initError === null) {
        try {
          await Promise.race([
            Promise.resolve(initPromise).then(() => {}).catch(e => { throw e; }),
            new Promise(resolve => setTimeout(resolve, 50))
          ]);
        } catch (err) {
          if (!initError) {
            console.error('[init-whatsapp] Detected initialization error:', err);
            initError = err;
          }
        }
      }
    }

    // Check if there was an initialization error
    if (initError) {
      console.error('[init-whatsapp] Initialization failed:', initError);
      return res.status(500).json({
        success: false,
        error: `Failed to initialize WhatsApp: ${initError.message || String(initError)}. Check server logs for details.`,
      });
    }

    // If we get here, we have a QR code
    if (!qrCode) {
      // This shouldn't happen due to the while loop, but just in case
      const finalStatus = getStatus(sender);
      if (finalStatus.ready) {
        return res.json({
          success: true,
          qrCode: null,
          ready: true,
          message: 'WhatsApp is ready using saved session.',
        });
      }
      
      return res.status(500).json({
        success: false,
        error: 'QR code not generated and client not ready. Check server logs for errors.',
        hasSession: hasSession || false,
      });
    }

    console.log(`[init-whatsapp] QR code generated successfully for ${sender}`);
    console.log(`[init-whatsapp] QR code length: ${qrCode ? qrCode.length : 'null'}`);
    console.log(`[init-whatsapp] Sending response with QR code...`);
    res.json({
      success: true,
      qrCode,
      ready: false,
    });
  } catch (error) {
    console.error('[init-whatsapp] Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to initialize WhatsApp',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

/**
 * GET /api/admin/whatsapp-status/:sender
 * Check WhatsApp connection status
 */
router.get('/whatsapp-status/:sender', async (req, res) => {
  try {
    const { sender } = req.params;
    let status = getStatus(sender);

    console.log(`[whatsapp-status] Checking status for ${sender}: ready=${status.ready}, hasQR=${!!status.qrCode}`);

    // Check the actual client status more thoroughly
    // If client has info.wid, it's definitely ready regardless of status flag
    try {
      const client = getClient(sender);
      if (client) {
        console.log(`[whatsapp-status] Client exists for ${sender}, checking info...`);
        
        // Check if client has info property (indicates it's ready)
        if (client.info) {
          console.log(`[whatsapp-status] Client has info property for ${sender}`);
          if (client.info.wid) {
            // Client is actually ready - override status
            status.ready = true;
            status.qrCode = null; // Clear QR code since we're ready
            console.log(`[whatsapp-status] ✅ Client for ${sender} is ready (has info.wid: ${client.info.wid.user})`);
          } else {
            console.log(`[whatsapp-status] Client has info but no wid yet for ${sender}`);
          }
        } else {
          console.log(`[whatsapp-status] Client exists but no info property yet for ${sender}`);
        }
      } else {
        console.log(`[whatsapp-status] No client found for ${sender}`);
      }
    } catch (error) {
      // Client not ready yet or doesn't exist
      console.log(`[whatsapp-status] Error checking client for ${sender}:`, error.message);
    }

    const finalReady = status.ready || false;
    console.log(`[whatsapp-status] Returning status for ${sender}: ready=${finalReady}, qr=${!!status.qrCode}`);

    res.json({
      success: true,
      ready: finalReady,
      qr: status.qrCode || null,
    });
  } catch (error) {
    console.error('[whatsapp-status] Error:', error);
    res.json({
      success: true,
      ready: false,
      qr: null,
    });
  }
});

/**
 * POST /api/admin/send-invitations
 * Send invitations to a list of guests
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

    // Ensure WhatsApp is ready (wait indefinitely)
    console.log(`[send-invitations] Request received for sender: ${sender}, guests: ${guests.length}`);
    console.log(`[send-invitations] Waiting for WhatsApp to be ready for ${sender}...`);
    const client = await waitForReady(sender, null); // null = unlimited wait time
    console.log(`[send-invitations] WhatsApp is ready, client info:`, client?.info ? 'has info' : 'no info');
    console.log(`[send-invitations] Starting to send ${guests.length} invitations...`);

    const results = {
      total: guests.length,
      successful: 0,
      failed: 0,
      details: [],
    };

    // Compose Hebrew message function
    function composeHebrewMessage(name, addons, rsvpLink) {
      let message = `שלום ${name}, הינכם מוזמנים לחתונה של דניאל ויובל! לאישור הגעה לחצו על הקישור:`;
      
      if (addons && addons.trim()) {
        message = `שלום ${name} ו${addons}, הינכם מוזמנים לחתונה של דניאל ויובל! לאישור הגעה לחצו על הקישור:`;
      }
      
      return message;
    }

    // Send invitations
    console.log(`[send-invitations] Starting to send to ${guests.length} guests...`);
    for (let i = 0; i < guests.length; i++) {
      const guest = guests[i];
      try {
        console.log(`[send-invitations] Sending to guest ${i + 1}/${guests.length}: ${guest.name} (${guest.phone})`);
        const rsvpLink = `${rsvpBaseUrl}?phone=${encodeURIComponent(guest.phone)}`;
        const message = composeHebrewMessage(guest.name, guest.addons, rsvpLink);

        const result = await sendWhatsAppInvitation(
          guest.phone,
          sender,
          message,
          rsvpLink
        );

        console.log(`[send-invitations] Result for ${guest.name}:`, result.success ? 'SUCCESS' : 'FAILED', result.error || '');

        if (result.success) {
          results.successful++;
        } else {
          results.failed++;
        }

        results.details.push({
          name: guest.name,
          phone: guest.phone,
          ...result,
        });

        // Delay between messages
        if (i < guests.length - 1) {
          console.log(`[send-invitations] Waiting 3 seconds before next message...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        console.error(`[send-invitations] Exception sending to ${guest.name}:`, error);
        results.failed++;
        results.details.push({
          name: guest.name,
          phone: guest.phone,
          success: false,
          error: error.message,
        });
      }
    }
    
    console.log(`[send-invitations] Finished sending. Success: ${results.successful}, Failed: ${results.failed}`);

    res.json({
      success: true,
      ...results,
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
 * DELETE /api/admin/clear-session/:sender
 * Clear WhatsApp session to force QR code generation
 */
router.delete('/clear-session/:sender', async (req, res) => {
  try {
    const { sender } = req.params;
    
    const sessionPath = path.resolve(__dirname, `../.wwebjs_auth_${encodeURIComponent(sender)}`);
    
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`[clear-session] Deleted session for ${sender} at ${sessionPath}`);
      
      // Also clear from memory
      const client = getClient(sender);
      if (client) {
        try {
          await client.destroy();
        } catch (err) {
          console.warn(`[clear-session] Error destroying client:`, err.message);
        }
      }
      
      res.json({
        success: true,
        message: `Session cleared for ${sender}. Next initialization will require QR code.`,
      });
    } else {
      res.json({
        success: true,
        message: `No session found for ${sender}.`,
      });
    }
  } catch (error) {
    console.error('Error clearing session:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear session',
    });
  }
});

export default router;

