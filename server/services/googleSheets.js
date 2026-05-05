import { google } from 'googleapis';

let sheets = null;
let auth = null;
let serviceAccountEmail = null;

/**
 * Get service account key from environment
 */
function getServiceAccountKey() {
  try {
    const keyFromFile = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    if (keyFromFile) {
      return keyFromFile;
    }
    return null;
  } catch (error) {
    console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY as JSON');
    console.error('Error:', error.message);
    const jsonString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '';
    console.error('First 200 chars of value:', jsonString.substring(0, 200));
    throw new Error(`Invalid JSON in GOOGLE_SERVICE_ACCOUNT_KEY: ${error.message}`);
  }
}

/**
 * Get the service account email for sharing sheets
 */
export function getServiceAccountEmail() {
  if (serviceAccountEmail) {
    return serviceAccountEmail;
  }

  try {
    const serviceAccountKey = getServiceAccountKey();
    if (serviceAccountKey) {
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
    const serviceAccountKey = getServiceAccountKey();
    if (serviceAccountKey) {
      // Service account authentication - read from .env file (supports multi-line JSON)
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
 * @param {string} spreadsheetId
 * @param {string} range
 * @returns {Promise<string[][]>}
 */
async function fetchSheetRows(spreadsheetId, range) {
  if (!sheets) {
    await configureSheets();
  }
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  return response.data.values || [];
}

/**
 * Map data rows (excluding header) to guest objects; does not filter by name/phone.
 * @param {string[][]} rows full sheet including row 0 = header
 */
function mapDataRowsToGuests(rows) {
  if (rows.length <= 1) {
    return [];
  }
  return rows.slice(1).map((row, index) => {
    const firstName = (row[0] || '').trim();
    const familyName = (row[1] || '').trim();
    const fullName = [firstName, familyName].filter((n) => n).join(' ').trim();
    return {
      rowNumber: index + 2,
      name: firstName,
      fullName: fullName || firstName,
      addons: row[11] || '',
      sendConfirmation: (row[13] || '').toString().toLowerCase().trim(),
      sender: row[14] || '',
      phoneTo: findPhoneNumber(row),
    };
  });
}

/** Guest list worksheet name (must match the Google Sheet tab exactly). */
const GUEST_SHEET_TAB = 'חתונה';

/** Read wide enough for phone cells placed after column O (API omits trailing empties only). */
const GUEST_SHEET_READ_RANGE = `${GUEST_SHEET_TAB}!A:Z`;

/**
 * Read guest list from Google Sheet with Hebrew columns
 * Column A: First name (Hebrew)
 * Column B: Family name (Hebrew)
 * Column L: Addons (optional, Hebrew name)
 * Column N: לשלוח אישורי הגעה (Send confirmation - filter by "v")
 * Column O: Sender (Hebrew name - filter by selected sender)
 * Phone number: detected by scanning the row (often in a column after O)
 */
export async function getGuestList(spreadsheetId, range = GUEST_SHEET_READ_RANGE) {
  try {
    const rows = await fetchSheetRows(spreadsheetId, range);
    if (rows.length === 0) {
      return [];
    }
    const mapped = mapDataRowsToGuests(rows);
    return mapped.filter((guest) => guest.name && guest.phoneTo);
  } catch (error) {
    console.error('Error reading guest list:', error);
    throw error;
  }
}

/**
 * Normalize pasted phone cells: bidi marks, soft hyphen, and Unicode dashes
 * (U+2010–U+2015, minus sign, fullwidth hyphen, etc.) → ASCII hyphen for /[\d\s\-\+\(\)]{8,}/.
 */
function normalizePhoneCell(raw) {
  return String(raw ?? '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\u00AD/g, '')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .trim();
}

/**
 * Find phone number in a row (typically in columns with phone-like patterns)
 * Looks for columns that match phone number patterns
 */
function findPhoneNumber(row) {
  const phonePattern = /[\d\s\-\+\(\)]{8,}/;
  for (let i = 0; i < row.length; i++) {
    const cell = normalizePhoneCell((row[i] || '').toString());
    const digitsOnlyLen = cell.replace(/\D/g, '').length;
    if (digitsOnlyLen >= 8 && phonePattern.test(cell)) {
      return cell;
    }
  }
  return '';
}

/**
 * Unique senders from column O on every data row.
 * (Do not derive from getGuestList: that drops rows without name+phone, which would hide senders.)
 */
export async function getSenders(spreadsheetId, range = GUEST_SHEET_READ_RANGE) {
  const rows = await fetchSheetRows(spreadsheetId, range);
  if (rows.length <= 1) {
    return [];
  }

  const seen = new Set();
  const ordered = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const raw = row[14];
    const s = (raw !== undefined && raw !== null ? String(raw) : '').trim();
    if (!s) {
      continue;
    }
    if (seen.has(s)) {
      continue;
    }
    seen.add(s);
    ordered.push(s);
  }

  return ordered;
}

/**
 * Get guest information by phone number
 */
export async function getGuestByPhone(spreadsheetId, phone, range = GUEST_SHEET_READ_RANGE) {
  if (!sheets) {
    await configureSheets();
  }

  try {
    const guests = await getGuestList(spreadsheetId, range);
    const normalizedPhone = normalizePhoneCell(phone).replace(/\D/g, '');

    const guest = guests.find((g) => {
      const guestPhone = normalizePhoneCell(g.phoneTo || '').replace(/\D/g, '');
      return (
        guestPhone === normalizedPhone ||
        guestPhone.endsWith(normalizedPhone) ||
        normalizedPhone.endsWith(guestPhone)
      );
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
export async function updateSendConfirmation(spreadsheetId, phone, shouldSend = false, range = GUEST_SHEET_READ_RANGE) {
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
    const normalizedPhone = normalizePhoneCell(phone).replace(/\D/g, '');
    let rowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Check all columns for phone number
      for (let j = 0; j < row.length; j++) {
        const cell = normalizePhoneCell((row[j] || '').toString());
        const cellPhone = cell.replace(/\D/g, '');
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
      range: `${GUEST_SHEET_TAB}!N${rowNumber}`,
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
  range = `${GUEST_SHEET_TAB}!A:E`
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
        range: `${GUEST_SHEET_TAB}!A${rowNumber}:E${rowNumber}`,
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
export async function initializeResponseSheet(spreadsheetId, range = `${GUEST_SHEET_TAB}!A1:E1`) {
  if (!sheets) {
    await configureSheets();
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${GUEST_SHEET_TAB}!A1:E1`,
    });

    if (!response.data.values || response.data.values.length === 0) {
      // Add headers
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${GUEST_SHEET_TAB}!A1:E1`,
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

