import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ISODate } from './dates.ts';
import {
  parseRates,
  verifiedRates,
  verifyRates,
  type LegalRate,
} from './rates.ts';

const FILE = new URL('../../data/legal-interest-rates.json', import.meta.url);
const json: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
const rows = parseRates(json);

const date = (text: string) => text as ISODate;
const rowAt = (start: string): LegalRate => {
  const row = rows.find((r) => r.semester_start === start);
  if (row === undefined) throw new Error(`No row for ${start}`);
  return row;
};
// A copy of the real table with one row replaced by a modified version.
const withRow = (index: number, patch: Partial<LegalRate>): LegalRate[] =>
  rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
const without = (index: number): LegalRate[] =>
  rows.filter((_, i) => i !== index);

describe('the real rate table (data/legal-interest-rates.json)', () => {
  it('has 18 rows, contiguous from 2018-01-01 to 2026-12-31', () => {
    expect(rows).toHaveLength(18);
    expect(rows[0]?.semester_start).toBe('2018-01-01');
    expect(rows.at(-1)?.semester_end).toBe('2026-12-31');
    expect(verifyRates(rows)).toEqual([]);
  });

  it('has rate = ecb + 800 and every row VERIFIED', () => {
    for (const row of rows) {
      expect(row.spread_bp).toBe(800);
      expect(row.rate_bp).toBe(row.ecb_mro_bp + 800);
      expect(row.status).toBe('VERIFIED');
    }
  });

  it('has well-formed and unique BOE references', () => {
    const refs = rows.map((row) => row.boe_ref);
    for (const ref of refs) expect(ref).toMatch(/^BOE-A-\d{4}-\d+$/);
    expect(new Set(refs).size).toBe(18);
  });

  it('keeps the values of the BOE resolutions', () => {
    expect(rowAt('2018-01-01').rate_bp).toBe(800);
    expect(rowAt('2023-01-01').rate_bp).toBe(1050);
    expect(rowAt('2024-01-01').rate_bp).toBe(1250);
    expect(rowAt('2025-01-01').rate_bp).toBe(1115);
    expect(rowAt('2026-01-01').rate_bp).toBe(1015);
    expect(rowAt('2026-07-01')).toMatchObject({
      rate_bp: 1040,
      ecb_mro_bp: 240,
      boe_ref: 'BOE-A-2026-14327',
      published_on: '2026-07-01',
    });
  });
});

describe('verifyRates', () => {
  it('accepts a PENDING row that has no BOE reference yet', () => {
    const pending = withRow(17, {
      boe_ref: null,
      published_on: null,
      status: 'PENDING',
    });
    expect(verifyRates(pending)).toEqual([]);
  });

  it('reports an empty table', () => {
    expect(verifyRates([])).toEqual([expect.stringMatching(/empty/)]);
  });

  it('reports a gap between two semesters', () => {
    expect(verifyRates(without(5))).toEqual([expect.stringMatching(/gap/)]);
  });

  it('reports an overlap', () => {
    const problems = verifyRates(
      withRow(3, { semester_end: date('2020-03-31') }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/overlaps/)]),
    );
  });

  it('reports a wrong semester_end', () => {
    expect(
      verifyRates(withRow(3, { semester_end: date('2019-06-29') })),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/semester_end/)]));
  });

  it('reports rate_bp that is not ecb + spread', () => {
    const problems = verifyRates(withRow(12, { rate_bp: 1251 }));
    expect(problems).toEqual([expect.stringMatching(/not ecb_mro_bp/)]);
  });

  it('reports a spread different from the 8 points of the law', () => {
    const problems = verifyRates(
      withRow(12, { spread_bp: 700, rate_bp: 1150 }),
    );
    expect(problems).toEqual([expect.stringMatching(/spread_bp/)]);
  });

  it('reports a malformed boe_ref', () => {
    const problems = verifyRates(withRow(2, { boe_ref: 'BOE-B-2018-17661' }));
    expect(problems).toEqual([expect.stringMatching(/invalid boe_ref/)]);
  });

  it('reports a duplicate boe_ref', () => {
    const problems = verifyRates(withRow(1, { boe_ref: rows[0]?.boe_ref }));
    expect(problems).toEqual([expect.stringMatching(/duplicate boe_ref/)]);
  });

  it('reports a VERIFIED row without published_on', () => {
    const problems = verifyRates(withRow(4, { published_on: null }));
    expect(problems).toEqual([expect.stringMatching(/needs boe_ref/)]);
  });

  it('reports a semester that does not start on 1 January or 1 July', () => {
    const problems = verifyRates(
      withRow(6, {
        semester_start: date('2021-02-01'),
        semester_end: date('2021-07-31'),
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/1 January or 1 July/)]),
    );
  });

  it('reports a duplicated semester', () => {
    const problems = verifyRates([...rows, rowAt('2020-07-01')]);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/duplicate semester_start/),
      ]),
    );
  });
});

describe('verifiedRates', () => {
  it('drops PENDING rows (they count as absent)', () => {
    const pending = withRow(17, {
      boe_ref: null,
      published_on: null,
      status: 'PENDING',
    });
    expect(verifiedRates(rows)).toHaveLength(18);
    expect(verifiedRates(pending)).toEqual(rows.slice(0, 17));
  });
});

describe('parseRates', () => {
  const valid = {
    semester_start: '2026-07-01',
    semester_end: '2026-12-31',
    rate_bp: 1040,
    ecb_mro_bp: 240,
    spread_bp: 800,
    boe_ref: 'BOE-A-2026-14327',
    published_on: '2026-07-01',
    status: 'VERIFIED',
  };

  it('accepts a valid row', () => {
    expect(parseRates([valid])).toEqual([valid]);
  });

  it.each([
    ['not an array', valid],
    ['a row that is not an object', [42]],
    ['a float rate', [{ ...valid, rate_bp: 10.4 }]],
    ['a rate given as text', [{ ...valid, rate_bp: '1040' }]],
    ['an impossible date', [{ ...valid, semester_start: '2026-02-30' }]],
    ['a missing published_on', [{ ...valid, published_on: undefined }]],
    ['an unknown status', [{ ...valid, status: 'DRAFT' }]],
    ['an unexpected field', [{ ...valid, note: 'x' }]],
  ])('rejects %s', (_name, input) => {
    expect(() => parseRates(input)).toThrow();
  });
});
