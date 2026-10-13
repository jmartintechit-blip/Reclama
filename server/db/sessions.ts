import type { Db } from './client.ts';

export interface SessionUser {
  id: string;
  email: string | null; // demo users have no email
  is_demo: boolean;
}

export async function createSession(
  db: Db,
  tokenHash: Buffer,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  await db.query(
    'insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)',
    [tokenHash, userId, expiresAt.toISOString()],
  );
}

// A session that expires exactly at `now` is already expired. `now` comes from the injected
// clock, never from the database, so tests can move time.
export async function findSessionUser(
  db: Db,
  tokenHash: Buffer,
  now: Date,
): Promise<SessionUser | null> {
  const { rows } = await db.query(
    `select u.id, u.email, u.is_demo
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > $2`,
    [tokenHash, now.toISOString()],
  );
  return (rows[0] as SessionUser | undefined) ?? null;
}

// Deletes exactly one row: the other sessions of the same user stay valid.
export async function deleteSession(db: Db, tokenHash: Buffer): Promise<void> {
  await db.query('delete from sessions where token_hash = $1', [tokenHash]);
}
