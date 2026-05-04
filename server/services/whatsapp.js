/**
 * WhatsApp via Baileys (unofficial; personal WhatsApp / multi-device).
 *
 * Environment (optional):
 * - WHATSAPP_SEND_DELAY_MS — pause after each successful send (default 600). Lower = faster, higher ban risk.
 * - WHATSAPP_WARM_SENDERS — comma-separated sender names to connect at server boot (optional).
 * - WHATSAPP_INVITE_IMAGE_PATH — optional absolute path to a JPEG/PNG sent with the invite text as caption.
 *   If unset, looks for `wedding.png` in the project root (not cwd). If the file is missing, sends text only.
 *
 * Auth data per sender: `.baileys_auth_<urlencoded_sender>/` under server/ (see authDirForSender).
 * Unofficial clients may violate WhatsApp ToS; use at your own risk.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, { DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Project root (this file lives in server/services/). */
const repoRoot = path.join(__dirname, '..', '..');

/** @typedef {{ sock: any, qrCode: string | null, isReady: boolean, connecting: Promise<unknown> | null, userStopped: boolean }} SenderSession */

/** @type {Map<string, SenderSession>} */
const sessions = new Map();

const silentLogger = pino({ level: 'silent' });

const DEFAULT_INVITE_IMAGE_NAME = 'wedding.png';

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
    });
  }
  return sessions.get(key);
}

export function authDirForSender(senderName) {
  return path.resolve(__dirname, `../.baileys_auth_${encodeURIComponent(sessionKey(senderName))}`);
}

function getSendDelayMs() {
  const n = parseInt(process.env.WHATSAPP_SEND_DELAY_MS || '600', 10);
  return Number.isFinite(n) && n >= 0 ? n : 600;
}

/** Resolved path to optional invite image (JPEG/PNG). */
function resolveInviteImagePath() {
  const raw = (process.env.WHATSAPP_INVITE_IMAGE_PATH || DEFAULT_INVITE_IMAGE_NAME).trim();
  if (!raw) {
    return path.join(repoRoot, DEFAULT_INVITE_IMAGE_NAME);
  }
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
}

function readInviteImageBuffer() {
  const imagePath = resolveInviteImagePath();
  if (!fs.existsSync(imagePath)) {
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
    await fs.promises.mkdir(dir, { recursive: true });
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

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        s.qrCode = qr;
      }
      if (connection === 'open') {
        s.isReady = true;
        s.qrCode = null;
      }
      if (connection === 'close') {
        s.isReady = false;
        s.sock = null;
        if (s.userStopped) {
          return;
        }
        const err = lastDisconnect?.error;
        const code = err instanceof Boom ? err.output?.statusCode : undefined;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (!loggedOut) {
          const delayMs = code === DisconnectReason.restartRequired ? 1000 : 3000;
          setTimeout(() => {
            if (getSession(senderName).userStopped) {
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
  }
}

/**
 * Initialize connection (QR or restore session). Resolves when socket exists (connection may still be in progress).
 */
export async function initializeWhatsApp(senderName = 'default') {
  const s = getSession(senderName);
  s.userStopped = false;
  await connectSocket(senderName);
  return getSession(senderName).sock;
}

/**
 * Wait until connected or timeout (null max = 5 min default guard).
 */
export async function waitForReady(senderName = 'default', maxWaitTime = 300000) {
  const start = Date.now();
  await connectSocket(senderName);
  while (true) {
    const s = getSession(senderName);
    if (s.isReady && s.sock) {
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
 * Stop socket and remove auth folder (forces new QR on next init).
 */
export async function destroySession(senderName) {
  const key = sessionKey(senderName);
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
 * - One add-on: "מתן" → שלום {name} ומתן
 * - Two in one cell: "עמרי ומתן" (space before conjunctive ו) → שלום {name}, עמרי ומתן
 * - Several with commas: "יובל, עמרי ומתן" / "דניאל, יובל, עמרי ומתן" → שלום {name}, <full cell>
 */
function openingLineWithAddons(name, addonsRaw) {
  const s = normalizeAddonsCell(addonsRaw);
  if (!s) {
    return `שלום ${name},`;
  }
  const hasComma = /,/.test(s);
  // Conjunctive ו: whitespace before it, then the next name (with or without space after ו).
  // Not ו inside a word (e.g. "יובל" has no space before ו).
  const hasConjunctiveVav = /[\s\u00A0\u2009\u202F]+\u05D5\s*\S/.test(s);
  if (hasComma || hasConjunctiveVav) {
    return `שלום ${name}, ${s}`;
  }
  return `שלום ${name} ו${s}`;
}

function composeMessageText(name, addons) {
  const opener = openingLineWithAddons(name, addons);
  return `${opener}
הנכם מוזמנים למסיבת החינה של דניאל אביטל ויובל פינצ׳וק🪬
פרטים נוספים ישלחו בהמשך,
מחכים לחגוג איתכם❤️`;
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
    const sock = await waitForReady(senderName, null);
    if (!sock || !sock.user) {
      return { success: false, error: 'WhatsApp not connected', to: digits };
    }

    const imageBuf = readInviteImageBuffer();
    if (imageBuf) {
      await sock.sendMessage(jid, { image: imageBuf, caption: text });
    } else {
      await sock.sendMessage(jid, { text });
    }
    const delayMs = getSendDelayMs();
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

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
 * Optional: connect listed senders after server starts (hides QR cold start during event).
 */
export async function warmWhatsAppSessions() {
  const raw = process.env.WHATSAPP_WARM_SENDERS || '';
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of names) {
    try {
      void connectSocket(name);
    } catch (e) {
      console.warn(`[WhatsApp] warm failed for ${name}:`, e.message);
    }
  }
}
