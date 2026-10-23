import { query } from '../db/pool.js';
import { currentAccount } from './accountContext.js';

/** Digits-only phone key for upsert uniqueness within an account. */
export function phoneKey(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function rowToResponse(row) {
  if (!row) return null;
  return {
    phone: row.phone || '',
    phoneKey: row.phone_key || '',
    name: row.name || '',
    isAttending: Boolean(row.is_attending),
    numberOfGuests: Number(row.number_of_guests) || 0,
    numberOfBabies: Number(row.number_of_babies) || 0,
    numberOfVegan: Number(row.number_of_vegan) || 0,
    additionalNotes: row.additional_notes || '',
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ''),
  };
}

/**
 * Upsert an RSVP response for the current (or given) account.
 */
export async function upsertRsvpResponse(input, accountId = currentAccount()?.id) {
  if (!accountId) {
    throw Object.assign(new Error('Account required for RSVP storage'), { status: 500 });
  }
  const key = phoneKey(input.phone);
  if (!key) {
    throw Object.assign(new Error('Phone number is required'), { status: 400 });
  }
  const result = await query(
    `INSERT INTO rsvp_responses (
      account_id, phone_key, phone, name, is_attending,
      number_of_guests, number_of_babies, number_of_vegan, additional_notes, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (account_id, phone_key) DO UPDATE SET
      phone = EXCLUDED.phone,
      name = EXCLUDED.name,
      is_attending = EXCLUDED.is_attending,
      number_of_guests = EXCLUDED.number_of_guests,
      number_of_babies = EXCLUDED.number_of_babies,
      number_of_vegan = EXCLUDED.number_of_vegan,
      additional_notes = EXCLUDED.additional_notes,
      updated_at = NOW()
    RETURNING *`,
    [
      accountId,
      key,
      String(input.phone || '').trim(),
      String(input.name || '').trim(),
      Boolean(input.isAttending),
      Number(input.numberOfGuests) || 0,
      Number(input.numberOfBabies) || 0,
      Number(input.numberOfVegan) || 0,
      String(input.additionalNotes || '').trim(),
    ],
  );
  return rowToResponse(result.rows[0]);
}

export async function listRsvpResponses(accountId = currentAccount()?.id) {
  if (!accountId) return [];
  const result = await query(
    `SELECT * FROM rsvp_responses
     WHERE account_id = $1
     ORDER BY updated_at DESC`,
    [accountId],
  );
  return result.rows.map(rowToResponse);
}
