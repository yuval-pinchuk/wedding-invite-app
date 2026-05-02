import '../server/config/loadEnv.js';
import readline from 'readline';
import { envGuestSheetId } from '../server/config/loadEnv.js';
import { configureSheets, getGuestList, getSenders, filterGuestsBySender } from '../server/services/googleSheets.js';
import {
  initializeWhatsApp,
  waitForReady,
  sendWhatsAppInvitation,
} from '../server/services/whatsapp.js';

/**
 * Usage: npm run send:invitations
 *
 * Requires Google env vars.
 * WhatsApp: Baileys (personal). First run: scan QR in admin or run init once.
 */

function askForSender(senders) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('\nAvailable senders:');
    senders.forEach((sender, index) => {
      console.log(`  ${index + 1}. ${sender}`);
    });

    rl.question('\nSelect a sender number (or enter sender name): ', (answer) => {
      rl.close();

      const index = parseInt(answer, 10) - 1;
      if (index >= 0 && index < senders.length) {
        resolve(senders[index]);
      } else {
        const found = senders.find((s) => s.trim() === answer.trim());
        if (found) {
          resolve(found);
        } else {
          console.error(`Invalid selection: ${answer}`);
          process.exit(1);
        }
      }
    });
  });
}

async function sendInvitations() {
  try {
    const guestSheetId = envGuestSheetId();

    if (!guestSheetId) {
      console.error('Error: GOOGLE_GUEST_SHEET_ID is not set');
      process.exit(1);
    }

    await configureSheets();
    const allGuests = await getGuestList(guestSheetId);

    if (allGuests.length === 0) {
      console.log('No guests in sheet.');
      process.exit(0);
    }

    const senders = await getSenders(guestSheetId);
    if (senders.length === 0) {
      console.error('No senders in column O.');
      process.exit(1);
    }

    const selectedSender = await askForSender(senders);
    console.log(`\nSender: ${selectedSender}`);

    const filteredGuests = filterGuestsBySender(allGuests, selectedSender);
    if (filteredGuests.length === 0) {
      console.log('No guests with send flag "v" for this sender.');
      process.exit(0);
    }

    console.log(`\n${filteredGuests.length} guest(s) to invite.`);
    console.log('Connecting WhatsApp (scan QR if prompted on server / use admin first)…');
    await initializeWhatsApp(selectedSender);
    await waitForReady(selectedSender, null);

    console.log('\nPress Ctrl+C to cancel, or wait 5 seconds…\n');
    await new Promise((r) => setTimeout(r, 5000));

    const results = { successful: 0, failed: 0 };

    for (const guest of filteredGuests) {
      if (!guest.phoneTo) {
        console.warn(`Skip ${guest.name}: no phone`);
        results.failed++;
        continue;
      }
      const res = await sendWhatsAppInvitation({
        to: guest.phoneTo,
        senderName: selectedSender,
        name: guest.name,
        addons: guest.addons,
      });
      if (res.success) {
        results.successful++;
        console.log(`OK  ${guest.name}`);
      } else {
        results.failed++;
        console.log(`ERR ${guest.name}: ${res.error}`);
      }
    }

    console.log(`\nDone. Sent: ${results.successful}, failed: ${results.failed}`);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

sendInvitations();
