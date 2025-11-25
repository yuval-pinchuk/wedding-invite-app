import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

let sheets = null;
let auth = null;
let serviceAccountEmail = null;

/**
 * Get the service account email for sharing sheets
 */
export function getServiceAccountEmail() {
  if (serviceAccountEmail) {
    return serviceAccountEmail;
  }

  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      // Service account authentication
      const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      const serviceAccountKey = JSON.parse(fs.readFileSync(keyPath, "utf8"));
      serviceAccountEmail = serviceAccountKey.client_email;
    } else if (process.env.GOOGLE_CLIENT_EMAIL) {
      serviceAccountEmail = process.env.GOOGLE_CLIENT_EMAIL;
    }
  } catch (error) {
    console.warn('Could not retrieve service account email:', error.message);
  }

  return serviceAccountEmail;
}

/**
 * Check if an error is a permission error
 */
function isPermissionError(error) {
  const errorMessage = error.message || String(error);
  const errorCode = error.code;
  
  return (
    errorCode === 403 ||
    errorMessage.includes('PERMISSION_DENIED') ||
    errorMessage.includes('permission denied') ||
    errorMessage.includes('insufficient permissions') ||
    errorMessage.includes('does not have permission')
  );
}

/**
 * Configure Google Sheets API authentication
 */
export async function configureSheets() {
  try {
    // Support both service account and OAuth2
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      // Service account authentication
      const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      const serviceAccountKey = JSON.parse(fs.readFileSync(keyPath, "utf8"));
      serviceAccountEmail = serviceAccountKey.client_email;
      auth = new google.auth.GoogleAuth({
        credentials: serviceAccountKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
      // Service account using individual env vars
      serviceAccountEmail = process.env.GOOGLE_CLIENT_EMAIL;
      auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
          private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else {
      throw new Error('Google Sheets credentials not configured. Please set GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY');
    }

    sheets = google.sheets({ version: 'v4', auth });
    console.log('Google Sheets API configured successfully');
  } catch (error) {
    console.error('Error configuring Google Sheets:', error);
    throw error;
  }
}

/**
 * Read guest list from Google Sheet with Hebrew columns
 * Column A: First name (Hebrew)
 * Column L: Addons (optional, Hebrew name)
 * Column N: לשלוח אישורי הגעה (Send confirmation - filter by "v")
 * Column O: Sender (Hebrew name - filter by selected sender)
 * Phone number: Will be detected from columns (typically in a phone column)
 */
export async function getGuestList(spreadsheetId, range = 'חתונה!A:O') {
  if (!sheets) {
    await configureSheets();
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values || [];
    
    if (rows.length === 0) {
      return [];
    }

    // Map rows to objects (column indices: A=0, L=11, N=13, O=14)
    const guests = rows.slice(1).map((row, index) => {
      return {
        rowNumber: index + 2, // +2 because we skip header and arrays are 0-indexed
        name: row[0] || '', // Column A - First name
        addons: row[11] || '', // Column L - Addons (optional)
        sendConfirmation: (row[13] || '').toString().toLowerCase().trim(), // Column N - לשלוח אישורי הגעה
        sender: row[14] || '', // Column O - Sender
        phoneTo: findPhoneNumber(row), // Detect phone number from row
      };
    }).filter(guest => guest.name && guest.phoneTo); // Filter out empty rows

    return guests;
  } catch (error) {
    console.error('Error reading guest list:', error);
    throw error;
  }
}

/**
 * Find phone number in a row (typically in columns with phone-like patterns)
 * Looks for columns that match phone number patterns
 */
function findPhoneNumber(row) {
  // Common phone number columns might be in different positions
  // Try to find a column that looks like a phone number
  for (let i = 0; i < row.length; i++) {
    const cell = (row[i] || '').toString().trim();
    // Check if it looks like a phone number (contains digits, might have +, -, spaces, etc.)
    const phonePattern = /[\d\s\-\+\(\)]{8,}/;
    if (phonePattern.test(cell) && cell.replace(/[\s\-\+\(\)]/g, '').length >= 8) {
      return cell;
    }
  }
  return '';
}

/**
 * Get unique senders from the guest list (Column O)
 */
export async function getSenders(spreadsheetId, range = 'חתונה!A:O') {
  const guests = await getGuestList(spreadsheetId, range);
  const senders = [...new Set(guests.map(g => g.sender).filter(s => s && s.trim()))];
  return senders;
}

/**
 * Get guest information by phone number
 */
export async function getGuestByPhone(spreadsheetId, phone, range = 'חתונה!A:O') {
  if (!sheets) {
    await configureSheets();
  }

  try {
    const guests = await getGuestList(spreadsheetId, range);
    // Normalize phone for comparison (remove spaces, dashes, etc.)
    const normalizedPhone = phone.replace(/[\s\-\+\(\)]/g, '');
    
    const guest = guests.find(g => {
      const guestPhone = (g.phoneTo || '').replace(/[\s\-\+\(\)]/g, '');
      return guestPhone === normalizedPhone || guestPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(guestPhone);
    });

    return guest || null;
  } catch (error) {
    console.error('Error getting guest by phone:', error);
    throw error;
  }
}

/**
 * Update send confirmation status for a guest (remove from send list)
 */
export async function updateSendConfirmation(spreadsheetId, phone, shouldSend = false, range = 'חתונה!A:O') {
  if (!sheets) {
    await configureSheets();
  }

  try {
    // Get all rows to find the one to update
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values || [];
    if (rows.length === 0) {
      throw new Error('No data found in sheet');
    }

    // Find the row with matching phone number
    const normalizedPhone = phone.replace(/[\s\-\+\(\)]/g, '');
    let rowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Check all columns for phone number
      for (let j = 0; j < row.length; j++) {
        const cell = (row[j] || '').toString().trim();
        const cellPhone = cell.replace(/[\s\-\+\(\)]/g, '');
        if (cellPhone === normalizedPhone || cellPhone.endsWith(normalizedPhone) || normalizedPhone.endsWith(cellPhone)) {
          rowIndex = i;
          break;
        }
      }
      if (rowIndex !== -1) break;
    }

    if (rowIndex === -1) {
      throw new Error('Guest with this phone number not found');
    }

    // Column N is index 13 (0-based), but we need to update it
    // Update the send confirmation column (N = column 14 in 1-based, index 13 in 0-based)
    const columnN = 13; // 0-based index for column N
    const rowNumber = rowIndex + 1; // 1-based row number
    
    // Update the cell
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `חתונה!N${rowNumber}`,
      valueInputOption: 'RAW',
      resource: {
        values: [[shouldSend ? 'v' : '']],
      },
    });

    return { success: true, rowNumber };
  } catch (error) {
    console.error('Error updating send confirmation:', error);
    throw error;
  }
}

/**
 * Filter guests by sender and send confirmation status
 * @param {Array} guests - Array of guest objects
 * @param {string} senderName - Name of sender to filter by (Hebrew)
 * @returns {Array} Filtered guests
 */
export function filterGuestsBySender(guests, senderName) {
  return guests.filter(guest => {
    // Filter by sender
    const matchesSender = guest.sender && guest.sender.trim() === senderName.trim();
    // Filter by send confirmation (column N must have "v")
    const shouldSend = guest.sendConfirmation === 'v' || guest.sendConfirmation === 'V';
    return matchesSender && shouldSend;
  });
}

/**
 * Write RSVP response to Google Sheet
 * Expected columns: Name, Phone, RSVP Status, Number of Guests, Timestamp
 */
export async function saveRSVPResponse(
  spreadsheetId,
  name,
  phone,
  isAttending,
  numberOfGuests,
  range = 'חתונה!A:E'
) {
  if (!sheets) {
    await configureSheets();
  }

  try {
    // First, check if this phone number already has a response
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = existing.data.values || [];
    const phoneColumnIndex = 1; // Assuming phone is in column B
    const existingRowIndex = rows.findIndex((row, index) => {
      if (index === 0) return false; // Skip header
      return row[phoneColumnIndex] === phone;
    });

    const timestamp = new Date().toISOString();
    const rsvpStatus = isAttending ? 'Yes' : 'No';
    const values = [[name, phone, rsvpStatus, numberOfGuests.toString(), timestamp]];

    if (existingRowIndex > 0) {
      // Update existing row
      const rowNumber = existingRowIndex + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `חתונה!A${rowNumber}:E${rowNumber}`,
        valueInputOption: 'RAW',
        resource: {
          values,
        },
      });
      console.log(`Updated RSVP for ${name} at row ${rowNumber}`);
    } else {
      // Append new row
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values,
        },
      });
      console.log(`Added new RSVP for ${name}`);
    }

    return { success: true };
  } catch (error) {
    console.error('Error saving RSVP response:', error);
    
    // Check if it's a permission error
    if (isPermissionError(error)) {
      const email = getServiceAccountEmail();
      const errorMessage = email 
        ? `Permission denied. Please share the response sheet with the service account email: ${email} (Editor permissions required).`
        : 'Permission denied. Please ensure the service account has Editor access to the response sheet.';
      const permissionError = new Error(errorMessage);
      permissionError.code = 'PERMISSION_DENIED';
      permissionError.serviceAccountEmail = email;
      throw permissionError;
    }
    
    throw error;
  }
}

/**
 * Initialize headers in the responses sheet if they don't exist
 */
export async function initializeResponseSheet(spreadsheetId, range = 'חתונה!A1:E1') {
  if (!sheets) {
    await configureSheets();
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'חתונה!A1:E1',
    });

    if (!response.data.values || response.data.values.length === 0) {
      // Add headers
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'חתונה!A1:E1',
        valueInputOption: 'RAW',
        resource: {
          values: [['Name', 'Phone', 'RSVP Status', 'Number of Guests', 'Timestamp']],
        },
      });
      console.log('Initialized response sheet headers');
    }
  } catch (error) {
    console.error('Error initializing response sheet:', error);
    
    // Check if it's a permission error
    if (isPermissionError(error)) {
      const email = getServiceAccountEmail();
      const errorMessage = email 
        ? `Permission denied. Please share the response sheet with the service account email: ${email} (Editor permissions required).`
        : 'Permission denied. Please ensure the service account has Editor access to the response sheet.';
      const permissionError = new Error(errorMessage);
      permissionError.code = 'PERMISSION_DENIED';
      permissionError.serviceAccountEmail = email;
      throw permissionError;
    }
    
    throw error;
  }
}

