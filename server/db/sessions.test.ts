import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateToken, hashToken } from '../auth/session.ts';
import { createSession, findSessionUser } from './sessions.ts';
import { createTestDb, type TestDb } from './test-db.ts';
import { createUserWithProfile } from './users.ts';

const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-10-18T10:00:00Z');
const at = (ms: number) => new Date(START + ms);

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);
afterAll(async () => {
  await db.close();
});

async function sessionFor(userId: string, lifetimeMs: number) {
  const tokenHash = hashToken(generateToken());
  await createSession(db, tokenHash, userId, at(lifetimeMs));
  return tokenHash;
}

describe('findSessionUser', () => {
  it('finds the user while the session is alive and refuses it from its expiry on', async () => {
    const user = await createUserWithProfile(db, 'plain@example.com', 'hash');
    const tokenHash = await sessionFor(user?.id ?? '', 2 * HOUR);

    expect(await findSessionUser(db, tokenHash, at(2 * HOUR - 1))).toEqual({
      id: user?.id,
      email: 'plain@example.com',
      is_demo: false,
    });
    expect(await findSessionUser(db, tokenHash, at(2 * HOUR))).toBeNull();
  });

  it('refuses a session of a demo user whose own 24 hours are over, though the session is not', async () => {
    const { rows } = await db.query(
      'insert into users (is_demo, expires_at) values (true, $1) returning id',
      [at(24 * HOUR).toISOString()],
    );
    const { id } = rows[0] as { id: string };
    const tokenHash = await sessionFor(id, 7 * 24 * HOUR);

    expect(await findSessionUser(db, tokenHash, at(24 * HOUR - 1))).toEqual({
      id,
      email: null,
      is_demo: true,
    });
    expect(await findSessionUser(db, tokenHash, at(24 * HOUR))).toBeNull(); // exactly at expiry
    expect(await findSessionUser(db, tokenHash, at(25 * HOUR))).toBeNull();
  });

  it('deletes nothing when it refuses', async () => {
    const { rows } = await db.query(
      'insert into users (is_demo, expires_at) values (true, $1) returning id',
      [at(HOUR).toISOString()],
    );
    const { id } = rows[0] as { id: string };
    const tokenHash = await sessionFor(id, 7 * 24 * HOUR);

    expect(await findSessionUser(db, tokenHash, at(2 * HOUR))).toBeNull();

    const kept = await db.query(
      'select (select count(*) from sessions where user_id = $1)::int as sessions, (select count(*) from users where id = $1)::int as users',
      [id],
    );
    expect(kept.rows).toEqual([{ sessions: 1, users: 1 }]);
  });

  it('never refuses a real user for its own expiry (it has none)', async () => {
    const user = await createUserWithProfile(db, 'real@example.com', 'hash');
    const tokenHash = await sessionFor(user?.id ?? '', 400 * 24 * HOUR);

    expect(
      await findSessionUser(db, tokenHash, at(300 * 24 * HOUR)),
    ).not.toBeNull();
  });
});
