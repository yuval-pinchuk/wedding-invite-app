import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

let sheets = null;
let auth = null;

/**
 * Configure Google Sheets API authentication
 */
export async function configureSheets() {
  try {
    // Support both service account and OAuth2
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      // Service account authentication
      const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      auth = new google.auth.GoogleAuth({
        credentials: serviceAccountKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
      // Service account using individual env vars
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
 * Read guest list from Google Sheet
 * Expected columns: Name, PhoneTo, PhoneFrom
 */
export async function getGuestList(spreadsheetId, range = 'Sheet1!A:C') {
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

    // Skip header row and map to objects
    const guests = rows.slice(1).map((row, index) => {
      return {
        rowNumber: index + 2, // +2 because we skip header and arrays are 0-indexed
        name: row[0] || '',
        phoneTo: row[1] || '',
        phoneFrom: row[2] || '',
      };
    }).filter(guest => guest.name && guest.phoneTo); // Filter out empty rows

    return guests;
  } catch (error) {
    console.error('Error reading guest list:', error);
    throw error;
  }
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
  range = 'Sheet1!A:E'
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
        range: `Sheet1!A${rowNumber}:E${rowNumber}`,
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
    throw error;
  }
}

/**
 * Initialize headers in the responses sheet if they don't exist
 */
export async function initializeResponseSheet(spreadsheetId, range = 'Sheet1!A1:E1') {
  if (!sheets) {
    await configureSheets();
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A1:E1',
    });

    if (!response.data.values || response.data.values.length === 0) {
      // Add headers
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'Sheet1!A1:E1',
        valueInputOption: 'RAW',
        resource: {
          values: [['Name', 'Phone', 'RSVP Status', 'Number of Guests', 'Timestamp']],
        },
      });
      console.log('Initialized response sheet headers');
    }
  } catch (error) {
    console.error('Error initializing response sheet:', error);
    throw error;
  }
}

