import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { getDataDir } from '../config/dataDir.js';
import { findAccountById } from './accounts.js';
import { accountStore } from './accountContext.js';

const COOKIE = 'sid';
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

function sessionsPath() {
  return path.join(getDataDir(), 'sessions.json');
}

function readSessions() {
  const file = sessionsPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeSessions(data) {
  const file = sessionsPath();
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

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

export function createSession(account) {
  const token = randomBytes(24).toString('hex');
  const sessions = readSessions();
  sessions[token] = { accountId: account.id, expires: Date.now() + MAX_AGE_SEC * 1000 };
  writeSessions(sessions);
  return token;
}

export function destroySessionToken(token) {
  if (!token) return;
  const sessions = readSessions();
  delete sessions[token];
  writeSessions(sessions);
}

export function accountFromRequest(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const sessions = readSessions();
  const row = sessions[token];
  if (!row || !row.expires || Date.now() > row.expires) {
    if (row) destroySessionToken(token);
    return null;
  }
  return findAccountById(row.accountId);
}

export function requireAccount(req, res, next) {
  const account = accountFromRequest(req);
  if (!account) {
    return res.status(401).json({ success: false, error: 'יש להתחבר' });
  }
  req.account = account;
  return accountStore.run(account, () => next());
}
