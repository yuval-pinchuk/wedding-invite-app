import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';
import { getDataDir } from '../config/dataDir.js';
import { envGuestSheetId, envResponseSheetId } from '../config/loadEnv.js';
import { getServiceAccountEmail } from './googleSheets.js';
import { seedPaymentFile } from './paymentRouting.js';

const scrypt = promisify(scryptCb);
const MAX_FAILURES = 5;
const CODE_TTL_MS = 15 * 60 * 1000;
const RESET_CODE_TTL_MS = 15 * 60 * 1000;

function accountsPath() {
  return path.join(getDataDir(), 'accounts.json');
}

function invitesDir() {
  const dir = path.join(getDataDir(), 'invites');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readDb() {
  const file = accountsPath();
  if (!fs.existsSync(file)) return { accounts: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] };
  } catch (error) {
    console.error('[accounts] failed to read store', error);
    return { accounts: [] };
  }
}

function writeDb(db) {
  const file = accountsPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, file);
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

export function listAccounts() {
  return readDb().accounts;
}

export function findAccountById(id) {
  return listAccounts().find((account) => account.id === id) || null;
}

export function findAccountByEmail(email) {
  const key = String(email || '').trim().toLowerCase();
  return listAccounts().find((account) => account.email === key) || null;
}

export function findByPublicToken(token) {
  const key = String(token || '').trim();
  if (!key) return null;
  return listAccounts().find((account) => account.publicToken === key) || null;
}

export function findLegacyAccount() {
  return listAccounts().find((account) => account.legacy) || listAccounts()[0] || null;
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

function saveAccount(next) {
  const db = readDb();
  const index = db.accounts.findIndex((account) => account.id === next.id);
  if (index === -1) db.accounts.push(next);
  else db.accounts[index] = next;
  writeDb(db);
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
  if (!buffer.length || buffer.length > 3 * 1024 * 1024) {
    throw Object.assign(new Error('התמונה חייבת להיות עד 3MB'), { status: 400 });
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
  if (findAccountByEmail(email)) {
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
  saveAccount(account);
  return account;
}

export function updateAccount(id, patch) {
  const account = findAccountById(id);
  if (!account) return null;
  const next = { ...account, ...patch, id: account.id, email: account.email };
  saveAccount(next);
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
  saveAccount(next);
  return { account: next, unlockCode, locked };
}

export function clearLoginFailures(account) {
  saveAccount({ ...account, failedLogins: 0, locked: false, unlockCodeHash: '', unlockCodeExpires: 0 });
}

export function issueUnlockCode(account) {
  const unlockCode = String(Math.floor(100000 + Math.random() * 900000));
  const next = {
    ...account,
    locked: true,
    unlockCodeHash: hashToken(unlockCode),
    unlockCodeExpires: Date.now() + CODE_TTL_MS,
  };
  saveAccount(next);
  return unlockCode;
}

export function unlockWithCode(email, code) {
  const account = findAccountByEmail(email);
  if (!account || !account.locked) return { ok: false, error: 'החשבון אינו נעול' };
  if (!account.unlockCodeExpires || Date.now() > account.unlockCodeExpires) {
    return { ok: false, error: 'פג תוקף הקוד. בקשו קוד חדש בהתחברות.' };
  }
  if (hashToken(String(code || '').trim()) !== account.unlockCodeHash) {
    return { ok: false, error: 'הקוד שגוי' };
  }
  clearLoginFailures(account);
  return { ok: true };
}

/** Issue a 6-digit reset code (15 minutes). Replaces any previous code. */
export function issueResetCode(account) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  saveAccount({
    ...account,
    resetTokenHash: hashToken(code),
    resetTokenExpires: Date.now() + RESET_CODE_TTL_MS,
  });
  return code;
}

function findAccountWithValidResetCode(email, code) {
  const account = findAccountByEmail(email);
  if (!account || !account.resetTokenHash || !account.resetTokenExpires || Date.now() > account.resetTokenExpires) {
    return { ok: false, error: 'פג תוקף הקוד. בקשו קוד חדש.', account: null };
  }
  if (hashToken(String(code || '').trim()) !== account.resetTokenHash) {
    return { ok: false, error: 'הקוד שגוי', account: null };
  }
  return { ok: true, error: '', account };
}

export function verifyResetCode(email, code) {
  const result = findAccountWithValidResetCode(email, code);
  return { ok: result.ok, error: result.error };
}

export async function resetPassword(email, code, password) {
  assertPassword(password);
  const result = findAccountWithValidResetCode(email, code);
  if (!result.ok) {
    throw Object.assign(new Error(result.error), { status: 400 });
  }
  saveAccount({
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

function copyLegacyImage(accountId) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = [
    path.join(repoRoot, 'WEDDING.png'),
    path.join(repoRoot, 'public', 'WEDDING.png'),
  ];
  const found = files.find((file) => fs.existsSync(file));
  if (!found) return '';
  const filename = `${accountId}.png`;
  fs.copyFileSync(found, path.join(invitesDir(), filename));
  return filename;
}

/**
 * First boot: keep the existing wedding as a legacy account so old `/?phone=` links still open it.
 */
export async function ensureLegacyAccount() {
  if (listAccounts().length) return;
  const guestSheetId = envGuestSheetId();
  const responseSheetId = envResponseSheetId();
  if (!guestSheetId) {
    console.warn('[accounts] no accounts and no GOOGLE_GUEST_SHEET_ID; signup will create the first wedding');
    return;
  }
  const id = randomUUID();
  const password = process.env.LEGACY_ADMIN_PASSWORD || randomBytes(9).toString('hex');
  const email = String(process.env.LEGACY_ADMIN_EMAIL || 'owner@localhost').trim().toLowerCase();
  const inviteImageFile = copyLegacyImage(id);
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
    legacy: true,
    brideName: 'דניאל',
    groomName: 'יובל',
    weddingDate: '14.10.26',
    wazeUrl: 'https://ul.waze.com/ul?venue_id=22872388.228658344.2001245&overview=yes&utm_campaign=default&utm_source=waze_website&utm_medium=lm_share_location',
    mapsUrl: 'https://maps.app.goo.gl/YwCwhRbqcoD2Ky1a8?g_st=aw',
    guestSheetId,
    responseSheetId: responseSheetId || guestSheetId,
    sheetTab: 'חתונה',
    columnMap: {},
    invitationMessage: '',
    reminderTemplate: '',
    inviteImageFile,
    paymentSeed: null,
    createdAt: new Date().toISOString(),
  };
  saveAccount(account);
  const previousPayments = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'payment-routing.json');
  const target = path.join(getDataDir(), 'payments', `${id}.json`);
  if (fs.existsSync(previousPayments)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.copyFileSync(previousPayments, target);
  } else {
    seedPaymentFile(id, {});
  }
  if (!process.env.LEGACY_ADMIN_PASSWORD) {
    console.log(`[accounts] legacy admin ${email} password: ${password}`);
  }
  console.log(`[accounts] legacy wedding ready. Service account: ${getServiceAccountEmail() || '(not loaded yet)'}`);
}
