import { randomBytes } from 'crypto';
import { query } from '../db/pool.js';
import { findAccountById } from './accounts.js';
import { accountStore } from './accountContext.js';

const COOKIE = 'sid';
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

export function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

function cookieSecure() {
  return process.env.RENDER === 'true' || process.env.NODE_ENV === 'production';
}

export function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export async function createSession(account) {
  const token = randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + MAX_AGE_SEC * 1000);
  await query(
    `INSERT INTO sessions (token, account_id, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET account_id = EXCLUDED.account_id, expires_at = EXCLUDED.expires_at`,
    [token, account.id, expires.toISOString()],
  );
  return token;
}

export async function destroySessionToken(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function accountFromRequest(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const result = await query(
    'SELECT account_id, expires_at FROM sessions WHERE token = $1 LIMIT 1',
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(row.expires_at);
  if (!expiresAt || Date.now() > expiresAt) {
    await destroySessionToken(token);
    return null;
  }
  return await findAccountById(row.account_id);
}

export async function requireAccount(req, res, next) {
  try {
    const account = await accountFromRequest(req);
    if (!account) {
      return res.status(401).json({ success: false, error: 'יש להתחבר' });
    }
    req.account = account;
    return accountStore.run(account, () => next());
  } catch (error) {
    console.error('[sessions] requireAccount failed', error);
    return res.status(500).json({ success: false, error: 'שגיאת התחברות' });
  }
}
