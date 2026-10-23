/**
 * Small in-memory limits for a single Render instance.
 * Resets on restart; enough to stop online guessing and request floods.
 */
const buckets = new Map();

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || 'unknown';
}

export function rateLimit({ windowMs, max, name }) {
  return (req, res, next) => {
    const now = Date.now();
    const id = `${name}:${clientIp(req)}`;
    const recent = (buckets.get(id) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({
        success: false,
        error: 'יותר מדי בקשות. נסו שוב בעוד כמה דקות.',
      });
    }
    recent.push(now);
    buckets.set(id, recent);
    return next();
  };
}

const codeFails = new Map();

export function tooManyCodeAttempts(kind, email) {
  const key = `${kind}:${String(email || '').trim().toLowerCase()}`;
  const row = codeFails.get(key);
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
  codeFails.set(key, row);
  return row.count >= 5;
}

export function clearCodeFailures(kind, email) {
  codeFails.delete(`${kind}:${String(email || '').trim().toLowerCase()}`);
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
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
