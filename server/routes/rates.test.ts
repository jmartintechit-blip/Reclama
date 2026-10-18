import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dataOf,
  seedTestRates,
  startTestApp,
  type TestApp,
} from './test-app.ts';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
}, 30_000);
afterAll(async () => {
  await t.stop();
});

interface RatesData {
  rates: Record<string, unknown>[];
  window: { from: string | null; to: string | null };
}

describe('GET /api/rates', () => {
  it('answers without a session with the 18 verified rows, their BOE sources and the window', async () => {
    const res = await t.call(null, 'GET', '/api/rates');

    expect(res.status).toBe(200);
    const data = dataOf(res) as unknown as RatesData;
    expect(data.rates).toHaveLength(18);
    expect(data.window).toEqual({ from: '2018-01-01', to: '2026-12-31' });
    expect(data.rates[0]).toEqual({
      semester_start: '2018-01-01',
      semester_end: '2018-06-30',
      rate_bp: 800,
      ecb_mro_bp: 0,
      spread_bp: 800,
      boe_ref: 'BOE-A-2017-15428',
      boe_url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2017-15428',
      published_on: '2017-12-23',
    });
    // Exact object: no status and no other column leaks.
    expect(data.rates.at(-1)).toEqual({
      semester_start: '2026-07-01',
      semester_end: '2026-12-31',
      rate_bp: 1040,
      ecb_mro_bp: 240,
      spread_bp: 800,
      boe_ref: 'BOE-A-2026-14327',
      boe_url: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-14327',
      published_on: '2026-07-01',
    });
  });

  it('leaves out a PENDING row', async () => {
    await t.db.query(
      `insert into legal_interest_rates
         (semester_start, semester_end, rate_bp, ecb_mro_bp, spread_bp, status)
       values ('2027-01-01', '2027-06-30', 1040, 240, 800, 'PENDING')`,
    );

    const data = dataOf(
      await t.call(null, 'GET', '/api/rates'),
    ) as unknown as RatesData;

    expect(data.rates).toHaveLength(18);
    expect(data.window.to).toBe('2026-12-31');
    await t.db.query(
      "delete from legal_interest_rates where status = 'PENDING'",
    );
  });

  it('reports an empty table with a null window', async () => {
    await t.db.query('delete from legal_interest_rates');

    const data = dataOf(
      await t.call(null, 'GET', '/api/rates'),
    ) as unknown as RatesData;

    expect(data).toEqual({ rates: [], window: { from: null, to: null } });
    await seedTestRates(t.db);
  });
});
