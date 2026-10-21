/**
 * Payment routing between personal Bit / PayBox links.
 * Persists totals and thresholds in server/data/payment-routing.json.
 *
 * Note: personal Bit/PayBox links do not notify this app when payment completes.
 * Guest "pay" clicks record an intent amount against the active link; admins can correct totals.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { getDataDir } from '../config/dataDir.js';
import { currentAccount } from './accountContext.js';

function paymentFilePath() {
  const account = currentAccount();
  const root = getDataDir();
  if (account?.id) {
    const dir = path.join(root, 'payments');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${account.id}.json`);
  }
  return path.join(root, 'payment-routing.json');
}

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
        url: 'https://links.payboxapp.com/4Yn6uDXwWUb',
        threshold: 20000,
        currentSum: 0,
      },
      {
        id: 'yuval-paybox',
        label: "Yuval's PayBox",
        provider: 'paybox',
        owner: 'yuval',
        url: 'https://links.payboxapp.com/AdfUleihXUb',
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
  const file = paymentFilePath();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultState(), null, 2), 'utf8');
  }
}

/** @returns {PaymentState} */
export function readPaymentState() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(paymentFilePath(), 'utf8');
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
  fs.writeFileSync(paymentFilePath(), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * @param {any} raw
 * @param {number} [index]
 * @returns {PaymentLink | null}
 */
function normalizeLink(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim() || `link-${Date.now().toString(36)}-${index}`;
  const provider = String(raw.provider || '').toLowerCase() === 'bit' ? 'bit' : 'paybox';
  const owner = String(raw.owner || '').trim() || 'custom';
  const url = String(raw.url || '').trim();
  const label = String(raw.label || '').trim() || `${provider} ${index + 1}`;
  const threshold = Number.isFinite(Number(raw.threshold))
    ? Math.max(0, Math.floor(Number(raw.threshold)))
    : 10000;
  const currentSum = Number.isFinite(Number(raw.currentSum))
    ? Math.max(0, Math.floor(Number(raw.currentSum)))
    : 0;
  return { id, label, provider, owner, url, threshold, currentSum };
}

/** @param {any} parsed @returns {PaymentState} */
function normalizeState(parsed) {
  const defaults = defaultState();
  const rawLinks = Array.isArray(parsed?.links) ? parsed.links : [];
  let links = rawLinks.map((item, index) => normalizeLink(item, index)).filter(Boolean);
  if (!links.length) {
    links = defaults.links.map((item, index) => normalizeLink(item, index)).filter(Boolean);
  }

  // Deduplicate ids while preserving order
  const seen = new Set();
  links = links.filter((link) => {
    if (seen.has(link.id)) return false;
    seen.add(link.id);
    return true;
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

const BIT_REQUIRED_MIN_AMOUNT = 1000;

/** Auto cascade uses the stored link order (admin can reorder). */
/** @param {PaymentLink[]} links @returns {PaymentLink[]} */
function linksInAutoOrder(links) {
  return Array.isArray(links) ? [...links] : [];
}

function pushHistory(state, entry) {
  state.history.push(entry);
  if (state.history.length > 200) {
    state.history = state.history.slice(-200);
  }
}

function historyId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @param {PaymentLink} link */
function remaining(link) {
  return Math.max(0, link.threshold - link.currentSum);
}

/** @param {PaymentLink} link @param {number} amount */
function linkFitsAmount(link, amount) {
  return link.currentSum + amount <= link.threshold;
}

/** @param {PaymentLink} link @param {number} amount */
function linkEligibleForAmount(link, amount) {
  if (!linkFitsAmount(link, amount)) return false;
  if (amount >= BIT_REQUIRED_MIN_AMOUNT && link.provider !== 'bit') return false;
  return true;
}

/**
 * Pick a link that can accept the given amount without exceeding its threshold.
 * Amounts >= 1000 require a Bit link. Manual mode: prefer the forced link if eligible;
 * otherwise cascade. Auto cascade order: PayBox links first, then Bit links.
 * @param {PaymentState} state
 * @param {number} amount
 * @returns {PaymentLink}
 */
export function resolveLinkForAmount(state, amount) {
  const value = Math.floor(Number(amount));
  if (!Number.isFinite(value) || value < 1) {
    throw Object.assign(new Error('Amount must be a positive integer'), { status: 400 });
  }

  if (state.mode === 'manual' && state.manualLinkId) {
    const forced = state.links.find((l) => l.id === state.manualLinkId);
    if (forced && linkEligibleForAmount(forced, value)) {
      return forced;
    }
  }

  const ordered = linksInAutoOrder(state.links);
  const fitting = ordered.find((l) => linkEligibleForAmount(l, value));
  if (!fitting) {
    const message =
      value >= BIT_REQUIRED_MIN_AMOUNT
        ? 'No Bit payment link can accept this amount right now'
        : 'No payment link can accept this amount right now';
    throw Object.assign(new Error(message), { status: 503 });
  }

  return fitting;
}

/**
 * Auto: first PayBox (then Bit) link that still has capacity.
 * If all are full, falls back to the last link in that same order.
 * Manual: forced link id.
 * @param {PaymentState} [state]
 * @returns {PaymentLink}
 */
export function resolveActiveLink(state = readPaymentState()) {
  if (state.mode === 'manual' && state.manualLinkId) {
    const forced = state.links.find((l) => l.id === state.manualLinkId);
    if (forced) return forced;
  }

  const ordered = linksInAutoOrder(state.links);
  const available = ordered.find((l) => l.currentSum < l.threshold);
  return available || ordered[ordered.length - 1];
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
  const active = resolveLinkForAmount(state, value);
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
 * @param {{ threshold?: number, currentSum?: number, url?: string, label?: string, provider?: string, owner?: string }} updates
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

  if (updates.provider !== undefined) {
    link.provider = String(updates.provider).toLowerCase() === 'bit' ? 'bit' : 'paybox';
  }

  if (typeof updates.owner === 'string' && updates.owner.trim()) {
    link.owner = updates.owner.trim();
  }

  pushHistory(state, {
    id: historyId(),
    timestamp: new Date().toISOString(),
    linkId: link.id,
    amount: 0,
    source: 'admin-edit',
    note: `Updated: ${link.label}`,
  });

  writePaymentState(state);
  return getPaymentStatus(state);
}

/**
 * @param {{ label: string, url: string, provider?: string, owner?: string, threshold?: number }} payload
 */
export function addLink(payload = {}) {
  const state = readPaymentState();
  const label = String(payload.label || '').trim();
  const url = String(payload.url || '').trim();
  if (!label || !url) {
    throw Object.assign(new Error('label and url are required'), { status: 400 });
  }

  const id = `link-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const link = normalizeLink({
    id,
    label,
    url,
    provider: payload.provider,
    owner: payload.owner,
    threshold: payload.threshold,
    currentSum: 0,
  });
  if (!link) {
    throw Object.assign(new Error('Invalid link'), { status: 400 });
  }

  state.links.push(link);
  pushHistory(state, {
    id: historyId(),
    timestamp: new Date().toISOString(),
    linkId: link.id,
    amount: 0,
    source: 'admin-add',
    note: `Added: ${link.label}`,
  });
  writePaymentState(state);
  return getPaymentStatus(state);
}

/** @param {string} linkId */
export function removeLink(linkId) {
  const state = readPaymentState();
  const index = state.links.findIndex((l) => l.id === linkId);
  if (index < 0) {
    throw Object.assign(new Error('Link not found'), { status: 404 });
  }
  if (state.links.length <= 1) {
    throw Object.assign(new Error('Must keep at least one payment link'), { status: 400 });
  }

  const [removed] = state.links.splice(index, 1);
  if (state.manualLinkId === linkId) {
    state.mode = 'auto';
    state.manualLinkId = null;
  }

  pushHistory(state, {
    id: historyId(),
    timestamp: new Date().toISOString(),
    linkId: removed.id,
    amount: 0,
    source: 'admin-remove',
    note: `Removed: ${removed.label}`,
  });
  writePaymentState(state);
  return getPaymentStatus(state);
}

/**
 * @param {string[]} orderedIds
 */
export function reorderLinks(orderedIds) {
  const state = readPaymentState();
  if (!Array.isArray(orderedIds) || orderedIds.length !== state.links.length) {
    throw Object.assign(new Error('orderedIds must include every link id once'), { status: 400 });
  }
  const unique = new Set(orderedIds);
  if (unique.size !== orderedIds.length) {
    throw Object.assign(new Error('orderedIds contains duplicates'), { status: 400 });
  }
  const byId = new Map(state.links.map((l) => [l.id, l]));
  for (const id of orderedIds) {
    if (!byId.has(id)) {
      throw Object.assign(new Error(`Unknown link id: ${id}`), { status: 400 });
    }
  }
  state.links = orderedIds.map((id) => byId.get(id));
  pushHistory(state, {
    id: historyId(),
    timestamp: new Date().toISOString(),
    linkId: state.links[0]?.id || '',
    amount: 0,
    source: 'admin-reorder',
    note: `Order: ${state.links.map((l) => l.label).join(' → ')}`,
  });
  writePaymentState(state);
  return getPaymentStatus(state);
}

/**
 * @param {string} linkId
 * @param {'up' | 'down'} direction
 */
export function moveLink(linkId, direction) {
  const state = readPaymentState();
  const index = state.links.findIndex((l) => l.id === linkId);
  if (index < 0) {
    throw Object.assign(new Error('Link not found'), { status: 404 });
  }
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= state.links.length) {
    return getPaymentStatus(state);
  }
  const next = [...state.links];
  [next[index], next[swapWith]] = [next[swapWith], next[index]];
  return reorderLinks(next.map((l) => l.id));
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

/** Write the four payment links for a new account. */
export function seedPaymentFile(accountId, urls = {}) {
  const dir = path.join(getDataDir(), 'payments');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const state = defaultState();
  const byId = {
    'danielle-paybox': urls.daniellePaybox,
    'yuval-paybox': urls.yuvalPaybox,
    'danielle-bit': urls.danielleBit,
    'yuval-bit': urls.yuvalBit,
  };
  for (const link of state.links) {
    if (byId[link.id]) link.url = String(byId[link.id]).trim();
  }
  fs.writeFileSync(path.join(dir, `${accountId}.json`), JSON.stringify(state, null, 2), 'utf8');
}
