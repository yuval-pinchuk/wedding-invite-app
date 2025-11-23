import dotenv from 'dotenv';
import readline from 'readline';
import { configureSheets, getGuestList, getSenders, filterGuestsBySender } from '../server/services/googleSheets.js';
import { sendWhatsAppInvitation, initializeWhatsApp } from '../server/services/whatsapp.js';

dotenv.config();

/**
 * Script to send WhatsApp invitations to all guests in the Google Sheet
 * 
 * Usage: npm run send:invitations
 * 
 * Environment variables required:
 * - GOOGLE_GUEST_SHEET_ID: ID of the sheet with guest list
 * - GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY
 * - RSVP_BASE_URL: Base URL for RSVP links (e.g., https://yourdomain.com)
 * 
 * Note: This uses WhatsApp Web.js (free, unofficial). On first run, you'll need to
 * scan a QR code with your WhatsApp to authenticate. The session will be saved for future use.
 * 
 * Sheet structure (Hebrew):
 * - Column A: First name (Hebrew)
 * - Column L: Addons (optional, Hebrew name)
 * - Column N: לשלוח אישורי הגעה (Send confirmation - filter by "v")
 * - Column O: Sender (Hebrew name - filter by selected sender)
 */

/**
 * Ask user to select a sender from the list
 */
function askForSender(senders) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n📋 Available senders:');
    senders.forEach((sender, index) => {
      console.log(`  ${index + 1}. ${sender}`);
    });

    rl.question('\nPlease select a sender number (or enter sender name): ', (answer) => {
      rl.close();
      
      // Try to parse as number first
      const index = parseInt(answer, 10) - 1;
      if (index >= 0 && index < senders.length) {
        resolve(senders[index]);
      } else {
        // Try to find by name
        const found = senders.find(s => s.trim() === answer.trim());
        if (found) {
          resolve(found);
        } else {
          console.error(`Invalid selection: ${answer}`);
          console.log('Please run the script again and select a valid sender.');
          process.exit(1);
        }
      }
    });
  });
}

/**
 * Compose Hebrew invitation message
 */
function composeHebrewMessage(name, addons, rsvpLink) {
  let message = `שלום ${name}, הינכם מוזמנים לחתונה של דניאל ויובל! לאישור הגעה לחצו על הקישור:`;
  
  // Add addons if present
  if (addons && addons.trim()) {
    message = `שלום ${name} ו${addons}, הינכם מוזמנים לחתונה של דניאל ויובל! לאישור הגעה לחצו על הקישור:`;
  }
  
  return message;
}

async function sendInvitations() {
  try {
    // Get configuration from environment
    const guestSheetId = process.env.GOOGLE_GUEST_SHEET_ID;
    const rsvpBaseUrl = process.env.RSVP_BASE_URL || 'http://localhost:8080';

    if (!guestSheetId) {
      console.error('Error: GOOGLE_GUEST_SHEET_ID is not set in .env file');
      process.exit(1);
    }

    console.log('🔧 Configuring Google Sheets API...');
    await configureSheets();

    console.log('📋 Reading guest list from Google Sheet...');
    const allGuests = await getGuestList(guestSheetId);

    if (allGuests.length === 0) {
      console.log('No guests found in the sheet. Please check your sheet ID and range.');
      process.exit(0);
    }

    // Get unique senders
    const senders = await getSenders(guestSheetId);
    
    if (senders.length === 0) {
      console.error('No senders found in column O. Please check your sheet.');
      process.exit(1);
    }

    // Ask user to select a sender
    const selectedSender = await askForSender(senders);
    console.log(`\n✅ Selected sender: ${selectedSender}`);

    // Filter guests by sender and send confirmation status (column N = "v")
    const filteredGuests = filterGuestsBySender(allGuests, selectedSender);

    if (filteredGuests.length === 0) {
      console.log(`\n⚠️  No guests found for sender "${selectedSender}" with send confirmation marked as "v".`);
      console.log('Please check column N (לשלוח אישורי הגעה) and column O (Sender) in your sheet.');
      process.exit(0);
    }

    console.log(`\n✅ Found ${filteredGuests.length} guest(s) to send invitations to:`);
    filteredGuests.forEach((guest, index) => {
      const addonsText = guest.addons ? ` (+ ${guest.addons})` : '';
      console.log(`  ${index + 1}. ${guest.name}${addonsText} - ${guest.phoneTo}`);
    });

    // Initialize WhatsApp for this sender
    console.log(`\n📱 Initializing WhatsApp for ${selectedSender}...`);
    console.log('   (If this is your first time, you\'ll need to scan a QR code)');
    await initializeWhatsApp(selectedSender);

    // Confirm before sending
    console.log('\n⚠️  Ready to send invitations!');
    console.log(`   Sender: ${selectedSender}`);
    console.log(`   RSVP URL: ${rsvpBaseUrl}`);
    console.log(`   Total guests: ${filteredGuests.length}`);
    console.log('\nPress Ctrl+C to cancel, or wait 5 seconds to proceed...\n');

    // Wait 5 seconds before sending
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('📤 Sending invitations...\n');

    // Generate unique RSVP links and compose Hebrew messages
    const guestsWithMessages = filteredGuests.map(guest => {
      const rsvpLink = `${rsvpBaseUrl}?phone=${encodeURIComponent(guest.phoneTo)}`;
      const message = composeHebrewMessage(guest.name, guest.addons, rsvpLink);
      return {
        ...guest,
        rsvpLink,
        message,
      };
    });

    // Send invitations
    const results = {
      total: guestsWithMessages.length,
      successful: 0,
      failed: 0,
      details: [],
    };

    for (const guest of guestsWithMessages) {
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
        selectedSender,
        guest.message,
        guest.rsvpLink
      );

      if (result.success) {
        results.successful++;
        console.log(`✅ Sent to ${guest.name}`);
      } else {
        results.failed++;
        console.log(`❌ Failed to send to ${guest.name}: ${result.error}`);
      }

      results.details.push({
        name: guest.name,
        phone: guest.phoneTo,
        ...result,
      });

      // Delay between messages to avoid rate limiting
      if (guestsWithMessages.indexOf(guest) < guestsWithMessages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // Print summary
    console.log('\n📊 Summary:');
    console.log(`   Total: ${results.total}`);
    console.log(`   ✅ Successful: ${results.successful}`);
    console.log(`   ❌ Failed: ${results.failed}`);

    if (results.failed > 0) {
      console.log('\n❌ Failed invitations:');
      results.details
        .filter(d => !d.success)
        .forEach(d => {
          console.log(`   - ${d.name} (${d.phone}): ${d.error}`);
        });
    }

    console.log('\n✨ Done!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error sending invitations:', error.message);
    console.error(error);
    process.exit(1);
  }
}

// Run the script
sendInvitations();

