import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRates } from '../domain/rates.ts';
import { listVerifiedRates } from './rates.ts';
import { seedRates } from './rates-seed.ts';
import { createTestDb, type TestDb } from './test-db.ts';

const FILE = new URL('../../data/legal-interest-rates.json', import.meta.url);
const rows = parseRates(JSON.parse(readFileSync(FILE, 'utf8')) as unknown);

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seedRates(db, rows);
}, 30_000);
afterAll(async () => {
  await db.close();
});

describe('listVerifiedRates', () => {
  it('returns the verified rows, oldest first, and leaves out a PENDING one', async () => {
    await db.query(
      `insert into legal_interest_rates
         (semester_start, semester_end, rate_bp, ecb_mro_bp, spread_bp, status)
       values ('2027-01-01', '2027-06-30', 1040, 240, 800, 'PENDING')`,
    );

    const rates = await listVerifiedRates(db);

    expect(rates).toHaveLength(18);
    expect(rates[0]?.semester_start).toBe('2018-01-01');
    expect(rates.at(-1)).toEqual({
      semester_start: '2026-07-01',
      semester_end: '2026-12-31',
      rate_bp: 1040,
      ecb_mro_bp: 240,
      spread_bp: 800,
      boe_ref: 'BOE-A-2026-14327',
      published_on: '2026-07-01',
      status: 'VERIFIED',
    });
  });
});
