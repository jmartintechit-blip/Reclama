import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseRates, type LegalRate } from '../domain/rates.ts';
import { seedRates } from './rates-seed.ts';
import { createTestDb, type TestDb } from './test-db.ts';

const FILE = new URL('../../data/legal-interest-rates.json', import.meta.url);
const rows = parseRates(JSON.parse(readFileSync(FILE, 'utf8')));
const last = rows.length - 1;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 30_000);
afterAll(async () => {
  await db.close();
});
// seedRates commits its own transaction, so each test starts from an empty table.
beforeEach(async () => {
  await db.query('delete from legal_interest_rates');
});

const table = async () =>
  (await db.query('select * from legal_interest_rates order by semester_start'))
    .rows;

describe('seedRates', () => {
  it('inserts the 18 rows of the file (the database CHECKs accept them)', async () => {
    await seedRates(db, rows);
    const stored = await table();
    expect(stored).toHaveLength(18);
    expect(stored.at(-1)).toMatchObject({
      semester_start: '2026-07-01',
      semester_end: '2026-12-31',
      rate_bp: 1040,
      boe_ref: 'BOE-A-2026-14327',
      published_on: '2026-07-01',
      status: 'VERIFIED',
    });
  });

  it('is idempotent: a second run changes nothing', async () => {
    await seedRates(db, rows);
    const before = await table();
    await seedRates(db, rows);
    expect(await table()).toEqual(before);
  });

  it('updates a row that changed in the file', async () => {
    await seedRates(db, rows);
    const changed: LegalRate[] = rows.map((row, i) =>
      i === last ? { ...row, ecb_mro_bp: 250, rate_bp: 1050 } : row,
    );
    await seedRates(db, changed);
    const stored = await table();
    expect(stored).toHaveLength(18);
    expect(stored.at(-1)).toMatchObject({ ecb_mro_bp: 250, rate_bp: 1050 });
  });

  it('writes nothing when one row is rejected by the database', async () => {
    const broken: LegalRate[] = rows.map((row, i) =>
      i === last ? { ...row, rate_bp: 1 } : row,
    );
    await expect(seedRates(db, broken)).rejects.toThrow();
    expect(await table()).toEqual([]);
  });
});
