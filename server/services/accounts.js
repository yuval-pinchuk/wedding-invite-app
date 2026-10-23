import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';
import { getDataDir } from '../config/dataDir.js';
import { query } from '../db/pool.js';

const scrypt = promisify(scryptCb);
const MAX_FAILURES = 5;
const CODE_TTL_MS = 15 * 60 * 1000;
const RESET_CODE_TTL_MS = 15 * 60 * 1000;

function invitesDir() {
  const dir = path.join(getDataDir(), 'invites');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rowToAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicToken: row.public_token,
    email: row.email,
    passwordHash: row.password_hash,
    failedLogins: Number(row.failed_logins) || 0,
    locked: Boolean(row.locked),
    unlockCodeHash: row.unlock_code_hash || '',
    unlockCodeExpires: Number(row.unlock_code_expires) || 0,
    resetTokenHash: row.reset_token_hash || '',
    resetTokenExpires: Number(row.reset_token_expires) || 0,
    legacy: Boolean(row.legacy),
    brideName: row.bride_name || '',
    groomName: row.groom_name || '',
    weddingDate: row.wedding_date || '',
    wazeUrl: row.waze_url || '',
    mapsUrl: row.maps_url || '',
    guestSheetId: row.guest_sheet_id || '',
    responseSheetId: row.response_sheet_id || '',
    sheetTab: row.sheet_tab || 'חתונה',
    columnMap: row.column_map && typeof row.column_map === 'object' ? row.column_map : {},
    invitationMessage: row.invitation_message || '',
    reminderTemplate: row.reminder_template || '',
    inviteImageFile: row.invite_image_file || '',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
  };
}

export function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    publicToken: account.publicToken,
    legacy: Boolean(account.legacy),
    brideName: account.brideName || '',
    groomName: account.groomName || '',
    weddingDate: account.weddingDate || '',
    wazeUrl: account.wazeUrl || '',
    mapsUrl: account.mapsUrl || '',
    guestSheetId: account.guestSheetId || '',
    responseSheetId: account.responseSheetId || '',
    sheetTab: account.sheetTab || 'חתונה',
    columnMap: account.columnMap || {},
    invitationMessage: account.invitationMessage || '',
    reminderTemplate: account.reminderTemplate || '',
    locked: Boolean(account.locked),
    hasInviteImage: Boolean(account.inviteImageFile),
  };
}

export async function listAccounts() {
  const result = await query('SELECT * FROM accounts ORDER BY created_at ASC');
  return result.rows.map(rowToAccount);
}

export async function findAccountById(id) {
  if (!id) return null;
  const result = await query('SELECT * FROM accounts WHERE id = $1 LIMIT 1', [id]);
  return rowToAccount(result.rows[0]);
}

export async function findAccountByEmail(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  const result = await query('SELECT * FROM accounts WHERE email = $1 LIMIT 1', [key]);
  return rowToAccount(result.rows[0]);
}

export async function findByPublicToken(token) {
  const key = String(token || '').trim();
  if (!key) return null;
  const result = await query('SELECT * FROM accounts WHERE public_token = $1 LIMIT 1', [key]);
  return rowToAccount(result.rows[0]);
}

const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d]{6,}$/;
const PASSWORD_ERROR = 'הסיסמה חייבת להיות באנגלית, לפחות 6 תווים, ולכלול אות גדולה, אות קטנה ומספר';

export function assertPassword(password) {
  if (!PASSWORD_PATTERN.test(String(password || ''))) {
    throw Object.assign(new Error(PASSWORD_ERROR), { status: 400 });
  }
}

function assertWeddingDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error('יש לבחור תאריך חתונה'), { status: 400 });
  }
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (value < iso) {
    throw Object.assign(new Error('תאריך החתונה לא יכול להיות בעבר'), { status: 400 });
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 32)).toString('hex');
  return `${salt}:${hash}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const next = await scrypt(password, salt, 32);
  const prev = Buffer.from(hash, 'hex');
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

function hashToken(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export async function saveAccount(next) {
  await query(
    `INSERT INTO accounts (
      id, email, public_token, password_hash, failed_logins, locked,
      unlock_code_hash, unlock_code_expires, reset_token_hash, reset_token_expires,
      legacy, bride_name, groom_name, wedding_date, waze_url, maps_url,
      guest_sheet_id, response_sheet_id, sheet_tab, column_map,
      invitation_message, reminder_template, invite_image_file, created_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24
    )
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      public_token = EXCLUDED.public_token,
      password_hash = EXCLUDED.password_hash,
      failed_logins = EXCLUDED.failed_logins,
      locked = EXCLUDED.locked,
      unlock_code_hash = EXCLUDED.unlock_code_hash,
      unlock_code_expires = EXCLUDED.unlock_code_expires,
      reset_token_hash = EXCLUDED.reset_token_hash,
      reset_token_expires = EXCLUDED.reset_token_expires,
      legacy = EXCLUDED.legacy,
      bride_name = EXCLUDED.bride_name,
      groom_name = EXCLUDED.groom_name,
      wedding_date = EXCLUDED.wedding_date,
      waze_url = EXCLUDED.waze_url,
      maps_url = EXCLUDED.maps_url,
      guest_sheet_id = EXCLUDED.guest_sheet_id,
      response_sheet_id = EXCLUDED.response_sheet_id,
      sheet_tab = EXCLUDED.sheet_tab,
      column_map = EXCLUDED.column_map,
      invitation_message = EXCLUDED.invitation_message,
      reminder_template = EXCLUDED.reminder_template,
      invite_image_file = EXCLUDED.invite_image_file`,
    [
      next.id,
      next.email,
      next.publicToken,
      next.passwordHash,
      next.failedLogins || 0,
      Boolean(next.locked),
      next.unlockCodeHash || '',
      next.unlockCodeExpires || 0,
      next.resetTokenHash || '',
      next.resetTokenExpires || 0,
      Boolean(next.legacy),
      next.brideName || '',
      next.groomName || '',
      next.weddingDate || '',
      next.wazeUrl || '',
      next.mapsUrl || '',
      next.guestSheetId || '',
      next.responseSheetId || '',
      next.sheetTab || '',
      JSON.stringify(next.columnMap || {}),
      next.invitationMessage || '',
      next.reminderTemplate || '',
      next.inviteImageFile || '',
      next.createdAt || new Date().toISOString(),
    ],
  );
  return next;
}

export function inviteImagePath(account) {
  if (!account?.inviteImageFile) return '';
  return path.join(invitesDir(), account.inviteImageFile);
}

function saveInviteImage(accountId, dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return '';
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    throw Object.assign(new Error('התמונה חייבת להיות עד 5MB'), { status: 400 });
  }
  const ext = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg';
  const filename = `${accountId}.${ext}`;
  fs.writeFileSync(path.join(invitesDir(), filename), buffer);
  return filename;
}

export async function createAccount(input) {
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  if (!email || !email.includes('@')) {
    throw Object.assign(new Error('יש להזין אימייל תקין'), { status: 400 });
  }
  assertPassword(password);
  if (await findAccountByEmail(email)) {
    throw Object.assign(new Error('כבר קיים חשבון עם האימייל הזה'), { status: 409 });
  }
  const brideName = String(input.brideName || '').trim();
  const groomName = String(input.groomName || '').trim();
  const weddingDate = String(input.weddingDate || '').trim();
  const guestSheetId = String(input.guestSheetId || '').trim();
  const responseSheetId = String(input.responseSheetId || '').trim();
  const sheetTab = String(input.sheetTab || '').trim();
  if (!brideName || !groomName || !weddingDate || !guestSheetId || !responseSheetId || !sheetTab) {
    throw Object.assign(new Error('יש למלא את כל פרטי החתונה והגיליונות'), { status: 400 });
  }
  assertWeddingDate(weddingDate);

  const id = randomUUID();
  let inviteImageFile = '';
  if (input.inviteImageDataUrl) {
    inviteImageFile = saveInviteImage(id, input.inviteImageDataUrl);
  }
  if (!inviteImageFile) {
    throw Object.assign(new Error('יש להעלות תמונת הזמנה'), { status: 400 });
  }

  const account = {
    id,
    publicToken: randomBytes(18).toString('hex'),
    email,
    passwordHash: await hashPassword(password),
    failedLogins: 0,
    locked: false,
    unlockCodeHash: '',
    unlockCodeExpires: 0,
    resetTokenHash: '',
    resetTokenExpires: 0,
    legacy: false,
    brideName,
    groomName,
    weddingDate,
    wazeUrl: String(input.wazeUrl || '').trim(),
    mapsUrl: String(input.mapsUrl || '').trim(),
    guestSheetId,
    responseSheetId,
    sheetTab,
    columnMap: input.columnMap || {},
    invitationMessage: String(input.invitationMessage || '').trim(),
    reminderTemplate: String(input.reminderTemplate || '').trim(),
    inviteImageFile,
    paymentSeed: {
      daniellePaybox: String(input.daniellePaybox || '').trim(),
      yuvalPaybox: String(input.yuvalPaybox || '').trim(),
      danielleBit: String(input.danielleBit || '').trim(),
      yuvalBit: String(input.yuvalBit || '').trim(),
    },
    createdAt: new Date().toISOString(),
  };
  await saveAccount(account);
  return account;
}

export async function updateAccount(id, patch) {
  const account = await findAccountById(id);
  if (!account) return null;
  const next = { ...account, ...patch, id: account.id, email: account.email };
  await saveAccount(next);
  return next;
}

export async function recordFailedLogin(account) {
  const failedLogins = (account.failedLogins || 0) + 1;
  const locked = failedLogins >= MAX_FAILURES;
  let unlockCode = '';
  const next = { ...account, failedLogins, locked };
  if (locked) {
    unlockCode = String(Math.floor(100000 + Math.random() * 900000));
    next.unlockCodeHash = hashToken(unlockCode);
    next.unlockCodeExpires = Date.now() + CODE_TTL_MS;
  }
  await saveAccount(next);
  return { account: next, unlockCode, locked };
}

export async function clearLoginFailures(account) {
  await saveAccount({ ...account, failedLogins: 0, locked: false, unlockCodeHash: '', unlockCodeExpires: 0 });
}

export async function issueUnlockCode(account) {
  const unlockCode = String(Math.floor(100000 + Math.random() * 900000));
  const next = {
    ...account,
    locked: true,
    unlockCodeHash: hashToken(unlockCode),
    unlockCodeExpires: Date.now() + CODE_TTL_MS,
  };
  await saveAccount(next);
  return unlockCode;
}

export async function unlockWithCode(email, code) {
  const account = await findAccountByEmail(email);
  if (!account || !account.locked) return { ok: false, error: 'החשבון אינו נעול' };
  if (!account.unlockCodeExpires || Date.now() > account.unlockCodeExpires) {
    return { ok: false, error: 'פג תוקף הקוד. בקשו קוד חדש בהתחברות.' };
  }
  if (hashToken(String(code || '').trim()) !== account.unlockCodeHash) {
    return { ok: false, error: 'הקוד שגוי' };
  }
  await clearLoginFailures(account);
  return { ok: true };
}

/** Issue a 6-digit reset code (15 minutes). Replaces any previous code. */
export async function issueResetCode(account) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await saveAccount({
    ...account,
    resetTokenHash: hashToken(code),
    resetTokenExpires: Date.now() + RESET_CODE_TTL_MS,
  });
  return code;
}

async function findAccountWithValidResetCode(email, code) {
  const account = await findAccountByEmail(email);
  if (!account || !account.resetTokenHash || !account.resetTokenExpires || Date.now() > account.resetTokenExpires) {
    return { ok: false, error: 'פג תוקף הקוד. בקשו קוד חדש.', account: null };
  }
  if (hashToken(String(code || '').trim()) !== account.resetTokenHash) {
    return { ok: false, error: 'הקוד שגוי', account: null };
  }
  return { ok: true, error: '', account };
}

export async function verifyResetCode(email, code) {
  const result = await findAccountWithValidResetCode(email, code);
  return { ok: result.ok, error: result.error };
}

export async function resetPassword(email, code, password) {
  assertPassword(password);
  const result = await findAccountWithValidResetCode(email, code);
  if (!result.ok) {
    throw Object.assign(new Error(result.error), { status: 400 });
  }
  await saveAccount({
    ...result.account,
    passwordHash: await hashPassword(password),
    resetTokenHash: '',
    resetTokenExpires: 0,
    failedLogins: 0,
    locked: false,
    unlockCodeHash: '',
    unlockCodeExpires: 0,
  });
}
