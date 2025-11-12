import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';
import dotenv from 'dotenv';

dotenv.config();

let whatsappClient = null;
let isReady = false;
let qrCodeResolve = null;

/**
 * Initialize WhatsApp client
 * Note: This uses WhatsApp Web.js which is an unofficial library.
 * It may violate WhatsApp's Terms of Service. Use at your own risk.
 */
export async function initializeWhatsApp() {
  if (whatsappClient && isReady) {
    return whatsappClient;
  }

  return new Promise((resolve, reject) => {
    // Create client with local auth to persist session
    whatsappClient = new Client({
      authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    // QR Code generation for first-time login
    whatsappClient.on('qr', (qr) => {
      console.log('\n📱 WhatsApp QR Code - Scan this with your phone:');
      console.log('(Open WhatsApp > Settings > Linked Devices > Link a Device)\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\nWaiting for QR code scan...\n');
      
      if (qrCodeResolve) {
        qrCodeResolve(qr);
      }
    });

    // Ready event - client is ready to send messages
    whatsappClient.on('ready', () => {
      console.log('✅ WhatsApp client is ready!');
      isReady = true;
      resolve(whatsappClient);
    });

    // Authentication event
    whatsappClient.on('authenticated', () => {
      console.log('✅ WhatsApp authenticated');
    });

    // Authentication failure
    whatsappClient.on('auth_failure', (msg) => {
      console.error('❌ WhatsApp authentication failed:', msg);
      reject(new Error('WhatsApp authentication failed'));
    });

    // Disconnected event
    whatsappClient.on('disconnected', (reason) => {
      console.log('⚠️  WhatsApp client disconnected:', reason);
      isReady = false;
      whatsappClient = null;
    });

    // Initialize the client
    whatsappClient.initialize().catch(reject);
  });
}

/**
 * Wait for WhatsApp client to be ready
 */
export async function waitForReady() {
  if (isReady && whatsappClient) {
    return whatsappClient;
  }
  return await initializeWhatsApp();
}

/**
 * Send WhatsApp invitation to a guest
 * @param {string} to - Recipient phone number (E.164 format: +1234567890 or without +)
 * @param {string} from - Sender WhatsApp number (not used with WhatsApp Web.js, but kept for compatibility)
 * @param {string} message - Invitation message
 * @param {string} rsvpLink - Link to RSVP landing page
 * @returns {Promise<Object>} Message result
 */
export async function sendWhatsAppInvitation(to, from, message, rsvpLink) {
  try {
    const client = await waitForReady();
    
    // Format phone number (remove + and any spaces/dashes)
    // WhatsApp Web.js expects format: country code + number (e.g., 1234567890)
    let phoneNumber = to.replace(/[+\s-()]/g, '');
    
    // Ensure it's in international format (add country code if missing)
    // For WhatsApp Web.js, format should be: countrycode + number (no + sign)
    // Example: 1234567890 for US number
    
    // Combine message with RSVP link
    const fullMessage = `${message}\n\nRSVP here: ${rsvpLink}`;

    // Send message - format: countrycode + number@c.us
    const chatId = `${phoneNumber}@c.us`;
    
    const messageResult = await client.sendMessage(chatId, fullMessage);

    console.log(`✅ WhatsApp invitation sent to ${phoneNumber}`);
    return {
      success: true,
      id: messageResult.id._serialized,
      to: phoneNumber,
    };
  } catch (error) {
    console.error(`❌ Error sending WhatsApp to ${to}:`, error.message);
    return {
      success: false,
      error: error.message,
      to: to,
    };
  }
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
