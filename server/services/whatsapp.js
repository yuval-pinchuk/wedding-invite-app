/**
 * WhatsApp via Baileys (unofficial; personal WhatsApp / multi-device).
 *
 * Environment (optional):
 * - WHATSAPP_SEND_DELAY_MS — base pause after each successful send (default 2000).
 * - WHATSAPP_SEND_JITTER_MS — random extra 0..N ms added to the base (default 1200). Max gap = base+jitter.
 * - WHATSAPP_BATCH_SIZE — successful sends between longer pauses (default 25).
 * - WHATSAPP_BATCH_PAUSE_MS — extra pause after each batch (default 5000).
 * - WHATSAPP_INVITE_IMAGE_PATH — optional absolute path to a JPEG/PNG sent with the invite/reminder text as caption.
 *   If unset, looks for `WEDDING.png` in the project root (not cwd). If the file is missing, sends text only.
 * - WHATSAPP_CLEANUP_INTERVAL_MS — how often to log heap and idle-close sessions (default 900000 = 15m).
 * - WHATSAPP_SESSION_IDLE_MS — soft-close sockets unused longer than this (default 2700000 = 45m). Auth folders stay.
 * - WHATSAPP_HEAP_SOFT_LIMIT_MB — if heapUsed exceeds this, soft-close all open sockets (default 220).
 *
 * Auth data per sender: DATA_DIR/wa/<accountId>/<sender>/ (local cache).
 * Synced to Neon `wa_auth_files` so restarts restore without a new QR.
 * Unofficial clients may violate WhatsApp ToS; use at your own risk.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDataDir } from '../config/dataDir.js';
import { currentAccount } from './accountContext.js';
import { ensureInviteImageCached, inviteImagePath } from './accounts.js';
import {
  deleteWaAuthFromNeon,
  restoreWaAuthFromNeon,
  syncWaAuthToNeon,
} from './waAuthStore.js';
import makeWASocket, { DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Project root (this file lives in server/services/). */
const repoRoot = path.join(__dirname, '..', '..');

/** @typedef {{ sock: any, qrCode: string | null, isReady: boolean, connecting: Promise<unknown> | null, userStopped: boolean, lastUsedAt: number, suppressReconnect: boolean }} SenderSession */

/** @type {Map<string, SenderSession>} */
const sessions = new Map();

const silentLogger = pino({ level: 'silent' });

const DEFAULT_INVITE_IMAGE_NAME = 'WEDDING.png';

const DEFAULT_CLEANUP_INTERVAL_MS = 900000;
const DEFAULT_SESSION_IDLE_MS = 2700000;
const DEFAULT_HEAP_SOFT_LIMIT_MB = 220;

/** @type {ReturnType<typeof setInterval> | null} */
let maintenanceTimer = null;

function sessionKey(senderName) {
  return (senderName || '').trim();
}

/** @returns {SenderSession} */
function getSession(senderName) {
  const key = sessionKey(senderName);
  if (!sessions.has(key)) {
    sessions.set(key, {
      sock: null,
      qrCode: null,
      isReady: false,
      connecting: null,
      userStopped: false,
      lastUsedAt: Date.now(),
      suppressReconnect: false,
    });
  }
  return sessions.get(key);
}

function touchSession(senderName) {
  const key = sessionKey(senderName);
  const s = sessions.get(key);
  if (s) {
    s.lastUsedAt = Date.now();
  }
}

function envPositiveMs(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envPositiveMb(name, fallback) {
  const n = parseFloat(process.env[name] || '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function authDirForSender(senderName) {
  const owner = currentAccount()?.id || 'default';
  return path.join(getDataDir(), 'wa', owner, encodeURIComponent(sessionKey(senderName)));
}

function waOwnerAndKey(senderName) {
  const accountId = currentAccount()?.id || '';
  const senderKey = sessionKey(senderName) || 'default';
  return { accountId, senderKey };
}

/** Debounced Neon sync so rapid Baileys key writes coalesce. */
const waSyncTimers = new Map();

function scheduleWaAuthSync(senderName) {
  const { accountId, senderKey } = waOwnerAndKey(senderName);
  if (!accountId) return;
  const mapKey = `${accountId}:${senderKey}`;
  const prev = waSyncTimers.get(mapKey);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    waSyncTimers.delete(mapKey);
    const dir = authDirForSender(senderName);
    syncWaAuthToNeon(accountId, senderKey, dir).catch((err) => {
      console.error('[WhatsApp] Neon auth sync failed', err?.message || err);
    });
  }, 400);
  waSyncTimers.set(mapKey, timer);
}

const DEFAULT_SEND_DELAY_MS = 2000;
const DEFAULT_SEND_JITTER_MS = 1200;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_BATCH_PAUSE_MS = 5000;

function envNonNegInt(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getSendPacingConfig() {
  return {
    delayMs: envNonNegInt('WHATSAPP_SEND_DELAY_MS', DEFAULT_SEND_DELAY_MS),
    jitterMs: envNonNegInt('WHATSAPP_SEND_JITTER_MS', DEFAULT_SEND_JITTER_MS),
    batchSize: Math.max(1, envNonNegInt('WHATSAPP_BATCH_SIZE', DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE),
    batchPauseMs: envNonNegInt('WHATSAPP_BATCH_PAUSE_MS', DEFAULT_BATCH_PAUSE_MS),
  };
}

/** Random delay in [base, base+jitter] after each successful send. */
export function getSendDelayMs() {
  const { delayMs, jitterMs } = getSendPacingConfig();
  if (delayMs <= 0 && jitterMs <= 0) return 0;
  const extra = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return delayMs + extra;
}

export async function sleepSendDelay() {
  const delayMs = getSendDelayMs();
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

export async function sleepBatchPause() {
  const { batchPauseMs } = getSendPacingConfig();
  if (batchPauseMs > 0) {
    await new Promise((r) => setTimeout(r, batchPauseMs));
  }
}

/** Upper-bound remaining time for UI (max gap + future batch pauses). */
export function estimateSendRemainingMs(remainingCount, alreadySuccessfulInJob = 0) {
  const { delayMs, jitterMs, batchSize, batchPauseMs } = getSendPacingConfig();
  const maxGap = delayMs + jitterMs;
  let ms = remainingCount * maxGap;
  if (batchPauseMs > 0 && remainingCount > 0) {
    const nextBatchAt = batchSize - (alreadySuccessfulInJob % batchSize);
    let successesLeft = remainingCount;
    let untilPause = nextBatchAt;
    while (successesLeft > 0) {
      if (successesLeft >= untilPause) {
        successesLeft -= untilPause;
        if (successesLeft > 0) ms += batchPauseMs;
        untilPause = batchSize;
      } else {
        break;
      }
    }
  }
  return ms;
}

/**
 * @param {any} sock
 * @param {string} digits
 * @returns {Promise<boolean>} false when Baileys says the number is not on WhatsApp
 */
export async function isPhoneOnWhatsApp(sock, digits) {
  if (!sock || typeof sock.onWhatsApp !== 'function' || !digits) return true;
  try {
    const results = await sock.onWhatsApp(digits);
    const row = Array.isArray(results) ? results[0] : null;
    if (!row) return false;
    return Boolean(row.exists);
  } catch (error) {
    console.warn(`[WhatsApp] onWhatsApp check failed for ${digits}:`, error?.message || error);
    return true;
  }
}

/** Resolved path to optional invite image (JPEG/PNG). Rehydrates from Neon when needed. */
async function resolveInviteImagePath() {
  const account = currentAccount();
  if (account) {
    try {
      const cached = await ensureInviteImageCached(account);
      if (cached?.path && fs.existsSync(cached.path)) return cached.path;
    } catch {
      /* fall through */
    }
    const accountImage = inviteImagePath(account);
    if (accountImage && fs.existsSync(accountImage)) return accountImage;
  }
  const raw = (process.env.WHATSAPP_INVITE_IMAGE_PATH || DEFAULT_INVITE_IMAGE_NAME).trim();
  if (!raw) {
    return path.join(repoRoot, DEFAULT_INVITE_IMAGE_NAME);
  }
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
}

async function readInviteImageBuffer() {
  const imagePath = await resolveInviteImagePath();
  if (!imagePath || !fs.existsSync(imagePath)) {
    return null;
  }
  try {
    return fs.readFileSync(imagePath);
  } catch {
    return null;
  }
}

/**
 * Format phone for WhatsApp JID (digits only, country code).
 */
export function formatPhoneNumber(phone) {
  let cleaned = String(phone || '').replace(/[^\d+]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '972' + cleaned.substring(1);
  } else if (cleaned.startsWith('+972')) {
    cleaned = cleaned.substring(1);
  } else if (!cleaned.startsWith('972') && /^\d{9}$/.test(cleaned)) {
    cleaned = '972' + cleaned;
  }
  cleaned = cleaned.replace(/^\+/, '');
  return cleaned;
}

/**
 * Baileys: any sheet sender can have a session folder; no JSON map required.
 */
export function isSenderConfigured(_senderName) {
  return true;
}

/**
 * Start or reconnect Baileys for this sender. Idempotent while connecting.
 */
async function connectSocket(senderName) {
  const s = getSession(senderName);
  s.suppressReconnect = false;
  if (s.userStopped) {
    return;
  }
  if (s.sock && s.isReady) {
    return;
  }
  if (s.sock && !s.isReady && !s.connecting) {
    try {
      s.sock.end(undefined);
    } catch {
      /* ignore */
    }
    s.sock = null;
  }
  if (s.connecting) {
    return s.connecting;
  }

  s.connecting = (async () => {
    const dir = authDirForSender(senderName);
    const { accountId, senderKey } = waOwnerAndKey(senderName);
    await fs.promises.mkdir(dir, { recursive: true });
    if (accountId) {
      try {
        await restoreWaAuthFromNeon(accountId, senderKey, dir);
      } catch (error) {
        console.error('[WhatsApp] Neon auth restore failed', error?.message || error);
      }
    }
    const { state, saveCreds } = await useMultiFileAuthState(dir);

    const { version } = await fetchLatestWaWebVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: silentLogger,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
    });

    s.sock = sock;

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      scheduleWaAuthSync(senderName);
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        s.qrCode = qr;
      }
      if (connection === 'open') {
        s.isReady = true;
        s.qrCode = null;
        scheduleWaAuthSync(senderName);
      }
      if (connection === 'close') {
        s.isReady = false;
        s.sock = null;
        scheduleWaAuthSync(senderName);
        if (s.userStopped || s.suppressReconnect) {
          return;
        }
        const err = lastDisconnect?.error;
        const code = err instanceof Boom ? err.output?.statusCode : undefined;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (!loggedOut) {
          const delayMs = code === DisconnectReason.restartRequired ? 1000 : 3000;
          setTimeout(() => {
            const cur = getSession(senderName);
            if (cur.userStopped || cur.suppressReconnect) {
              return;
            }
            s.connecting = null;
            void connectSocket(senderName);
          }, delayMs);
        }
      }
    });
  })();

  try {
    await s.connecting;
  } finally {
    s.connecting = null;
    scheduleWaAuthSync(senderName);
  }
}

/**
 * Initialize connection (QR or restore session). Resolves when socket exists (connection may still be in progress).
 */
export async function initializeWhatsApp(senderName = 'default') {
  const s = getSession(senderName);
  s.userStopped = false;
  touchSession(senderName);
  await connectSocket(senderName);
  return getSession(senderName).sock;
}

/**
 * Wait until connected or timeout.
 * Pass null to wait indefinitely (avoid during sends — a dead session will hang the batch).
 */
export const SEND_READY_TIMEOUT_MS = 60000;

export async function waitForReady(senderName = 'default', maxWaitTime = 300000) {
  const start = Date.now();
  await connectSocket(senderName);
  while (true) {
    const s = getSession(senderName);
    if (s.isReady && s.sock) {
      touchSession(senderName);
      return s.sock;
    }
    if (maxWaitTime != null && Date.now() - start > maxWaitTime) {
      throw new Error(`WhatsApp did not become ready for ${senderName} within ${maxWaitTime}ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function getClient(senderName = 'default') {
  return getSession(senderName).sock;
}

export function getQRCode(senderName = 'default') {
  return getSession(senderName).qrCode;
}

export function getStatus(senderName = 'default') {
  const s = getSession(senderName);
  return {
    ready: s.isReady,
    qrCode: s.qrCode,
  };
}

/**
 * Baileys emits a comma-separated pairing string; encode it with node-qrcode (same family as most Baileys examples).
 * @param {string} pairingString
 * @returns {Promise<string>} PNG data URL
 */
export async function baileysPairingToQrDataUrl(pairingString) {
  if (!pairingString || typeof pairingString !== 'string') {
    throw new TypeError('pairing string required');
  }
  return QRCode.toDataURL(pairingString, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 420,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/**
 * End the socket but keep auth on disk so the next connect can restore without a new QR.
 * @param {string} senderName
 * @param {string} [reason]
 */
export function softCloseSession(senderName, reason = 'idle') {
  const key = sessionKey(senderName);
  const s = sessions.get(key);
  if (!s?.sock) {
    return;
  }

  const sock = s.sock;
  s.sock = null;
  s.qrCode = null;
  s.isReady = false;
  s.connecting = null;
  // Block Baileys connection.close from auto-reconnecting after this intentional end.
  s.suppressReconnect = true;
  try {
    sock.end(undefined);
  } catch {
    /* ignore */
  }

  scheduleWaAuthSync(senderName);
  console.log(`[WhatsApp] soft-closed ${key || senderName} (${reason})`);
}

/**
 * Stop socket and remove auth folder (forces new QR on next init).
 */
export async function destroySession(senderName) {
  const key = sessionKey(senderName);
  const { accountId, senderKey } = waOwnerAndKey(senderName);
  const s = sessions.get(key);
  if (s) {
    s.userStopped = true;
    s.qrCode = null;
    s.isReady = false;
    const sock = s.sock;
    s.sock = null;
    if (sock) {
      try {
        await sock.logout();
      } catch {
        try {
          sock.end(undefined);
        } catch {
          /* ignore */
        }
      }
    }
  }
  const dir = authDirForSender(senderName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (accountId) {
    try {
      await deleteWaAuthFromNeon(accountId, senderKey);
    } catch (error) {
      console.error('[WhatsApp] Neon auth delete failed', error?.message || error);
    }
  }
  sessions.delete(key);
}

/**
 * Normalize add-ons cell text (strip bidi marks Google Sheets sometimes inserts).
 */
function normalizeAddonsCell(addonsStr) {
  return String(addonsStr || '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
}

/**
 * Sheet shapes:
 * - One add-on: "מתן" → {name} ומתן
 * - Two in one cell: "עמרי ומתן" (space before conjunctive ו) → {name}, עמרי ומתן
 * - Several with commas: "יובל, עמרי ומתן" → {name}, <full cell>
 */
export function formatNameWithAddons(name, addonsRaw) {
  const base = String(name || '').trim();
  const s = normalizeAddonsCell(addonsRaw);
  if (!base) {
    return s;
  }
  if (!s) {
    return base;
  }
  const hasComma = /,/.test(s);
  // Conjunctive ו: whitespace before it, then the next name (with or without space after ו).
  // Not ו inside a word (e.g. "יובל" has no space before ו).
  const hasConjunctiveVav = /[\s\u00A0\u2009\u202F]+\u05D5\s*\S/.test(s);
  if (hasComma || hasConjunctiveVav) {
    return `${base}, ${s}`;
  }
  return `${base} ו${s}`;
}

/**
 * Greeting line matching invitation copy:
 * - No add-ons: שלום {name},
 * - One add-on: שלום {name} ו{addon}
 * - Multiple: שלום {name}, {addons}
 */
export function openingLineWithAddons(name, addonsRaw) {
  const s = normalizeAddonsCell(addonsRaw);
  if (!s) {
    return `שלום ${name},`;
  }
  return `שלום ${formatNameWithAddons(name, addonsRaw)}`;
}

function coupleLabel(full) {
  const account = currentAccount();
  if (account && (account.brideName || account.groomName)) {
    return [account.brideName, account.groomName].filter(Boolean).join(' ו');
  }
  return full ? 'דניאל אביטל ויובל פינצ׳וק' : 'דניאל ויובל';
}

function pickVariant(options) {
  return options[Math.floor(Math.random() * options.length)];
}

function composeMessageText(name, addons) {
  const opener = openingLineWithAddons(name, addons);
  const custom = String(currentAccount()?.invitationMessage || '').trim();
  if (custom) return `${opener}\n${custom}`;
  const inviteLine = pickVariant([
    `מתרגשים להזמינכם לחתונה של ${coupleLabel(true)}!`,
    `שמחים להזמין אתכם לחתונה של ${coupleLabel(true)}!`,
  ]);
  const dateLine = pickVariant([
    'שריינו את התאריך- פרטים נוספים יישלחו בהמשך',
    'שמרו את התאריך- פרטים נוספים בדרך אליכם',
  ]);
  const closeLine = pickVariant(['מחכים לחגוג איתכם❤️', 'מחכים לחגוג יחד❤️']);
  return `${opener}
${inviteLine}
${dateLine}
${closeLine}`;
}

function stripEnvQuotes(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

export function defaultReminderTemplate() {
  const custom = String(currentAccount()?.reminderTemplate || '').trim();
  if (custom) return custom;
  return `{{greeting}}
{{rsvpLine}}
{{askLine}}
{{link}}
{{thanksLine}}`;
}

export const DEFAULT_RSVP_REMINDER_TEMPLATE = `{{greeting}}
טרם קיבלנו את אישור ההגעה שלכם לחתונה של דניאל ויובל.
נשמח אם תוכלו למלא את הטופס כאן:
{{link}}
תודה!`;

export function buildRsvpLink(phone) {
  const base = getRsvpBaseUrl();
  if (!base) {
    return '';
  }
  const account = currentAccount();
  const phoneQuery = `phone=${encodeURIComponent(phone)}`;
  if (account?.publicToken) {
    return `${base}/i/${account.publicToken}?${phoneQuery}`;
  }
  return `${base}/?${phoneQuery}`;
}

export function getRsvpBaseUrl() {
  const base = stripEnvQuotes(process.env.RSVP_BASE_URL || process.env.INVITE_BASE_URL || '');
  return base.replace(/\/$/, '');
}

/**
 * @param {string} template
 * @param {{ name?: string, fullName?: string, phone?: string, addons?: string }} vars
 */
export function renderReminderTemplate(template, { name, fullName, phone, addons }) {
  const link = buildRsvpLink(phone || '');
  const displayName = formatNameWithAddons(name || '', addons);
  const displayFullName = formatNameWithAddons(fullName || name || '', addons);
  const greeting = openingLineWithAddons(name || fullName || '', addons);
  const couple = coupleLabel(false);
  const rsvpLine = pickVariant([
    `טרם קיבלנו את אישור ההגעה שלכם לחתונה של ${couple}.`,
    `עדיין לא קיבלנו מכם אישור הגעה לחתונה של ${couple}.`,
  ]);
  const askLine = pickVariant([
    'נשמח אם תוכלו למלא את הטופס כאן:',
    'נשמח אם תמלאו את הטופס בקישור הזה:',
  ]);
  const thanksLine = pickVariant(['תודה!', 'תודה רבה!']);
  let text = String(template || '');
  // Legacy default body: inject a random middle-line variant when the template is fixed.
  if (text.includes('טרם קיבלנו את אישור ההגעה שלכם לחתונה של') && !text.includes('{{rsvpLine}}')) {
    text = text.replace(
      /טרם קיבלנו את אישור ההגעה שלכם לחתונה של[^\n]*/,
      rsvpLine,
    );
    text = text.replace('נשמח אם תוכלו למלא את הטופס כאן:', askLine);
    text = text.replace(/^תודה!$/m, thanksLine);
  }
  return text
    .replace(/\{\{greeting\}\}/g, greeting)
    .replace(/\{\{name\}\}/g, displayName)
    .replace(/\{\{fullName\}\}/g, displayFullName)
    .replace(/\{\{link\}\}/g, link)
    .replace(/\{\{rsvpLine\}\}/g, rsvpLine)
    .replace(/\{\{askLine\}\}/g, askLine)
    .replace(/\{\{thanksLine\}\}/g, thanksLine);
}

/**
 * @param {{ to: string, senderName: string, text: string, includeImage?: boolean }} payload
 */
export async function sendWhatsAppText(payload) {
  const { to, senderName, text, includeImage = true } = payload;
  if (!to || !senderName) {
    return { success: false, error: 'Missing to or senderName', to: to || '' };
  }
  if (!text || !String(text).trim()) {
    return { success: false, error: 'Message text is required', to: to || '' };
  }

  const digits = formatPhoneNumber(to);
  const jid = `${digits}@s.whatsapp.net`;
  const caption = String(text);

  try {
    const sock = await waitForReady(senderName, SEND_READY_TIMEOUT_MS);
    if (!sock || !sock.user) {
      return { success: false, error: 'WhatsApp not connected', to: digits };
    }
    if (!(await isPhoneOnWhatsApp(sock, digits))) {
      return { success: false, skipped: true, error: 'Number is not on WhatsApp', to: digits };
    }

    const imageBuf = includeImage ? await readInviteImageBuffer() : null;
    if (imageBuf) {
      await sock.sendMessage(jid, { image: imageBuf, caption });
    } else {
      await sock.sendMessage(jid, { text: caption });
    }
    touchSession(senderName);
    await sleepSendDelay();

    return { success: true, to: digits, jid };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
      to: digits,
    };
  }
}

/**
 * @param {{ to: string, senderName: string, name: string, addons?: string }} payload
 */
export async function sendWhatsAppInvitation(payload) {
  const { to, senderName, name, addons } = payload;
  if (!to || !senderName) {
    return { success: false, error: 'Missing to or senderName', to: to || '' };
  }

  const digits = formatPhoneNumber(to);
  const jid = `${digits}@s.whatsapp.net`;
  const text = composeMessageText(name || 'אורח', addons);

  try {
    const sock = await waitForReady(senderName, SEND_READY_TIMEOUT_MS);
    if (!sock || !sock.user) {
      return { success: false, error: 'WhatsApp not connected', to: digits };
    }
    if (!(await isPhoneOnWhatsApp(sock, digits))) {
      return { success: false, skipped: true, error: 'Number is not on WhatsApp', to: digits };
    }

    const imageBuf = await readInviteImageBuffer();
    if (imageBuf) {
      await sock.sendMessage(jid, { image: imageBuf, caption: text });
    } else {
      await sock.sendMessage(jid, { text });
    }
    touchSession(senderName);
    await sleepSendDelay();

    return { success: true, to: digits, jid };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
      to: digits,
    };
  }
}

function runSessionMaintenanceTick() {
  const mem = process.memoryUsage();
  const heapUsedMb = mem.heapUsed / (1024 * 1024);
  const heapTotalMb = mem.heapTotal / (1024 * 1024);
  const rssMb = mem.rss / (1024 * 1024);
  let ready = 0;
  let withSock = 0;
  for (const s of sessions.values()) {
    if (s.isReady) ready += 1;
    if (s.sock) withSock += 1;
  }
  console.log(
    `[WhatsApp] memory heapUsed=${heapUsedMb.toFixed(1)}MB heapTotal=${heapTotalMb.toFixed(1)}MB rss=${rssMb.toFixed(1)}MB sessions=${sessions.size} ready=${ready} withSock=${withSock}`,
  );

  const heapSoftLimitMb = envPositiveMb('WHATSAPP_HEAP_SOFT_LIMIT_MB', DEFAULT_HEAP_SOFT_LIMIT_MB);
  const idleMs = envPositiveMs('WHATSAPP_SESSION_IDLE_MS', DEFAULT_SESSION_IDLE_MS);
  const now = Date.now();

  if (heapUsedMb >= heapSoftLimitMb) {
    for (const [name, s] of sessions) {
      if (s.sock) {
        softCloseSession(name, `heap-pressure ${heapUsedMb.toFixed(1)}MB>=${heapSoftLimitMb}MB`);
      }
    }
    return;
  }

  for (const [name, s] of sessions) {
    if (!s.sock) continue;
    if (now - (s.lastUsedAt || 0) >= idleMs) {
      softCloseSession(name, `idle ${Math.round((now - s.lastUsedAt) / 60000)}m`);
    }
  }
}

/**
 * Periodic heap logging and idle/pressure soft-close of Baileys sockets (auth folders kept).
 */
export function startSessionMaintenance() {
  if (maintenanceTimer) {
    return;
  }
  const intervalMs = envPositiveMs('WHATSAPP_CLEANUP_INTERVAL_MS', DEFAULT_CLEANUP_INTERVAL_MS);
  maintenanceTimer = setInterval(() => {
    try {
      runSessionMaintenanceTick();
    } catch (e) {
      console.warn('[WhatsApp] session maintenance failed:', e?.message || e);
    }
  }, intervalMs);
  if (typeof maintenanceTimer.unref === 'function') {
    maintenanceTimer.unref();
  }
  console.log(
    `[WhatsApp] session maintenance every ${Math.round(intervalMs / 60000)}m (idle ${Math.round(envPositiveMs('WHATSAPP_SESSION_IDLE_MS', DEFAULT_SESSION_IDLE_MS) / 60000)}m, heap soft limit ${envPositiveMb('WHATSAPP_HEAP_SOFT_LIMIT_MB', DEFAULT_HEAP_SOFT_LIMIT_MB)}MB)`,
  );
}

