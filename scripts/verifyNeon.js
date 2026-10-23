/**
 * Smoke-test Neon connectivity + schema.
 * Usage: DATABASE_URL=... node scripts/verifyNeon.js
 */
import '../server/config/loadEnv.js';
import { migrate } from '../server/db/migrate.js';
import { query, closePool } from '../server/db/pool.js';
import { listAccounts, findAccountByEmail } from '../server/services/accounts.js';
import { createSession, destroySessionToken } from '../server/services/sessions.js';

async function main() {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    throw new Error('Set DATABASE_URL to your Neon connection string first');
  }
  await migrate();
  const accounts = await listAccounts();
  console.log(`[verify] accounts in db: ${accounts.length}`);
  if (accounts[0]) {
    const token = await createSession(accounts[0]);
    console.log('[verify] created session ok');
    await destroySessionToken(token);
    console.log('[verify] destroyed session ok');
    const again = await findAccountByEmail(accounts[0].email);
    console.log('[verify] find by email ok:', Boolean(again));
  }
  const payments = await query('SELECT COUNT(*)::int AS n FROM payment_states');
  console.log(`[verify] payment_states: ${payments.rows[0].n}`);
  console.log('[verify] success');
  await closePool();
}

main().catch(async (error) => {
  console.error('[verify] failed:', error.message || error);
  try { await closePool(); } catch { /* ignore */ }
  process.exit(1);
});
