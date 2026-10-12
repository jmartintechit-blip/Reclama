import { Pool } from 'pg';

// Pool settings for a serverless Function that talks to Neon through its pooler:
// - max 3: one Function instance handles one request at a time and a request needs one
//   connection (two if it overlaps a transaction with a read). Every warm instance has its own
//   pool, so a big `max` would only multiply the connections Neon Free has to serve.
// - 5 s timeouts (plan section 5): fail fast instead of hanging until the Function times out.
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
  });

  // An error on an idle client with no listener would crash the process. As in the error
  // handler, we log only the error name: messages can contain host names or user data.
  pool.on('error', (error) => {
    console.error(JSON.stringify({ level: 'error', error_name: error.name }));
  });

  return pool;
}
