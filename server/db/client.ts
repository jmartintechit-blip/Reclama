import { Pool } from 'pg';
import { pgTypes } from './types.ts';

// Pool settings for a serverless Function that talks to Neon through its pooler:
// - max 3: one Function instance handles one request at a time and a request needs one
//   connection (two if it overlaps a transaction with a read). Every warm instance has its own
//   pool, so a big `max` would only multiply the connections Neon Free has to serve.
// - 5 s timeouts: fail fast instead of hanging until the Function times out.
// - idle 10 s: a frozen Function can wake up with sockets Neon has already closed, so we do
//   not keep idle connections around for long.
// TLS is not set here: `sslmode=require` in the connection string turns it on with certificate
// verification. The connection string is a secret and is never logged.
export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    idleTimeoutMillis: 10_000,
    types: pgTypes, // int8 as number, date as text (see types.ts)
  });

  // An error on an idle client with no listener would crash the process. As in the error
  // handler, we log only the error name: messages can contain host names or user data.
  pool.on('error', (error) => {
    console.error(JSON.stringify({ level: 'error', error_name: error.name }));
  });

  return pool;
}

// What the app needs from the database. A pg.Pool satisfies it, and tests pass a fake.
export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

// Same rule as scripts/migrate.ts. Without a valid URL the app still starts (liveness must work),
// and every query fails, which /api/health/ready reports as "not ready". The URL is never logged.
export function createDbFromEnv(env: NodeJS.ProcessEnv): Db {
  const url = env.DATABASE_URL;
  if (url?.startsWith('postgres://') || url?.startsWith('postgresql://')) {
    return createPool(url); // a Pool connects on the first query, not here
  }
  return {
    query: () => Promise.reject(new Error('DATABASE_URL is not configured')),
  };
}
