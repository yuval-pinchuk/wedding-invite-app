import fs from 'fs';
import path from 'path';
import { query } from '../db/pool.js';

/**
 * Restore Baileys multi-file auth from Neon into a local cache directory.
 * Neon is source of truth across host restarts.
 */
export async function restoreWaAuthFromNeon(accountId, senderKey, dir) {
  if (!accountId || !senderKey) return;
  const result = await query(
    `SELECT file_name, content FROM wa_auth_files
     WHERE account_id = $1 AND sender_key = $2`,
    [accountId, senderKey],
  );
  if (!result.rows.length) return;

  await fs.promises.mkdir(dir, { recursive: true });
  for (const row of result.rows) {
    const name = String(row.file_name || '').trim();
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
    const buf = row.content;
    if (!buf) continue;
    await fs.promises.writeFile(path.join(dir, name), buf);
  }
}

/** Sync local Baileys auth directory to Neon (upsert files, drop removed). */
export async function syncWaAuthToNeon(accountId, senderKey, dir) {
  if (!accountId || !senderKey) return;

  if (!fs.existsSync(dir)) {
    await query('DELETE FROM wa_auth_files WHERE account_id = $1 AND sender_key = $2', [accountId, senderKey]);
    return;
  }

  const names = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name || name.includes('..')) continue;
    names.push(name);
    const content = await fs.promises.readFile(path.join(dir, name));
    await query(
      `INSERT INTO wa_auth_files (account_id, sender_key, file_name, content, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (account_id, sender_key, file_name)
       DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
      [accountId, senderKey, name, content],
    );
  }

  if (!names.length) {
    await query('DELETE FROM wa_auth_files WHERE account_id = $1 AND sender_key = $2', [accountId, senderKey]);
    return;
  }

  await query(
    `DELETE FROM wa_auth_files
     WHERE account_id = $1 AND sender_key = $2
       AND NOT (file_name = ANY($3::text[]))`,
    [accountId, senderKey, names],
  );
}

export async function deleteWaAuthFromNeon(accountId, senderKey) {
  if (!accountId || !senderKey) return;
  await query('DELETE FROM wa_auth_files WHERE account_id = $1 AND sender_key = $2', [accountId, senderKey]);
}
