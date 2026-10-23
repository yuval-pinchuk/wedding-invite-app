import { createHash, randomBytes, timingSafeEqual } from 'crypto';
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

function cookieSecure() {
  return process.env.RENDER === 'true' || process.env.NODE_ENV === 'production';
}

/**
 * Client IP for session binding.
 * Uses Express `req.ip` only (trust proxy is set) so clients cannot spoof via X-Forwarded-For.
 */
export function requestIp(req) {
  let ip = String(req.ip || req.socket?.remoteAddress || '').trim() || 'unknown';
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
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (cookieSecure()) parts.push('Secure');
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
  // One active login per account: drop prior sessions (stolen cookies, other devices).
  await query('DELETE FROM sessions WHERE account_id = $1', [account.id]);
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
 * Resolve account from cookie. Binds session to login IP and sliding 15m idle expiry.
 * On success sets `req.sessionToken` for cookie refresh.
 */
export async function accountFromRequest(req) {
  const token = readCookie(req, COOKIE);
  if (!token || token.length < 32) return null;

  const result = await query(
    'SELECT account_id, expires_at, ip_hash, last_seen_at FROM sessions WHERE token = $1 LIMIT 1',
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;

  const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(row.expires_at);
  if (!expiresAt || Date.now() > expiresAt) {
    await destroySessionToken(token);
    return null;
  }

  const currentHash = hashIp(requestIp(req));
  const storedHash = String(row.ip_hash || '');
  const ipOk = storedHash.length === currentHash.length
    && storedHash.length > 0
    && timingSafeEqual(Buffer.from(storedHash), Buffer.from(currentHash));
  if (!ipOk) {
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
      clearSessionCookie(res);
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
