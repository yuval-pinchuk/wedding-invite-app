import pg from 'pg';

const { Pool } = pg;

let pool = null;

function stripQuotes(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

/** App traffic: prefer Neon's pooled DATABASE_URL. */
export function getDatabaseUrl() {
  return stripQuotes(process.env.DATABASE_URL);
}

/** Migrations / admin: prefer direct (unpooled) connection. */
export function getMigrationDatabaseUrl() {
  return stripQuotes(process.env.DATABASE_URL_UNPOOLED) || getDatabaseUrl();
}

function createPool(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required (Neon Postgres connection string)');
  }
  return new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000,
  });
}

export function getPool() {
  if (pool) return pool;
  pool = createPool(getDatabaseUrl());
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

/** One-off client on the direct (unpooled) URL — use for schema migrations. */
export async function withMigrationClient(fn) {
  const client = new pg.Client({
    connectionString: getMigrationDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}
