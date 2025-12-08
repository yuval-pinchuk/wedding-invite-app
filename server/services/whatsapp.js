import whatsappWeb, { Client } from 'whatsapp-web.js';
const { LocalAuth } = whatsappWeb.default || whatsappWeb;
import dotenv from 'dotenv';

dotenv.config();

// Store multiple WhatsApp clients (one per sender)
const whatsappClients = new Map(); // Map of sender name -> client
const clientStatus = new Map(); // Map of sender name -> { isReady, qrCodeResolve, qrCode }

/**
 * Initialize WhatsApp client for a specific sender
 * Note: This uses WhatsApp Web.js which is an unofficial library.
 * It may violate WhatsApp's Terms of Service. Use at your own risk.
 * @param {string} senderName - Name of the sender (used to create separate session)
 */
export async function initializeWhatsApp(senderName = 'default') {
  // Check if client already exists and is ready
  if (whatsappClients.has(senderName)) {
    const status = clientStatus.get(senderName);
    const client = whatsappClients.get(senderName);
    if (status && status.isReady && client && client.info && client.info.wid) {
      console.log(`[WhatsApp] Client for ${senderName} is already ready`);
      return client;
    }
    // If client exists but isn't ready, check if it has a QR code
    if (status && status.qrCode) {
      console.log(`[WhatsApp] Client for ${senderName} exists with QR code, waiting for scan...`);
      // Return the existing client promise - it will resolve when ready
      // But we still want to return a promise that resolves to the client
    }
  }

  return new Promise((resolve, reject) => {
    // Initialize or update status for this sender
    let status = clientStatus.get(senderName);
    if (!status) {
      status = { isReady: false, qrCodeResolve: null, qrCode: null };
    } else {
      // Reset ready status but keep existing QR code if any
      status.isReady = false;
    }
    clientStatus.set(senderName, status);

    // Create client with local auth to persist session per sender
    // Use sender name in data path to create separate sessions
    const whatsappClient = new Client({
      authStrategy: new LocalAuth({
        dataPath: `./.wwebjs_auth_${encodeURIComponent(senderName)}`
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    // Store client (replace if exists)
    whatsappClients.set(senderName, whatsappClient);
    
    console.log(`[WhatsApp] Starting initialization for ${senderName}...`);
    console.log(`[WhatsApp] Event listeners will be registered before initialize()`);

    // Register ALL event listeners BEFORE calling initialize()
    // This ensures we catch all events including QR code
    
    // Loading screen event - shows what's happening
    whatsappClient.on('loading_screen', (percent, message) => {
      console.log(`[WhatsApp] Loading: ${percent}% - ${message}`);
    });

    // QR Code generation for first-time login (only fires if no saved session)
    whatsappClient.on('qr', (qr) => {
      console.log(`[WhatsApp] QR Code generated for ${senderName}`);
      
      // Store QR code in status (will be displayed in admin.html)
      // Note: QR codes are large strings, they will be cleared from memory once client is ready
      status.qrCode = qr;
      status.isReady = false; // Make sure ready is false when QR is shown
      clientStatus.set(senderName, status);
      
      console.log(`[WhatsApp] QR code stored for ${senderName} - available in admin panel`);
      
      if (status.qrCodeResolve) {
        status.qrCodeResolve(qr);
        // Clear resolve function after calling to free memory
        status.qrCodeResolve = null;
      }
    });

    // Ready event - client is ready to send messages
    whatsappClient.on('ready', async () => {
      console.log(`✅ WhatsApp client for ${senderName} is ready!`);
      // Wait a bit more to ensure everything is fully initialized
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Update status - make sure to get fresh status and update it
      const currentStatus = clientStatus.get(senderName);
      if (currentStatus) {
        currentStatus.isReady = true;
        // Clear QR code from memory since we're now ready (memory optimization)
        currentStatus.qrCode = null;
        currentStatus.qrCodeResolve = null; // Clear resolve function to free memory
        clientStatus.set(senderName, currentStatus);
        console.log(`[WhatsApp] Status updated for ${senderName}: isReady=true, qrCode cleared from memory`);
      } else {
        // Create minimal status if it doesn't exist (only store what's needed)
        clientStatus.set(senderName, { isReady: true, qrCode: null, qrCodeResolve: null });
        console.log(`[WhatsApp] Created new status for ${senderName}: isReady=true`);
      }
      
      // Update status variable for the promise resolve
      status.isReady = true;
      status.qrCode = null;
      status.qrCodeResolve = null;
      
      resolve(whatsappClient);
    });

    // Authentication event (fires when session is restored or after QR scan)
    whatsappClient.on('authenticated', () => {
      console.log(`✅ WhatsApp authenticated for ${senderName}`);
      console.log(`   This means either:`);
      console.log(`   1. Session was restored from saved data (no QR needed)`);
      console.log(`   2. QR code was scanned successfully`);
      console.log(`   Waiting for client to fully initialize...`);
    });

    // Authentication failure
    whatsappClient.on('auth_failure', (msg) => {
      console.error(`❌ WhatsApp authentication failed for ${senderName}:`, msg);
      reject(new Error(`WhatsApp authentication failed for ${senderName}`));
    });

    // Disconnected event - cleanup memory
    whatsappClient.on('disconnected', (reason) => {
      console.log(`⚠️  WhatsApp client disconnected for ${senderName}:`, reason);
      status.isReady = false;
      // Clear QR code from memory before deleting
      status.qrCode = null;
      status.qrCodeResolve = null;
      // Remove from maps to free memory
      whatsappClients.delete(senderName);
      clientStatus.delete(senderName);
      console.log(`[WhatsApp] Cleaned up memory for ${senderName}`);
    });

    // Initialize the client
    console.log(`[WhatsApp] Calling initialize() for ${senderName}...`);
    console.log(`[WhatsApp] If you see 'authenticated' without 'qr', it means a saved session exists.`);
    console.log(`[WhatsApp] To force QR code, delete the folder: .wwebjs_auth_${encodeURIComponent(senderName)}`);
    
    whatsappClient.initialize().catch((err) => {
      console.error(`[WhatsApp] Initialization error for ${senderName}:`, err);
      console.error(`[WhatsApp] Error details:`, err.message, err.stack);
      reject(err);
    });
    
    // Add a timeout to detect if initialization is stuck
    setTimeout(() => {
      if (!status.qrCode && !status.isReady) {
        console.warn(`[WhatsApp] Initialization for ${senderName} taking longer than expected...`);
        console.warn(`[WhatsApp] No QR code yet. This could mean:`);
        console.warn(`   1. A saved session exists (check .wwebjs_auth_${encodeURIComponent(senderName)})`);
        console.warn(`   2. Initialization is still in progress`);
        console.warn(`   3. An error occurred (check logs above)`);
      }
    }, 5000);
  });
}

/**
 * Wait for WhatsApp client to be ready for a specific sender
 * @param {string} senderName - Name of the sender
 * @param {number} maxWaitTime - Maximum time to wait in milliseconds (default: 120000 = 2 minutes)
 */
export async function waitForReady(senderName = 'default', maxWaitTime = null) {
  // If maxWaitTime is null, wait indefinitely
  console.log(`[waitForReady] Checking if client for ${senderName} is ready...`);
  
  if (whatsappClients.has(senderName)) {
    const status = clientStatus.get(senderName);
    const client = whatsappClients.get(senderName);
    console.log(`[waitForReady] Client exists. Status ready: ${status?.isReady}, has client: ${!!client}, has info: ${!!client?.info}`);
    
    if (status && status.isReady && client) {
      // Double-check that client is actually ready
      if (client.info && client.info.wid) {
        console.log(`[waitForReady] Client is ready, returning immediately`);
        return client;
      } else {
        console.log(`[waitForReady] Client exists but info/wid not available yet`);
      }
    }
  }
  
  console.log(`[waitForReady] Initializing or waiting for client ${senderName}...`);
  const client = await initializeWhatsApp(senderName);
  console.log(`[waitForReady] initializeWhatsApp returned, checking if ready...`);
  
  // Wait for client to be fully ready (unlimited time if maxWaitTime is null)
  const startTime = Date.now();
  let checkCount = 0;
  while (maxWaitTime === null || Date.now() - startTime < maxWaitTime) {
    const status = clientStatus.get(senderName);
    checkCount++;
    
    if (checkCount % 5 === 0) {
      console.log(`[waitForReady] Still waiting... (check ${checkCount}, status ready: ${status?.isReady}, has client: ${!!client}, has info: ${!!client?.info})`);
    }
    
    if (status && status.isReady && client && client.info && client.info.wid) {
      console.log(`[waitForReady] Client is ready after ${checkCount} checks!`);
      // Add a small delay to ensure everything is fully initialized
      await new Promise(resolve => setTimeout(resolve, 2000));
      return client;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error(`WhatsApp client for ${senderName} did not become ready within ${maxWaitTime}ms`);
}

/**
 * Get client for a specific sender
 * @param {string} senderName - Name of the sender
 */
export function getClient(senderName = 'default') {
  return whatsappClients.get(senderName);
}

/**
 * Get QR code for a specific sender
 * @param {string} senderName - Name of the sender
 * @returns {string|null} QR code string or null if not available
 */
export function getQRCode(senderName = 'default') {
  const status = clientStatus.get(senderName);
  return status?.qrCode || null;
}

/**
 * Get status for a specific sender
 * @param {string} senderName - Name of the sender
 * @returns {Object} Status object with ready and qrCode
 */
export function getStatus(senderName = 'default') {
  const status = clientStatus.get(senderName);
  // Return minimal status object (don't include qrCodeResolve to save memory)
  return {
    ready: status?.isReady || false,
    qrCode: status?.qrCode || null,
  };
}

/**
 * Clean up old QR codes from memory (call periodically to free memory)
 * QR codes are large strings and should be cleared after use
 */
export function cleanupOldQRCodes(maxAgeMinutes = 10) {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [senderName, status] of clientStatus.entries()) {
    // If client is ready, QR code should already be null
    // If QR code exists and client is ready, clear it
    if (status.isReady && status.qrCode) {
      status.qrCode = null;
      status.qrCodeResolve = null;
      clientStatus.set(senderName, status);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[WhatsApp] Cleaned up ${cleaned} old QR code(s) from memory`);
  }
  
  return cleaned;
}

/**
 * Format phone number for WhatsApp
 * Handles Israeli numbers (starts with 0) by converting to country code format
 * @param {string} phone - Phone number in various formats
 * @returns {string} Formatted phone number without @c.us suffix
 */
function formatPhoneNumber(phone) {
  // Remove all non-digit characters except +
  let cleaned = phone.replace(/[^\d+]/g, '');
  
  // Handle Israeli numbers (start with 0 or 972)
  // If starts with 0, replace with 972 (Israel country code)
  if (cleaned.startsWith('0')) {
    cleaned = '972' + cleaned.substring(1);
  } else if (cleaned.startsWith('+972')) {
    cleaned = cleaned.substring(1); // Remove + but keep 972
  } else if (!cleaned.startsWith('972') && cleaned.length === 9) {
    // Assume it's an Israeli number without country code
    cleaned = '972' + cleaned;
  }
  
  // Remove leading + if present
  cleaned = cleaned.replace(/^\+/, '');
  
  return cleaned;
}

/**
 * Send WhatsApp invitation to a guest
 * @param {string} to - Recipient phone number (E.164 format: +1234567890 or without +)
 * @param {string} senderName - Name of the sender (for WhatsApp client selection)
 * @param {string} message - Invitation message (already formatted with name and addons)
 * @param {string} rsvpLink - Link to RSVP landing page
 * @returns {Promise<Object>} Message result
 */
export async function sendWhatsAppInvitation(to, senderName, message, rsvpLink, retries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await waitForReady(senderName);
      
      // Verify client is actually ready
      if (!client || !client.info || !client.info.wid) {
        throw new Error('WhatsApp client is not fully initialized');
      }
      
      // Format phone number
      const phoneNumber = formatPhoneNumber(to);
      
      // Combine message with RSVP link
      const fullMessage = `${message}\n\n${rsvpLink}`;

      // Send message - format: countrycode + number@c.us
      const chatId = `${phoneNumber}@c.us`;
      
      console.log(`📤 Attempting to send to ${phoneNumber} (chatId: ${chatId})...`);
      console.log(`   Original number: ${to}`);
      console.log(`   Formatted number: ${phoneNumber}`);
      
      // Add a small delay before sending to ensure client is stable
      if (attempt === 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Check if number is registered (optional check)
      try {
        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
          console.warn(`   ⚠️  Warning: Phone number ${phoneNumber} may not be registered on WhatsApp`);
          console.warn(`   The message may not be delivered if the number is not on WhatsApp`);
        } else {
          console.log(`   ✓ Number is registered on WhatsApp`);
        }
      } catch (checkError) {
        console.log(`   ℹ️  Could not verify registration status (will attempt to send anyway)`);
      }
      
      // Send the message
      console.log(`   Sending message (length: ${fullMessage.length} chars)...`);
      console.log(`   Message preview: ${fullMessage.substring(0, 50)}...`);
      const messageResult = await client.sendMessage(chatId, fullMessage);
      
      if (!messageResult || !messageResult.id) {
        throw new Error('sendMessage returned invalid result - no message ID');
      }
      
      console.log(`   Message sent, ID: ${messageResult.id._serialized}`);
      
      // Wait a moment for the message to be processed by WhatsApp
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Try to verify by getting the chat and checking for the message
      try {
        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 10 });
        const foundMessage = messages.find(msg => msg.id._serialized === messageResult.id._serialized);
        
        if (foundMessage) {
          console.log(`✅ WhatsApp invitation confirmed sent to ${phoneNumber}`);
          console.log(`   Message found in chat history`);
        } else {
          console.log(`✅ WhatsApp invitation sent to ${phoneNumber}`);
          console.log(`   ⚠️  Note: Message not yet visible in chat (may still be processing)`);
        }
      } catch (verifyError) {
        console.log(`✅ WhatsApp invitation sent to ${phoneNumber} (Message ID: ${messageResult.id._serialized})`);
        console.log(`   ⚠️  Note: Could not verify in chat history: ${verifyError.message}`);
      }

      return {
        success: true,
        id: messageResult.id._serialized,
        to: phoneNumber,
        chatId: chatId,
      };
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || String(error);
      console.error(`❌ Error sending WhatsApp to ${to} (attempt ${attempt}/${retries}):`, errorMsg);
      
      // Log full error for debugging
      if (error.stack) {
        console.error(`   Stack trace:`, error.stack);
      }
      
      // If it's an evaluation error, wait longer before retry
      if (errorMsg.includes('Evaluation failed') || errorMsg.includes('Protocol error') || errorMsg.includes('not registered')) {
        if (attempt < retries) {
          console.log(`   Waiting 5 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } else {
        // For other errors, break early
        break;
      }
    }
  }
  
  return {
    success: false,
    error: lastError?.message || String(lastError) || 'Unknown error',
    to: to,
  };
}

/**
 * Send invitations to multiple guests
 * @param {Array} guests - Array of guest objects with name, phoneTo, phoneFrom
 * @param {string} message - Invitation message
 * @param {string} rsvpLink - Link to RSVP landing page
 * @param {number} delayMs - Delay between messages in milliseconds (default: 3000)
 * @returns {Promise<Object>} Summary of sent invitations
 */
export async function sendBulkInvitations(guests, message, rsvpLink, delayMs = 3000) {
  const results = {
    total: guests.length,
    successful: 0,
    failed: 0,
    details: [],
  };

  // Ensure WhatsApp client is ready
  await waitForReady();

  for (const guest of guests) {
    if (!guest.phoneTo) {
      console.warn(`⚠️  Skipping ${guest.name}: missing phone number`);
      results.failed++;
      results.details.push({
        name: guest.name,
        success: false,
        error: 'Missing phone number',
      });
      continue;
    }

    const result = await sendWhatsAppInvitation(
      guest.phoneTo,
      guest.phoneFrom, // Not used but kept for compatibility
      message,
      rsvpLink
    );

    if (result.success) {
      results.successful++;
    } else {
      results.failed++;
    }

    results.details.push({
      name: guest.name,
      phone: guest.phoneTo,
      ...result,
    });

    // Delay between messages to avoid rate limiting and look more natural
    if (delayMs > 0 && guests.indexOf(guest) < guests.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}
