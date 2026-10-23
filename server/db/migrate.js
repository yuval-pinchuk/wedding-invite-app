import { withMigrationClient } from './pool.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  public_token TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  unlock_code_hash TEXT NOT NULL DEFAULT '',
  unlock_code_expires BIGINT NOT NULL DEFAULT 0,
  reset_token_hash TEXT NOT NULL DEFAULT '',
  reset_token_expires BIGINT NOT NULL DEFAULT 0,
  legacy BOOLEAN NOT NULL DEFAULT FALSE,
  bride_name TEXT NOT NULL DEFAULT '',
  groom_name TEXT NOT NULL DEFAULT '',
  wedding_date TEXT NOT NULL DEFAULT '',
  waze_url TEXT NOT NULL DEFAULT '',
  maps_url TEXT NOT NULL DEFAULT '',
  guest_sheet_id TEXT NOT NULL DEFAULT '',
  response_sheet_id TEXT NOT NULL DEFAULT '',
  sheet_tab TEXT NOT NULL DEFAULT '',
  column_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  invitation_message TEXT NOT NULL DEFAULT '',
  reminder_template TEXT NOT NULL DEFAULT '',
  invite_image_file TEXT NOT NULL DEFAULT '',
  baby_max_age INTEGER NOT NULL DEFAULT 6,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_account_id_idx ON sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS payment_states (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rsvp_responses (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_key TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  is_attending BOOLEAN NOT NULL,
  number_of_guests INTEGER NOT NULL DEFAULT 0,
  number_of_babies INTEGER NOT NULL DEFAULT 0,
  number_of_vegan INTEGER NOT NULL DEFAULT 0,
  additional_notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, phone_key)
);

CREATE INDEX IF NOT EXISTS rsvp_responses_account_updated_idx
  ON rsvp_responses (account_id, updated_at DESC);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS baby_max_age INTEGER NOT NULL DEFAULT 6;
`;

export async function migrate() {
  // Neon skill: schema migrations should use the direct (unpooled) connection.
  await withMigrationClient(async (client) => {
    await client.query(SCHEMA_SQL);
  });
  console.log('[db] schema ready');
}
