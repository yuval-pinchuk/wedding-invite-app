/**
 * Load `.env` from the repository root regardless of process.cwd() (fixes wrong sheet ID when
 * the server is started from another directory).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: envPath });

function stripEnvQuotes(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

/** Guest list spreadsheet ID (strips accidental quotes from .env). */
export function envGuestSheetId() {
  return stripEnvQuotes(process.env.GOOGLE_GUEST_SHEET_ID);
}

/** RSVP / response spreadsheet ID. */
export function envResponseSheetId() {
  return stripEnvQuotes(process.env.GOOGLE_RESPONSE_SHEET_ID);
}
