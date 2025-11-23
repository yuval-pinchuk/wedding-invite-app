import whatsappWeb, { Client } from 'whatsapp-web.js';
const { LocalAuth } = whatsappWeb.default || whatsappWeb;
import qrcodeTerminal from 'qrcode-terminal';
import dotenv from 'dotenv';

dotenv.config();

// Store multiple WhatsApp clients (one per sender)
const whatsappClients = new Map(); // Map of sender name -> client
const clientStatus = new Map(); // Map of sender name -> { isReady, qrCodeResolve }

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
    if (status && status.isReady && whatsappClients.get(senderName)) {
      return whatsappClients.get(senderName);
    }
  }

  return new Promise((resolve, reject) => {
    // Initialize status for this sender
    const status = { isReady: false, qrCodeResolve: null };
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

    // Store client
    whatsappClients.set(senderName, whatsappClient);

    // QR Code generation for first-time login
    whatsappClient.on('qr', (qr) => {
      console.log(`\n📱 WhatsApp QR Code for ${senderName} - Scan this with your phone:`);
      console.log('(Open WhatsApp > Settings > Linked Devices > Link a Device)\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log(`\nWaiting for QR code scan for ${senderName}...\n`);
      
      if (status.qrCodeResolve) {
        status.qrCodeResolve(qr);
      }
    });

    // Ready event - client is ready to send messages
    whatsappClient.on('ready', async () => {
      console.log(`✅ WhatsApp client for ${senderName} is ready!`);
      // Wait a bit more to ensure everything is fully initialized
      await new Promise(resolve => setTimeout(resolve, 3000));
      status.isReady = true;
      resolve(whatsappClient);
    });

    // Authentication event
    whatsappClient.on('authenticated', () => {
      console.log(`✅ WhatsApp authenticated for ${senderName}`);
      console.log(`   Waiting for client to fully initialize...`);
    });

    // Authentication failure
    whatsappClient.on('auth_failure', (msg) => {
      console.error(`❌ WhatsApp authentication failed for ${senderName}:`, msg);
      reject(new Error(`WhatsApp authentication failed for ${senderName}`));
    });

    // Disconnected event
    whatsappClient.on('disconnected', (reason) => {
      console.log(`⚠️  WhatsApp client disconnected for ${senderName}:`, reason);
      status.isReady = false;
      whatsappClients.delete(senderName);
      clientStatus.delete(senderName);
    });

    // Initialize the client
    whatsappClient.initialize().catch(reject);
  });
}

/**
 * Wait for WhatsApp client to be ready for a specific sender
 * @param {string} senderName - Name of the sender
 * @param {number} maxWaitTime - Maximum time to wait in milliseconds (default: 120000 = 2 minutes)
 */
export async function waitForReady(senderName = 'default', maxWaitTime = 120000) {
  if (whatsappClients.has(senderName)) {
    const status = clientStatus.get(senderName);
    if (status && status.isReady && whatsappClients.get(senderName)) {
      const client = whatsappClients.get(senderName);
      // Double-check that client is actually ready
      if (client.info && client.info.wid) {
        return client;
      }
    }
  }
  
  const client = await initializeWhatsApp(senderName);
  
  // Wait for client to be fully ready with timeout
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitTime) {
    const status = clientStatus.get(senderName);
    if (status && status.isReady && client && client.info && client.info.wid) {
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
