/**
 * Payment routing between personal Bit / PayBox links.
 * Persists totals and thresholds in server/data/payment-routing.json.
 *
 * Note: personal Bit/PayBox links do not notify this app when payment completes.
 * Guest "pay" clicks record an intent amount against the active link; admins can correct totals.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'payment-routing.json');

/** @typedef {{ id: string, label: string, provider: 'paybox' | 'bit', owner: string, url: string, threshold: number, currentSum: number }} PaymentLink */
/** @typedef {{ mode: 'auto' | 'manual', manualLinkId: string | null, links: PaymentLink[], history: Array<{ id: string, timestamp: string, linkId: string, amount: number, source: string, note?: string }> }} PaymentState */

/** @returns {PaymentState} */
function defaultState() {
  return {
    mode: 'auto',
    manualLinkId: null,
    links: [
      {
        id: 'danielle-paybox',
        label: "Danielle's PayBox",
        provider: 'paybox',
        owner: 'danielle',
        url: 'https://links.payboxapp.com/0GY5mgJlQ4b',
        threshold: 20000,
        currentSum: 0,
      },
      {
        id: 'yuval-paybox',
        label: "Yuval's PayBox",
        provider: 'paybox',
        owner: 'yuval',
        url: 'https://links.payboxapp.com/CaM4W2RGy4b',
        threshold: 20000,
        currentSum: 0,
      },
      {
        id: 'danielle-bit',
        label: "Danielle's Bit",
        provider: 'bit',
        owner: 'danielle',
        url: 'https://www.bitpay.co.il/app/me/8583B20C-F2B6-1E4E-0480-7EAEBE6D88D33F2A',
        threshold: 10000,
        currentSum: 0,
      },
      {
        id: 'yuval-bit',
        label: "Yuval's Bit",
        provider: 'bit',
        owner: 'yuval',
        url: 'https://www.bitpay.co.il/app/me/B2959BBF-6DA3-CCA7-E778-A221BAE7B7D3A173',
        threshold: 10000,
        currentSum: 0,
      },
    ],
    history: [],
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultState(), null, 2), 'utf8');
  }
}

/** @returns {PaymentState} */
export function readPaymentState() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    console.error('[paymentRouting] failed to read state, resetting defaults', error);
    const state = defaultState();
    writePaymentState(state);
    return state;
  }
}

/** @param {PaymentState} state */
function writePaymentState(state) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** @param {any} parsed @returns {PaymentState} */
function normalizeState(parsed) {
  const defaults = defaultState();
  const byId = new Map((parsed?.links || []).map((l) => [l.id, l]));

  const links = defaults.links.map((def) => {
    const existing = byId.get(def.id) || {};
    return {
      ...def,
      url: typeof existing.url === 'string' && existing.url ? existing.url : def.url,
      threshold: Number.isFinite(Number(existing.threshold))
        ? Math.max(0, Math.floor(Number(existing.threshold)))
        : def.threshold,
      currentSum: Number.isFinite(Number(existing.currentSum))
        ? Math.max(0, Math.floor(Number(existing.currentSum)))
        : 0,
      label: typeof existing.label === 'string' && existing.label ? existing.label : def.label,
    };
  });

  const mode = parsed?.mode === 'manual' ? 'manual' : 'auto';
  const manualLinkId =
    mode === 'manual' && links.some((l) => l.id === parsed?.manualLinkId)
      ? parsed.manualLinkId
      : null;

  return {
    mode: manualLinkId ? 'manual' : 'auto',
    manualLinkId,
    links,
    history: Array.isArray(parsed?.history) ? parsed.history.slice(-200) : [],
  };
}

/** @param {PaymentLink} link */
function remaining(link) {
  return Math.max(0, link.threshold - link.currentSum);
}

/**
 * Auto: first link that still has capacity (currentSum < threshold).
 * If all are full, falls back to the last link.
 * Manual: forced link id.
 * @param {PaymentState} [state]
 * @returns {PaymentLink}
 */
export function resolveActiveLink(state = readPaymentState()) {
  if (state.mode === 'manual' && state.manualLinkId) {
    const forced = state.links.find((l) => l.id === state.manualLinkId);
    if (forced) return forced;
  }

  const available = state.links.find((l) => l.currentSum < l.threshold);
  return available || state.links[state.links.length - 1];
}

/** @param {PaymentState} [state] */
export function getPaymentStatus(state = readPaymentState()) {
  const active = resolveActiveLink(state);
  const totalReceived = state.links.reduce((sum, l) => sum + l.currentSum, 0);
  const totalCapacity = state.links.reduce((sum, l) => sum + l.threshold, 0);

  return {
    mode: state.mode,
    manualLinkId: state.manualLinkId,
    activeLinkId: active.id,
    totalReceived,
    totalCapacity,
    links: state.links.map((link) => ({
      ...link,
      remaining: remaining(link),
      isFull: link.currentSum >= link.threshold,
      isActive: link.id === active.id,
    })),
    recentHistory: state.history.slice(-30).reverse(),
  };
}

/**
 * Record a guest gift intent and return the link they should open.
 * @param {number} amount
 * @param {{ guestPhone?: string, guestName?: string }} [meta]
 */
export function recordGiftAndGetLink(amount, meta = {}) {
  const value = Math.floor(Number(amount));
  if (!Number.isFinite(value) || value < 1) {
    throw Object.assign(new Error('Amount must be a positive integer'), { status: 400 });
  }
  if (value > 15000) {
    throw Object.assign(new Error('Amount cannot exceed 15000'), { status: 400 });
  }

  const state = readPaymentState();
  const active = resolveActiveLink(state);
  const link = state.links.find((l) => l.id === active.id);
  if (!link) {
    throw Object.assign(new Error('No payment link available'), { status: 500 });
  }

  link.currentSum += value;
  state.history.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    linkId: link.id,
    amount: value,
    source: 'guest',
    note: [meta.guestName, meta.guestPhone].filter(Boolean).join(' · ') || undefined,
  });
  if (state.history.length > 200) {
    state.history = state.history.slice(-200);
  }

  writePaymentState(state);
  const status = getPaymentStatus(state);

  return {
    url: link.url,
    linkId: link.id,
    label: link.label,
    provider: link.provider,
    amount: value,
    status,
  };
}

/**
 * @param {'auto' | 'manual'} mode
 * @param {string | null} [manualLinkId]
 */
export function setRoutingMode(mode, manualLinkId = null) {
  const state = readPaymentState();
  if (mode === 'manual') {
    if (!manualLinkId || !state.links.some((l) => l.id === manualLinkId)) {
      throw Object.assign(new Error('Valid manualLinkId is required for manual mode'), { status: 400 });
    }
    state.mode = 'manual';
    state.manualLinkId = manualLinkId;
  } else {
    state.mode = 'auto';
    state.manualLinkId = null;
  }
  writePaymentState(state);
  return getPaymentStatus(state);
}

/**
 * @param {string} linkId
 * @param {{ threshold?: number, currentSum?: number, url?: string, label?: string }} updates
 */
export function updateLink(linkId, updates = {}) {
  const state = readPaymentState();
  const link = state.links.find((l) => l.id === linkId);
  if (!link) {
    throw Object.assign(new Error('Link not found'), { status: 404 });
  }

  if (updates.threshold !== undefined) {
    const threshold = Math.floor(Number(updates.threshold));
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw Object.assign(new Error('threshold must be a non-negative integer'), { status: 400 });
    }
    link.threshold = threshold;
  }

  if (updates.currentSum !== undefined) {
    const currentSum = Math.floor(Number(updates.currentSum));
    if (!Number.isFinite(currentSum) || currentSum < 0) {
      throw Object.assign(new Error('currentSum must be a non-negative integer'), { status: 400 });
    }
    link.currentSum = currentSum;
  }

  if (typeof updates.url === 'string' && updates.url.trim()) {
    link.url = updates.url.trim();
  }

  if (typeof updates.label === 'string' && updates.label.trim()) {
    link.label = updates.label.trim();
  }

  state.history.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    linkId: link.id,
    amount: 0,
    source: 'admin-edit',
    note: `Updated: threshold=${link.threshold}, currentSum=${link.currentSum}`,
  });
  if (state.history.length > 200) {
    state.history = state.history.slice(-200);
  }

  writePaymentState(state);
  return getPaymentStatus(state);
}

/**
 * Manually add (or subtract with negative) amount to a link.
 * @param {string} linkId
 * @param {number} amount
 * @param {string} [note]
 */
export function adjustLinkSum(linkId, amount, note = '') {
  const value = Math.floor(Number(amount));
  if (!Number.isFinite(value) || value === 0) {
    throw Object.assign(new Error('amount must be a non-zero integer'), { status: 400 });
  }

  const state = readPaymentState();
  const link = state.links.find((l) => l.id === linkId);
  if (!link) {
    throw Object.assign(new Error('Link not found'), { status: 404 });
  }

  link.currentSum = Math.max(0, link.currentSum + value);
  state.history.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    linkId: link.id,
    amount: value,
    source: 'admin-adjust',
    note: note || undefined,
  });
  if (state.history.length > 200) {
    state.history = state.history.slice(-200);
  }

  writePaymentState(state);
  return getPaymentStatus(state);
}
