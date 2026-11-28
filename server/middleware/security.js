import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Small in-memory limits for a single Render instance.
 * Resets on restart; enough to stop online guessing and request floods.
 */
const buckets = new Map();
const codeFails = new Map();
const MAX_TRACKED_KEYS = 10_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BUCKET_TTL_MS = 15 * 60 * 1000;

function clientIp(req) {
  let ip = String(req?.ip || req?.socket?.remoteAddress || '').trim() || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function pruneMapCap(map, maxSize) {
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    const ttl = entry.windowMs || DEFAULT_BUCKET_TTL_MS;
    const recent = entry.times.filter((t) => now - t < ttl);
    if (!recent.length) buckets.delete(key);
    else entry.times = recent;
  }
  for (const [key, row] of codeFails) {
    if (!row || now >= row.until) codeFails.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

export function rateLimit({ windowMs, max, name }) {
  return (req, res, next) => {
    const now = Date.now();
    const id = `${name}:${clientIp(req)}`;
    const existing = buckets.get(id);
    const recent = (existing?.times || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({
        success: false,
        error: 'יותר מדי בקשות. נסו שוב בעוד כמה דקות.',
      });
    }
    recent.push(now);
    // Refresh insertion order so LRU eviction drops stalest keys first.
    buckets.delete(id);
    buckets.set(id, { times: recent, windowMs });
    pruneMapCap(buckets, MAX_TRACKED_KEYS);
    return next();
  };
}

export function tooManyCodeAttempts(kind, email) {
  const key = `${kind}:${String(email || '').trim().toLowerCase()}`;
  const row = codeFails.get(key);
  if (row && Date.now() >= row.until) {
    codeFails.delete(key);
    return false;
  }
  return Boolean(row && row.count >= 5 && Date.now() < row.until);
}

export function recordCodeFailure(kind, email) {
  const key = `${kind}:${String(email || '').trim().toLowerCase()}`;
  const row = codeFails.get(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  if (Date.now() > row.until) {
    row.count = 0;
    row.until = Date.now() + 15 * 60 * 1000;
  }
  row.count += 1;
  codeFails.delete(key);
  codeFails.set(key, row);
  pruneMapCap(codeFails, MAX_TRACKED_KEYS);
  return row.count >= 5;
}

export function clearCodeFailures(kind, email) {
  codeFails.delete(`${kind}:${String(email || '').trim().toLowerCase()}`);
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN so /manage/landing can embed /i/:token?preview=1. DENY broke that iframe.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.RENDER === 'true' || process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

export function allowedOrigins() {
  const origins = new Set();
  for (const raw of [process.env.INVITE_BASE_URL, process.env.RSVP_BASE_URL]) {
    const text = String(raw || '').trim().replace(/\/$/, '');
    if (text) origins.add(text);
  }
  origins.add('http://localhost:8080');
  origins.add('http://127.0.0.1:8080');
  return origins;
}

const PAYMENT_ALLOWED_HOSTS = ['payboxapp.com', 'payboxapp.page.link', 'bitpay.co.il'];
const WAZE_ALLOWED_HOSTS = ['waze.com'];
const MAPS_ALLOWED_HOSTS = ['google.com', 'maps.app.goo.gl', 'goo.gl'];

function hostMatchesAllowlist(hostname, allowlist) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return allowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Validate an optional HTTPS URL against an allowlist of base domains.
 * Empty string returns '' when allowEmpty is true.
 */
export function validateAllowedHttpsUrl(raw, allowlist, errorMessage, { allowEmpty = true } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) {
    if (allowEmpty) return '';
    throw Object.assign(new Error(errorMessage), { status: 400 });
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw Object.assign(new Error(errorMessage), { status: 400 });
  }
  if (parsed.protocol !== 'https:' || !hostMatchesAllowlist(parsed.hostname, allowlist)) {
    throw Object.assign(new Error(errorMessage), { status: 400 });
  }
  return parsed.toString();
}

export function validatePaymentUrl(raw, { allowEmpty = true } = {}) {
  return validateAllowedHttpsUrl(
    raw,
    PAYMENT_ALLOWED_HOSTS,
    'קישור התשלום חייב להיות כתובת https תקינה של PayBox או Bit',
    { allowEmpty },
  );
}

export function isValidPaymentUrl(raw) {
  try {
    return Boolean(validatePaymentUrl(raw, { allowEmpty: false }));
  } catch {
    return false;
  }
}

export function validateWazeUrl(raw) {
  return validateAllowedHttpsUrl(
    raw,
    WAZE_ALLOWED_HOSTS,
    'קישור Waze חייב להיות כתובת https תקינה של waze.com',
    { allowEmpty: true },
  );
}

export function validateMapsUrl(raw) {
  return validateAllowedHttpsUrl(
    raw,
    MAPS_ALLOWED_HOSTS,
    'קישור Google Maps חייב להיות כתובת https תקינה של Google Maps',
    { allowEmpty: true },
  );
}

const SHEET_CHALLENGE_TTL_MS = 2 * 60 * 60 * 1000;
let fallbackChallengeSecret = '';

function sheetChallengeSecret() {
  const configured = String(process.env.SHEET_CHALLENGE_SECRET || process.env.DATABASE_URL || '').trim();
  if (configured) return configured;
  if (!fallbackChallengeSecret) fallbackChallengeSecret = randomBytes(32).toString('hex');
  return fallbackChallengeSecret;
}

function signChallengePayload(payload) {
  return createHmac('sha256', sheetChallengeSecret()).update(payload).digest('hex');
}

export function generateSheetVerifyCode() {
  return `EW-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Issue a short-lived signed sheet ownership challenge for signup (before an account exists). */
export function createSheetChallenge() {
  const code = generateSheetVerifyCode();
  const exp = Date.now() + SHEET_CHALLENGE_TTL_MS;
  const payload = `${code}.${exp}`;
  const sig = signChallengePayload(payload);
  return { code, token: `${payload}.${sig}`, expiresAt: exp };
}

/** Verify a signup sheet ownership challenge token and return its code, or null if invalid/expired. */
export function verifySheetChallengeToken(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) return null;
  const [code, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!/^EW-[A-F0-9]{6}$/.test(code) || !Number.isFinite(exp) || Date.now() > exp) {
    return null;
  }
  const expected = signChallengePayload(`${code}.${expStr}`);
  const actualBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  return code;
}
