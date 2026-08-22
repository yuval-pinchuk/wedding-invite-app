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
      rsvpGuestCount: (row[7] || '').toString().trim(),
      rsvpRemarks: (row[12] || '').toString().trim(),
    };
  });
}

/** @param {{ rsvpGuestCount?: string }} guest */
export function hasRsvpResponded(guest) {
  return Boolean((guest.rsvpGuestCount || '').trim());
}

/**
 * Parse stored RSVP columns H + M into structured fields.
 * Column H: "0" = not attending, "2" or "(+1)2" = guests (babies left of adults).
 * Also accepts legacy "2(+1)" / "2(1)".
 * Column M: optional "N טבעוני/צמחוני" + free-text notes.
 * @param {{ rsvpGuestCount?: string, rsvpRemarks?: string }} guest
 * @returns {null | {
 *   isAttending: boolean,
 *   numberOfGuests: number,
 *   numberOfBabies: number,
 *   numberOfVegan: number,
 *   additionalNotes: string,
 * }}
 */
export function parseStoredRsvp(guest) {
  const raw = (guest?.rsvpGuestCount || '').trim();
  if (!raw) return null;

  if (raw === '0') {
    return {
      isAttending: false,
      numberOfGuests: 0,
      numberOfBabies: 0,
      numberOfVegan: 0,
      additionalNotes: '',
    };
  }

  // Prefer "(+1)2" / "(1)2", then legacy "2(+1)" / "2(1)", then plain "2"
  const prefixMatch = raw.match(/^\(\+?(\d+)\)(\d+)$/);
  const suffixMatch = raw.match(/^(\d+)\(\+?(\d+)\)$/);
  const plainMatch = raw.match(/^(\d+)$/);

  let numberOfGuests;
  let numberOfBabies = 0;
  if (prefixMatch) {
    numberOfBabies = parseInt(prefixMatch[1], 10) || 0;
    numberOfGuests = Math.max(1, parseInt(prefixMatch[2], 10) || 1);
  } else if (suffixMatch) {
    numberOfGuests = Math.max(1, parseInt(suffixMatch[1], 10) || 1);
    numberOfBabies = parseInt(suffixMatch[2], 10) || 0;
  } else if (plainMatch) {
    numberOfGuests = Math.max(1, parseInt(plainMatch[1], 10) || 1);
  } else {
    return {
      isAttending: true,
      numberOfGuests: Math.max(1, parseInt(raw, 10) || 1),
      numberOfBabies: 0,
      numberOfVegan: 0,
      additionalNotes: '',
    };
  }

  let numberOfVegan = 0;
  let additionalNotes = '';
  const remarks = (guest?.rsvpRemarks || '').trim();
  if (remarks) {
    const veganMatch = remarks.match(/^(\d+)\s*טבעוני\/צמחוני\s*/);
    if (veganMatch) {
      numberOfVegan = parseInt(veganMatch[1], 10) || 0;
      additionalNotes = remarks.slice(veganMatch[0].length).trim();
    } else {
      additionalNotes = remarks;
    }
  }

  return {
    isAttending: true,
    numberOfGuests,
    numberOfBabies,
    numberOfVegan,
    additionalNotes,
  };
}

/** Guest list worksheet name (must match the Google Sheet tab exactly). */
const GUEST_SHEET_TAB = 'חינה';

/** Response log worksheet name (separate GOOGLE_RESPONSE_SHEET_ID spreadsheet). */
const RESPONSE_SHEET_TAB = 'חתונה';

/** Read wide enough for phone cells placed after column O (API omits trailing empties only). */
const GUEST_SHEET_READ_RANGE = `${GUEST_SHEET_TAB}!A:Z`;

/**
 * Read guest list from Google Sheet with Hebrew columns
 * Column A: First name (Hebrew)
 * Column B: Family name (Hebrew)
 * Column L: Addons (optional, Hebrew name)
 * Column H: RSVP guest count (empty = pending)
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
    const guest = guests.find((g) => phonesMatch(g.phoneTo, phone));

    return guest || null;
  } catch (error) {
    console.error('Error getting guest by phone:', error);
    throw error;
  }
}

function phonesMatch(phoneA, phoneB) {
  const a = normalizePhoneCell(phoneA).replace(/\D/g, '');
  const b = normalizePhoneCell(phoneB).replace(/\D/g, '');
  if (!a || !b) {
    return false;
  }
  return a === b || a.endsWith(b) || b.endsWith(a);
}

function rowContainsPhone(row, phone) {
  const rowPhone = findPhoneNumber(row);
  return rowPhone ? phonesMatch(rowPhone, phone) : false;
}

/**
 * @param {string[][]} rows
 * @param {string} phone
 * @returns {number} Row index in rows array, or -1
 */
function findGuestRowIndexInRows(rows, phone) {
  for (let i = 1; i < rows.length; i++) {
    if (rowContainsPhone(rows[i], phone)) {
      return i;
    }
  }
  return -1;
}

/**
 * @param {string} spreadsheetId
 * @param {string} phone
 * @param {string} [range]
 * @returns {Promise<number>} Row index in rows array, or -1
 */
async function findGuestRowIndexByPhone(spreadsheetId, phone, range = GUEST_SHEET_READ_RANGE) {
  const rows = await fetchSheetRows(spreadsheetId, range);
  return findGuestRowIndexInRows(rows, phone);
}

function formatGuestCountColumn(numberOfGuests, numberOfBabies) {
  if (numberOfBabies > 0) {
    return `(+${numberOfBabies})${numberOfGuests}`;
  }
  return String(numberOfGuests);
}

function formatRemarksColumn(numberOfVegan, additionalNotes) {
  const parts = [];
  if (numberOfVegan > 0) {
    parts.push(`${numberOfVegan} טבעוני/צמחוני`);
  }
  if (additionalNotes) {
    parts.push(additionalNotes);
  }
  return parts.join(' ');
}

/**
 * Write RSVP summary to guest list columns H (guest count) and M (remarks).
 * @param {string} spreadsheetId
 * @param {string} phone
 * @param {{ isAttending: boolean, numberOfGuests: number, numberOfBabies: number, numberOfVegan: number, additionalNotes: string }} rsvp
 */
export async function updateGuestRsvpOnGuestSheet(
  spreadsheetId,
  phone,
  { isAttending, numberOfGuests, numberOfBabies, numberOfVegan, additionalNotes }
) {
  if (!sheets) {
    await configureSheets();
  }

  try {
    const guest = await getGuestByPhone(spreadsheetId, phone);
    if (!guest) {
      const notFound = new Error('Guest not found in guest list');
      notFound.status = 404;
      throw notFound;
    }

    const rowNumber = guest.rowNumber;
    // Not attending → always log "0" in column H (pending = empty, declined = 0)
    const columnH = isAttending === true
      ? formatGuestCountColumn(Number(numberOfGuests) || 0, Number(numberOfBabies) || 0)
      : '0';
    const columnM = isAttending === true
      ? formatRemarksColumn(Number(numberOfVegan) || 0, additionalNotes || '')
      : '';

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: {
        valueInputOption: 'RAW',
        data: [
          { range: `${GUEST_SHEET_TAB}!H${rowNumber}`, values: [[columnH]] },
          { range: `${GUEST_SHEET_TAB}!M${rowNumber}`, values: [[columnM]] },
        ],
      },
    });

    console.log(
      `Updated guest sheet RSVP for phone ${phone} at row ${rowNumber}: H=${columnH} attending=${isAttending === true}`,
    );
    return { success: true, rowNumber };
  } catch (error) {
    console.error('Error updating guest RSVP on guest sheet:', error);

    if (isPermissionError(error)) {
      const email = getServiceAccountEmail();
      const errorMessage = email
        ? `Permission denied. Please share the guest sheet with the service account email: ${email} (Editor permissions required).`
        : 'Permission denied. Please ensure the service account has Editor access to the guest sheet.';
      const permissionError = new Error(errorMessage);
      permissionError.code = 'PERMISSION_DENIED';
      permissionError.serviceAccountEmail = email;
      throw permissionError;
    }

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
    const rowIndex = await findGuestRowIndexByPhone(spreadsheetId, phone, range);
    if (rowIndex === -1) {
      throw new Error('Guest with this phone number not found');
    }

    const rowNumber = rowIndex + 1;

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

const RESPONSE_SHEET_HEADERS = [
  'Name',
  'Phone',
  'RSVP Status',
  'Number of Guests',
  'Babies (0-2)',
  'Vegan/Vegetarian',
  'Additional Notes',
  'Timestamp',
];

/**
 * Write RSVP response to Google Sheet
 * Expected columns: Name, Phone, RSVP Status, Number of Guests, Babies, Vegan/Vegetarian, Additional Notes, Timestamp
 */
export async function saveRSVPResponse(
  spreadsheetId,
  name,
  phone,
  isAttending,
  numberOfGuests,
  numberOfBabies = 0,
  numberOfVegan = 0,
  additionalNotes = '',
  range = `${RESPONSE_SHEET_TAB}!A:H`
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
    const values = [[
      name,
      phone,
      rsvpStatus,
      numberOfGuests.toString(),
      numberOfBabies.toString(),
      numberOfVegan.toString(),
      additionalNotes,
      timestamp,
    ]];

    if (existingRowIndex > 0) {
      // Update existing row
      const rowNumber = existingRowIndex + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${RESPONSE_SHEET_TAB}!A${rowNumber}:H${rowNumber}`,
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
export async function initializeResponseSheet(spreadsheetId) {
  if (!sheets) {
    await configureSheets();
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${RESPONSE_SHEET_TAB}!A1:H1`,
    });

    const existingHeaders = response.data.values?.[0] || [];

    if (existingHeaders.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${RESPONSE_SHEET_TAB}!A1:H1`,
        valueInputOption: 'RAW',
        resource: {
          values: [RESPONSE_SHEET_HEADERS],
        },
      });
      console.log('Initialized response sheet headers');
    } else if (existingHeaders.length < RESPONSE_SHEET_HEADERS.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${RESPONSE_SHEET_TAB}!A1:H1`,
        valueInputOption: 'RAW',
        resource: {
          values: [RESPONSE_SHEET_HEADERS],
        },
      });
      console.log('Migrated response sheet headers to include new columns');
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

