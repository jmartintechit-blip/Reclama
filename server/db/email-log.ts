import type { Db } from './client.ts';

// One row per email being sent or sent, unique per (user, key): inserting the row IS the claim on
// the key, so two requests with the same key can never both send. Db has no transactions, and a
// single insert with `on conflict do nothing` is atomic.

// True when this call took the key; false when the user already has it.
export async function claimEmailKey(
  db: Db,
  userId: string,
  key: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `insert into email_log (user_id, idempotency_key) values ($1, $2)
     on conflict do nothing returning idempotency_key`,
    [userId, key],
  );
  return rows.length === 1;
}

// Gives the key back after a send that failed, so the same key can be tried again.
export async function releaseEmailKey(
  db: Db,
  userId: string,
  key: string,
): Promise<void> {
  await db.query(
    'delete from email_log where user_id = $1 and idempotency_key = $2',
    [userId, key],
  );
}
