/**
 * One-shot import: JSON files → Neon Postgres.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/migrateJsonToNeon.js
 *
 * Reads from DATA_DIR (or server/data):
 *   - accounts.json
 *   - sessions.json
 *   - payments/<accountId>.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import '../server/config/loadEnv.js';
import { getDataDir } from '../server/config/dataDir.js';
import { migrate } from '../server/db/migrate.js';
import { query, closePool } from '../server/db/pool.js';
import { saveAccount } from '../server/services/accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[migrate] failed to parse ${file}:`, error.message);
    return fallback;
  }
}

async function main() {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    throw new Error('DATABASE_URL is required');
  }

  await migrate();

  const dataDir = getDataDir();
  const accountsFile = path.join(dataDir, 'accounts.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const paymentsDir = path.join(dataDir, 'payments');

  const db = readJson(accountsFile, { accounts: [] });
  const accounts = Array.isArray(db.accounts) ? db.accounts : [];
  console.log(`[migrate] importing ${accounts.length} accounts from ${accountsFile}`);

  for (const account of accounts) {
    await saveAccount({
      ...account,
      columnMap: account.columnMap || {},
      unlockCodeHash: account.unlockCodeHash || '',
      unlockCodeExpires: account.unlockCodeExpires || 0,
      resetTokenHash: account.resetTokenHash || '',
      resetTokenExpires: account.resetTokenExpires || 0,
      invitationMessage: account.invitationMessage || '',
      reminderTemplate: account.reminderTemplate || '',
      inviteImageFile: account.inviteImageFile || '',
      createdAt: account.createdAt || new Date().toISOString(),
    });
  }

  const sessions = readJson(sessionsFile, {});
  let sessionCount = 0;
  const now = Date.now();
  for (const [token, row] of Object.entries(sessions || {})) {
    if (!row?.accountId || !row?.expires || row.expires <= now) continue;
    await query(
      `INSERT INTO sessions (token, account_id, expires_at)
       VALUES ($1, $2, to_timestamp($3 / 1000.0))
       ON CONFLICT (token) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         expires_at = EXCLUDED.expires_at`,
      [token, row.accountId, row.expires],
    );
    sessionCount += 1;
  }
  console.log(`[migrate] imported ${sessionCount} sessions`);

  let paymentCount = 0;
  if (fs.existsSync(paymentsDir)) {
    for (const name of fs.readdirSync(paymentsDir)) {
      if (!name.endsWith('.json')) continue;
      const accountId = name.replace(/\.json$/, '');
      const state = readJson(path.join(paymentsDir, name), null);
      if (!state) continue;
      await query(
        `INSERT INTO payment_states (account_id, state, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (account_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
        [accountId, JSON.stringify(state)],
      );
      paymentCount += 1;
    }
  }

  const legacyPayment = path.join(dataDir, 'payment-routing.json');
  const altLegacy = path.join(__dirname, '..', 'server', 'data', 'payment-routing.json');
  for (const file of [legacyPayment, altLegacy]) {
    if (!fs.existsSync(file) || !accounts[0]?.id) continue;
    const state = readJson(file, null);
    if (!state) continue;
    const exists = await query('SELECT 1 FROM payment_states WHERE account_id = $1', [accounts[0].id]);
    if (exists.rows.length) continue;
    await query(
      `INSERT INTO payment_states (account_id, state, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (account_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [accounts[0].id, JSON.stringify(state)],
    );
    paymentCount += 1;
    console.log(`[migrate] imported legacy payment file for ${accounts[0].id}`);
  }

  console.log(`[migrate] imported ${paymentCount} payment state files`);
  console.log('[migrate] done');
  await closePool();
}

main().catch(async (error) => {
  console.error('[migrate] failed:', error);
  try {
    await closePool();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
