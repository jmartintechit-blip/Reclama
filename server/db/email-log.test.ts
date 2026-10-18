import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimEmailKey, releaseEmailKey } from './email-log.ts';
import { createTestDb, type TestDb } from './test-db.ts';
import { createUserWithProfile } from './users.ts';

let db: TestDb;
let userA: string;
let userB: string;

beforeAll(async () => {
  db = await createTestDb();
  userA = (await createUserWithProfile(db, 'a@example.com', 'hash'))?.id ?? '';
  userB = (await createUserWithProfile(db, 'b@example.com', 'hash'))?.id ?? '';
}, 30_000);
afterAll(async () => {
  await db.close();
});

describe('the email key claim', () => {
  it('is taken once per user and key', async () => {
    expect(await claimEmailKey(db, userA, 'key-1')).toBe(true);
    expect(await claimEmailKey(db, userA, 'key-1')).toBe(false);
    expect(await claimEmailKey(db, userA, 'key-2')).toBe(true);
  });

  it('is separate for each user', async () => {
    expect(await claimEmailKey(db, userA, 'shared')).toBe(true);
    expect(await claimEmailKey(db, userB, 'shared')).toBe(true);
  });

  it('can be taken again after it is released, and releasing touches only that user and key', async () => {
    await claimEmailKey(db, userA, 'released');
    await claimEmailKey(db, userB, 'released');

    await releaseEmailKey(db, userA, 'released');

    expect(await claimEmailKey(db, userA, 'released')).toBe(true);
    expect(await claimEmailKey(db, userB, 'released')).toBe(false);
  });
});
