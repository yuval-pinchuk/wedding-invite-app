import { createHash, randomBytes } from 'crypto';
import { query } from '../db/pool.js';
import { findAccountById } from './accounts.js';
import { accountStore } from './accountContext.js';

const COOKIE = 'sid';
/** Idle session lifetime: no requests for this long → must re-login. */
const IDLE_SEC = 15 * 60;
/** Throttle DB/cookie sliding writes to once per this many seconds. */
const SLIDE_MIN_SEC = 30;

export function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

/**
 * Secure cookies are dropped by the browser on plain HTTP, which looks like an
 * instant logout. Set the flag only when this request is actually HTTPS
 * (Render sets X-Forwarded-Proto; trust proxy makes `req.secure` true).
 */
function cookieSecure(res) {
  return Boolean(res?.req?.secure);
}

/**
 * Client IP recorded on the session row (audit only; not used to reject logins).
 * Uses Express `req.ip` (trust proxy is set) so clients cannot spoof via X-Forwarded-For.
 */
export function requestIp(req) {
  let ip = String(req?.ip || req?.socket?.remoteAddress || '').trim() || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function hashIp(ip) {
  return createHash('sha256').update(String(ip || 'unknown')).digest('hex');
}

export function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${IDLE_SEC}`,
  ];
  if (cookieSecure(res)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (cookieSecure(res)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * @param {object} account
 * @param {import('express').Request} req
 */
export async function createSession(account, req) {
  const token = randomBytes(32).toString('hex');
  const ipHash = hashIp(requestIp(req));
  const expires = new Date(Date.now() + IDLE_SEC * 1000);
  // Drop only expired rows. Replacing every live session made a second login
  // (double submit, another tab) invalidate the cookie the browser just stored.
  await query(
    'DELETE FROM sessions WHERE account_id = $1 AND expires_at < NOW()',
    [account.id],
  );
  await query(
    `INSERT INTO sessions (token, account_id, expires_at, ip_hash, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [token, account.id, expires.toISOString(), ipHash],
  );
  return token;
}

export async function destroySessionToken(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function destroySessionsForAccount(accountId) {
  if (!accountId) return;
  await query('DELETE FROM sessions WHERE account_id = $1', [accountId]);
}

/** Remove expired rows (idle timeout already enforced on read). */
export async function purgeExpiredSessions() {
  await query('DELETE FROM sessions WHERE expires_at < NOW()');
}

/**
 * Resolve account from cookie. Sliding 15m idle expiry.
 * IP is stored for audit only — client addresses change (IPv4/IPv6, mobile, proxy)
 * and rejecting on mismatch was logging people out on the next page.
 * On success sets `req.sessionToken` for cookie refresh.
 */
export async function accountFromRequest(req) {
  const token = readCookie(req, COOKIE);
  if (!token || token.length < 32) return null;

  const result = await query(
    'SELECT account_id, expires_at, last_seen_at FROM sessions WHERE token = $1 LIMIT 1',
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;

  const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(row.expires_at);
  if (!expiresAt || Date.now() > expiresAt) {
    await destroySessionToken(token);
    return null;
  }

  const lastSeen = row.last_seen_at instanceof Date
    ? row.last_seen_at.getTime()
    : Date.parse(row.last_seen_at) || 0;
  const shouldSlide = !lastSeen || Date.now() - lastSeen >= SLIDE_MIN_SEC * 1000;
  if (shouldSlide) {
    const nextExpires = new Date(Date.now() + IDLE_SEC * 1000);
    await query(
      `UPDATE sessions SET expires_at = $2, last_seen_at = NOW() WHERE token = $1`,
      [token, nextExpires.toISOString()],
    );
  }

  const account = await findAccountById(row.account_id);
  if (!account) {
    await destroySessionToken(token);
    return null;
  }
  req.sessionToken = token;
  req.sessionSlid = shouldSlide;
  return account;
}

export function refreshSessionCookieIfNeeded(req, res) {
  if (req.sessionToken && req.sessionSlid) {
    setSessionCookie(res, req.sessionToken);
  }
}

export async function requireAccount(req, res, next) {
  try {
    const account = await accountFromRequest(req);
    if (!account) {
      // Do not clear the cookie here. A late 401 (old tab, poll, prefetch) would
      // wipe a session cookie that a newer login just stored.
      return res.status(401).json({
        success: false,
        error: 'יש להתחבר מחדש',
        reauth: true,
      });
    }
    refreshSessionCookieIfNeeded(req, res);
    req.account = account;
    return accountStore.run(account, () => next());
  } catch (error) {
    console.error('[sessions] requireAccount failed', error);
    return res.status(500).json({ success: false, error: 'שגיאת התחברות' });
  }
}
