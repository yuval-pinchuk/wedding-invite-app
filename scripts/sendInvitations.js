import dotenv from 'dotenv';
import { configureSheets, getGuestList } from '../server/services/googleSheets.js';
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
 * - INVITATION_MESSAGE: The message to send (or use default)
 * - RSVP_BASE_URL: Base URL for RSVP links (e.g., https://yourdomain.com)
 * 
 * Note: This uses WhatsApp Web.js (free, unofficial). On first run, you'll need to
 * scan a QR code with your WhatsApp to authenticate. The session will be saved for future use.
 */

async function sendInvitations() {
  try {
    // Get configuration from environment
    const guestSheetId = process.env.GOOGLE_GUEST_SHEET_ID;
    const rsvpBaseUrl = process.env.RSVP_BASE_URL || 'http://localhost:8080';
    const invitationMessage = process.env.INVITATION_MESSAGE || 
      `You're invited to our wedding! 🎉\n\nWe would love to celebrate this special day with you. Please let us know if you can join us.`;

    if (!guestSheetId) {
      console.error('Error: GOOGLE_GUEST_SHEET_ID is not set in .env file');
      process.exit(1);
    }

    console.log('🔧 Configuring Google Sheets API...');
    await configureSheets();

    console.log('📱 Initializing WhatsApp client...');
    console.log('   (If this is your first time, you\'ll need to scan a QR code)');
    await initializeWhatsApp();

    console.log('📋 Reading guest list from Google Sheet...');
    const guests = await getGuestList(guestSheetId);

    if (guests.length === 0) {
      console.log('No guests found in the sheet. Please check your sheet ID and range.');
      process.exit(0);
    }

    console.log(`✅ Found ${guests.length} guest(s)`);
    console.log('\nGuest list:');
    guests.forEach((guest, index) => {
      console.log(`  ${index + 1}. ${guest.name} - ${guest.phoneTo}`);
    });

    // Confirm before sending
    console.log('\n⚠️  Ready to send invitations!');
    console.log(`   Message: ${invitationMessage.substring(0, 50)}...`);
    console.log(`   RSVP URL: ${rsvpBaseUrl}`);
    console.log(`   Total guests: ${guests.length}`);
    console.log('\nPress Ctrl+C to cancel, or wait 5 seconds to proceed...\n');

    // Wait 5 seconds before sending
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('📤 Sending invitations...\n');

    // Generate unique RSVP links with phone numbers for easier access
    const guestsWithLinks = guests.map(guest => ({
      ...guest,
      rsvpLink: `${rsvpBaseUrl}?phone=${encodeURIComponent(guest.phoneTo)}`,
    }));

    // Create a custom send function that uses individual links
    const customResults = {
      total: guestsWithLinks.length,
      successful: 0,
      failed: 0,
      details: [],
    };

    for (const guest of guestsWithLinks) {
      if (!guest.phoneTo || !guest.phoneFrom) {
        console.warn(`Skipping ${guest.name}: missing phone numbers`);
        customResults.failed++;
        customResults.details.push({
          name: guest.name,
          success: false,
          error: 'Missing phone numbers',
        });
        continue;
      }

      const result = await sendWhatsAppInvitation(
        guest.phoneTo,
        guest.phoneFrom,
        invitationMessage,
        guest.rsvpLink
      );

      if (result.success) {
        customResults.successful++;
      } else {
        customResults.failed++;
      }

      customResults.details.push({
        name: guest.name,
        phone: guest.phoneTo,
        ...result,
      });

      // Delay between messages to avoid rate limiting
      if (guestsWithLinks.indexOf(guest) < guestsWithLinks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const results = customResults;

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

