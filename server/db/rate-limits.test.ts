import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../domain/dates.ts';
import type { Db } from './client.ts';
import { hashKeyPart, hitRateLimit, refundRateLimit } from './rate-limits.ts';
import { createTestDb, type TestDb } from './test-db.ts';

const START = Date.parse('2026-10-14T10:00:00Z'); // exactly at the start of a 15 minute window
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

let nowMs = START;
const clock: Clock = { now: () => new Date(nowMs) };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  nowMs = START;
  await db.query('delete from rate_limits');
});

const hit = (key: string, limit = 3, windowSeconds = 15 * 60, using: Db = db) =>
  hitRateLimit(using, clock, { key, limit, windowSeconds });

describe('hitRateLimit', () => {
  it('allows exactly `limit` hits per window and refuses the next ones', async () => {
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push((await hit('k')).allowed);

    expect(answers).toEqual([true, true, true, false, false]);
    const { rows } = await db.query('select hits from rate_limits');
    expect(rows).toEqual([{ hits: 5 }]); // refused hits are counted too
  });

  it('reports the seconds until the window ends, as an integer of at least 1', async () => {
    nowMs = START + 5 * MINUTE + 30_000; // 5 min 30 s into the window

    expect((await hit('k')).retryAfterSeconds).toBe(9 * 60 + 30);

    nowMs = START + 15 * MINUTE - 1; // one millisecond before the next window
    expect((await hit('k')).retryAfterSeconds).toBe(1);

    nowMs = START + 15 * MINUTE; // the next window has just started
    expect((await hit('k')).retryAfterSeconds).toBe(15 * 60);
  });

  it('starts a fresh count when the window rolls over, keeping the old row', async () => {
    for (let i = 0; i < 4; i += 1) await hit('k');
    expect((await hit('k')).allowed).toBe(false);

    nowMs = START + 15 * MINUTE; // the window is [start, start + 15 min)
    expect((await hit('k')).allowed).toBe(true);

    const { rows } = await db.query(
      'select hits from rate_limits order by window_start',
    );
    expect(rows).toEqual([{ hits: 5 }, { hits: 1 }]);
  });

  it('keeps the same window for the whole interval, wherever it is entered', async () => {
    nowMs = START + 14 * MINUTE + 59_000;
    await hit('k');
    nowMs = START + 1000;
    await hit('k');

    const { rows } = await db.query('select hits from rate_limits');
    expect(rows).toEqual([{ hits: 2 }]);
  });

  it('counts every key on its own', async () => {
    for (let i = 0; i < 4; i += 1) await hit('ip-a:email-1');

    expect((await hit('ip-a:email-1')).allowed).toBe(false);
    expect((await hit('ip-a:email-2')).allowed).toBe(true);
    expect((await hit('ip-b:email-1')).allowed).toBe(true);
  });

  it('uses one statement per hit, plus one cleanup only when a window opens', async () => {
    const statements: string[] = [];
    const spy: Db = {
      query: (sql, params) => {
        statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
        return db.query(sql, params);
      },
    };

    await hit('k', 3, 900, spy);
    await hit('k', 3, 900, spy);

    expect(statements).toEqual(['insert into', 'delete from', 'insert into']);
  });

  it('deletes windows older than 2 days when a new window opens, and only those', async () => {
    const insertOld = (key: string, ageMs: number) =>
      db.query(
        'insert into rate_limits (key, window_start, hits) values ($1, $2, 1)',
        [key, new Date(START - ageMs).toISOString()],
      );
    await insertOld('three-days', 3 * DAY);
    await insertOld('just-over-two-days', 2 * DAY + MINUTE);
    await insertOld('one-day', DAY);

    await hit('fresh');

    const { rows } = await db.query('select key from rate_limits order by key');
    expect(rows).toEqual([{ key: 'fresh' }, { key: 'one-day' }]);
  });

  it('does not run the cleanup on later hits of the same window', async () => {
    await hit('k');
    await db.query(
      'insert into rate_limits (key, window_start, hits) values ($1, $2, 1)',
      ['old', new Date(START - 5 * DAY).toISOString()],
    );

    await hit('k');

    const { rows } = await db.query(
      "select count(*) as n from rate_limits where key = 'old'",
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('fails closed: a database error is thrown, never turned into "allowed"', async () => {
    const broken: Db = {
      query: () => Promise.reject(new Error('connection refused')),
    };

    await expect(hit('k', 3, 900, broken)).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('refundRateLimit', () => {
  const refund = (key: string, windowSeconds = 15 * 60) =>
    refundRateLimit(db, clock, { key, limit: 3, windowSeconds });
  const hitsOf = async (key: string) =>
    (
      await db.query('select hits from rate_limits where key = $1', [key])
    ).rows.map((row) => row.hits);

  it('gives back one hit, so the freed place can be used again', async () => {
    for (let i = 0; i < 3; i += 1) await hit('k');
    expect(await hitsOf('k')).toEqual([3]);

    await refund('k');

    expect(await hitsOf('k')).toEqual([2]);
    expect((await hit('k')).allowed).toBe(true);
    expect((await hit('k')).allowed).toBe(false); // control: the limit itself is unchanged
  });

  it('never goes below zero: the last hit removes the row and a missing row stays missing', async () => {
    await hit('k');

    await refund('k');
    expect(await hitsOf('k')).toEqual([]);

    await refund('k'); // nothing to give back
    await refund('never-hit');
    expect(await hitsOf('k')).toEqual([]);
    expect((await hit('k')).allowed).toBe(true);
    expect(await hitsOf('k')).toEqual([1]);
  });

  it('uses the same window as hitRateLimit and leaves the other windows and keys alone', async () => {
    await hit('k');
    await hit('other');
    nowMs = START + 15 * MINUTE;
    await hit('k');
    await hit('k');

    await refund('k'); // the current window only

    const { rows } = await db.query(
      'select key, hits from rate_limits order by key, window_start',
    );
    expect(rows).toEqual([
      { key: 'k', hits: 1 },
      { key: 'k', hits: 1 },
      { key: 'other', hits: 1 },
    ]);
  });

  it('fails loudly on a database error', async () => {
    const broken: Db = {
      query: () => Promise.reject(new Error('connection refused')),
    };

    await expect(
      refundRateLimit(broken, clock, {
        key: 'k',
        limit: 3,
        windowSeconds: 900,
      }),
    ).rejects.toThrow('connection refused');
  });
});

describe('hashKeyPart', () => {
  it('is the SHA-256 in hex, so the raw value never reaches the table', () => {
    expect(hashKeyPart('ana@example.com')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKeyPart('ana@example.com')).not.toContain('ana');
    expect(hashKeyPart('a')).toBe(
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    );
  });
});
