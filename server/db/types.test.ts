import { types } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from './client.ts';
import { createTestDb, type TestDb } from './test-db.ts';
import { parseDate, parseInt8 } from './types.ts';

const { INT8, DATE, TIMESTAMPTZ } = types.builtins;

describe('parseInt8', () => {
  it.each([
    ['0', 0],
    ['5', 5],
    ['-5', -5],
    ['100000000000', 100_000_000_000],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['-9007199254740991', Number.MIN_SAFE_INTEGER],
  ])('turns %s into the number %d', (text, expected) => {
    expect(parseInt8(text)).toBe(expected);
  });

  it.each([
    '9007199254740992', // 2^53: the first one a number cannot tell apart from its neighbour
    '9007199254740993',
    '9223372036854775807', // the biggest int8
    '-9007199254740992',
    '-9223372036854775808',
  ])('throws for %s, outside the safe range', (text) => {
    expect(() => parseInt8(text)).toThrow(RangeError);
  });
});

describe('parseDate', () => {
  it('keeps the text as it is', () => {
    expect(parseDate('2026-02-28')).toBe('2026-02-28');
  });
});

// The same checks go through both drivers. pg is tested through the `types` option that
// createPool really sets (no connection is opened); PGlite through a real query.
describe('both drivers return the same JS types', () => {
  let db: TestDb;
  const pool = createPool('postgres://user:secret@localhost:5432/db');
  const pgParse = (oid: typeof INT8, text: string): unknown => {
    const parser: unknown = pool.options.types?.getTypeParser(oid, 'text');
    if (typeof parser !== 'function') {
      throw new Error('createPool did not set `types`');
    }
    return (parser as (text: string) => unknown)(text);
  };

  beforeAll(async () => {
    db = await createTestDb();
  }, 30_000);
  afterAll(async () => {
    await db.close();
    await pool.end();
  });

  it.each([
    ['0'],
    ['42'],
    ['-7'],
    ['9007199254740991'], // the biggest safe integer
  ])('int8 %s is a number', async (text) => {
    const { rows } = await db.query(`select ${text}::int8 as v`);
    const fromPglite = rows[0]?.v;

    expect(typeof fromPglite).toBe('number');
    expect(fromPglite).toBe(Number(text));
    expect(pgParse(INT8, text)).toBe(fromPglite);
  });

  it('int8 above 2^53 throws in both, with the same error type', async () => {
    const big = '9007199254740993';

    await expect(db.query(`select ${big}::int8 as v`)).rejects.toThrow(
      'int8 value is outside the safe integer range',
    );
    expect(() => pgParse(INT8, big)).toThrow(
      'int8 value is outside the safe integer range',
    );
  });

  it('int8 also comes back as a number through a query with parameters', async () => {
    const { rows } = await db.query('select $1::int8 as v', [123]);
    expect(rows[0]?.v).toBe(123);
  });

  it.each(['2026-02-28', '2024-02-29', '2026-12-31'])(
    'date %s is the same text, not a Date',
    async (text) => {
      const { rows } = await db.query(`select date '${text}' as v`);

      expect(rows[0]?.v).toBe(text);
      expect(pgParse(DATE, text)).toBe(text);
    },
  );

  it('timestamptz is still a Date for the same instant', async () => {
    const { rows } = await db.query(
      `select timestamptz '2026-01-31 10:00:00+00' as v`,
    );
    const instant = Date.UTC(2026, 0, 31, 10);

    expect(rows[0]?.v).toBeInstanceOf(Date);
    expect((rows[0]?.v as Date).getTime()).toBe(instant);
    const fromPg = pgParse(TIMESTAMPTZ, '2026-01-31 10:00:00+00');
    expect(fromPg).toBeInstanceOf(Date);
    expect((fromPg as Date).getTime()).toBe(instant);
  });
});
