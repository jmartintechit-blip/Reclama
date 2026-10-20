import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ISODate } from './dates.ts';
import { isLeapYear } from './dates.ts';
import {
  calculateDefaultInterest,
  RateWindowError,
  type InterestInput,
  type InterestResult,
} from './interest.ts';
import { referenceInterest } from './interest.reference.ts';
import { toCents } from './money.ts';
import { parseRates } from './rates.ts';

const FILE = new URL('../../data/legal-interest-rates.json', import.meta.url);
const rates = parseRates(JSON.parse(readFileSync(FILE, 'utf8')) as unknown);

const date = (text: string) => text as ISODate;

interface Case {
  principal: number;
  issue?: string;
  due: string | null;
  asOf: string;
  payments?: [string, number][];
  agreed?: number | null;
  rates?: InterestInput['rates'];
}

const inputOf = (c: Case): InterestInput => ({
  principal: toCents(c.principal),
  issueDate: date(c.issue ?? '2000-01-01'),
  dueDate: c.due === null ? null : date(c.due),
  asOf: date(c.asOf),
  payments: (c.payments ?? []).map(([paidOn, amount]) => ({
    paidOn: date(paidOn),
    amount: toCents(amount),
  })),
  agreedRateBp: c.agreed ?? null,
  rates: c.rates ?? rates,
});

const calc = (c: Case): InterestResult => calculateDefaultInterest(inputOf(c));

// Runs the reference on the same case and requires exactly the same answer.
function expectSameAsReference(c: Case, result: InterestResult): void {
  const ref = referenceInterest({
    principal: c.principal,
    dueDate: result.dueDate,
    asOf: c.asOf,
    payments: (c.payments ?? []).map(([paidOn, amount]) => ({
      paidOn,
      amount,
    })),
    agreedRateBp: c.agreed ?? null,
    rates: c.rates ?? rates,
  });
  if (!ref.ok) throw new Error('The reference reported a missing rate');
  expect(result.interest).toBe(ref.interest);
  expect(result.segments).toEqual(ref.segments);
}

const interests = (result: InterestResult) =>
  result.segments.map((s) => s.interest);

describe('worked examples, checked against the day-by-day reference', () => {
  const examples: {
    name: string;
    c: Case;
    total: number;
    parts: number[];
  }[] = [
    {
      name: 'E1 one semester, 30 days',
      c: { principal: 100_000, due: '2026-09-30', asOf: '2026-10-30' },
      total: 855,
      parts: [855],
    },
    {
      name: 'E2 H1-2025 at 11.15 %',
      c: { principal: 250_000, due: '2025-02-10', asOf: '2025-03-12' },
      total: 2291,
      parts: [2291],
    },
    {
      name: 'E3 H1 -> H2 2026',
      c: { principal: 1_000_000, due: '2026-06-20', asOf: '2026-07-10' },
      total: 5630,
      parts: [2781, 2849],
    },
    {
      name: 'E4 leap year, 366 days',
      c: { principal: 300_000, due: '2024-02-20', asOf: '2024-03-05' },
      total: 1434,
      parts: [1434],
    },
    {
      name: 'E5 new year, 365 -> 366',
      c: { principal: 5_000_000, due: '2023-12-30', asOf: '2024-01-02' },
      total: 5059,
      parts: [1644, 3415],
    },
    {
      name: 'E6 exact half cent rounds up (73 days)',
      c: { principal: 15_000, due: '2025-01-31', asOf: '2025-04-14' },
      total: 335,
      parts: [335],
    },
    {
      name: 'E7 29 February',
      c: { principal: 100_000, due: '2024-02-28', asOf: '2024-03-01' },
      total: 68,
      parts: [68],
    },
    {
      name: 'E8 semester change in a leap year',
      c: { principal: 1_000_000, due: '2024-06-25', asOf: '2024-07-05' },
      total: 3381,
      parts: [1708, 1673],
    },
    {
      name: 'E9 long case, 8 semesters',
      c: { principal: 1_000_000, due: '2023-01-31', asOf: '2026-10-30' },
      total: 418_941,
      parts: [43_151, 60_493, 62_158, 61_585, 55_292, 51_167, 50_333, 34_762],
    },
    {
      name: 'E10 asOf = due date',
      c: { principal: 100_000, due: '2026-09-30', asOf: '2026-09-30' },
      total: 0,
      parts: [],
    },
    {
      name: 'E11 one cent for 30 days',
      c: { principal: 1, due: '2026-09-30', asOf: '2026-10-30' },
      total: 0,
      parts: [0],
    },
    {
      name: 'E12 partial payment of 400 EUR on 10 Oct',
      c: {
        principal: 100_000,
        due: '2026-09-30',
        asOf: '2026-10-30',
        payments: [['2026-10-10', 40_000]],
      },
      total: 627,
      parts: [285, 342],
    },
  ];

  it.each(examples)('$name', ({ c, total, parts }) => {
    const result = calc(c);
    expect(result.interest).toBe(total);
    expect(interests(result)).toEqual(parts);
    expectSameAsReference(c, result);
  });

  it('E4 differs from the 365-day result (1438)', () => {
    const result = calc({
      principal: 300_000,
      due: '2024-02-20',
      asOf: '2024-03-05',
    });
    expect(result.segments[0]?.yearDays).toBe(366);
    expect(result.interest).not.toBe(1438);
  });

  it('E6 with 72 days gives 330', () => {
    expect(
      calc({ principal: 15_000, due: '2025-01-31', asOf: '2025-04-13' })
        .interest,
    ).toBe(330);
  });

  it('E9 spans 8 segments and 1368 days', () => {
    const result = calc({
      principal: 1_000_000,
      due: '2023-01-31',
      asOf: '2026-10-30',
    });
    expect(result.segments).toHaveLength(8);
    expect(result.segments.reduce((sum, s) => sum + s.days, 0)).toBe(1368);
  });

  it('E12 without the payment is 855', () => {
    expect(
      calc({ principal: 100_000, due: '2026-09-30', asOf: '2026-10-30' })
        .interest,
    ).toBe(855);
  });
});

describe('segments (I2, I3, I4)', () => {
  it('cuts exactly on 30 June / 1 July', () => {
    const { segments } = calc({
      principal: 1_000_000,
      due: '2026-06-20',
      asOf: '2026-07-10',
    });
    expect(segments).toEqual([
      {
        start: '2026-06-21',
        end: '2026-06-30',
        days: 10,
        yearDays: 365,
        rateBp: 1015,
        balance: 1_000_000,
        interest: 2781,
      },
      {
        start: '2026-07-01',
        end: '2026-07-10',
        days: 10,
        yearDays: 365,
        rateBp: 1040,
        balance: 1_000_000,
        interest: 2849,
      },
    ]);
  });

  it('cuts on 31 Dec / 1 Jan and changes the year length', () => {
    const { segments } = calc({
      principal: 5_000_000,
      due: '2023-12-30',
      asOf: '2024-01-02',
    });
    expect(segments.map((s) => [s.start, s.end, s.yearDays, s.rateBp])).toEqual(
      [
        ['2023-12-31', '2023-12-31', 365, 1200],
        ['2024-01-01', '2024-01-02', 366, 1250],
      ],
    );
  });

  it('counts 29 February as a day of a 366-day year', () => {
    const { segments } = calc({
      principal: 100_000,
      due: '2024-02-28',
      asOf: '2024-03-01',
    });
    expect(segments[0]).toMatchObject({ days: 2, yearDays: 366 });
  });

  it('is plain JSON: it survives a JSON round trip unchanged', () => {
    const result = calc({
      principal: 100_000,
      issue: '2026-09-01',
      due: null,
      asOf: '2026-10-30',
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe('leap years (I5)', () => {
  it.each([
    [1900, false],
    [2000, true],
    [2024, true],
    [2028, true],
    [2100, false],
  ])('%i leap year: %s', (year, leap) => {
    expect(isLeapYear(year)).toBe(leap);
    // An agreed rate needs no table, so the engine can be run in any year.
    const result = calc({
      principal: 100_000,
      due: `${String(year)}-12-30`,
      asOf: `${String(year)}-12-31`,
      agreed: 1000,
    });
    expect(result.segments[0]?.yearDays).toBe(leap ? 366 : 365);
  });
});

describe('days around the due date (I6)', () => {
  it('asOf = due date: 0 and no segments, without reading the rates', () => {
    const result = calc({
      principal: 100_000,
      due: '2026-09-30',
      asOf: '2026-09-30',
      rates: [],
    });
    expect(result.interest).toBe(0);
    expect(result.segments).toEqual([]);
  });

  it('asOf before the due date: 0 and no segments, without reading the rates', () => {
    const result = calc({
      principal: 100_000,
      due: '2026-09-30',
      asOf: '2026-09-01',
      rates: [],
    });
    expect(result.interest).toBe(0);
    expect(result.segments).toEqual([]);
  });

  it('asOf one day after the due date: exactly 1 day', () => {
    const result = calc({
      principal: 100_000,
      due: '2026-09-30',
      asOf: '2026-10-01',
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      start: '2026-10-01',
      end: '2026-10-01',
      days: 1,
    });
    expect(result.interest).toBe(28); // 100000 * 10.40 % / 365 = 28.49
  });
});

describe('rounding and overflow (I7)', () => {
  it('rounds half up: E6 (73 days) 335, 72 days 330, E11 0', () => {
    expect(
      calc({ principal: 15_000, due: '2025-01-31', asOf: '2025-04-14' })
        .interest,
    ).toBe(335);
    expect(
      calc({ principal: 15_000, due: '2025-01-31', asOf: '2025-04-13' })
        .interest,
    ).toBe(330);
    expect(
      calc({ principal: 1, due: '2026-09-30', asOf: '2026-10-30' }).interest,
    ).toBe(0);
  });

  it('does not overflow with 1e11 cents, 30 % and a whole leap year', () => {
    const c: Case = {
      principal: 100_000_000_000,
      due: '2023-12-31',
      asOf: '2024-12-31',
      agreed: 3000,
      rates: [],
    };
    const result = calc(c);
    expect(result.segments.reduce((sum, s) => sum + s.days, 0)).toBe(366);
    // 14 918 032 787 (H1, 182 d) + 15 081 967 213 (H2, 184 d)
    expect(interests(result)).toEqual([14_918_032_787, 15_081_967_213]);
    expect(result.interest).toBe(30_000_000_000);
    expectSameAsReference(c, result);
  });
});

describe('out of the supported window', () => {
  const missing = (c: Case): string[] => {
    try {
      calc(c);
    } catch (error) {
      if (error instanceof RateWindowError) return error.missingSemesters;
      throw error;
    }
    throw new Error('Expected a RateWindowError');
  };

  it('asOf 2027-01-01 needs the 2027-H1 rate that does not exist', () => {
    expect(
      missing({ principal: 100_000, due: '2026-12-30', asOf: '2027-01-01' }),
    ).toEqual(['2027-H1']);
  });

  it('lists every missing semester, never extrapolates', () => {
    expect(
      missing({ principal: 100_000, due: '2026-06-30', asOf: '2028-01-01' }),
    ).toEqual(['2027-H1', '2027-H2', '2028-H1']);
  });

  it('the first interest day before 2018-H1 needs 2017-H2', () => {
    expect(
      missing({ principal: 100_000, due: '2017-12-30', asOf: '2018-01-10' }),
    ).toEqual(['2017-H2']);
  });

  // A due date of 31-12-2017 is not out of the window: interest starts the day AFTER the due date,
  // so the first day is 2018-01-01 and that semester does exist: no error.
  it('due 2017-12-31 is inside the window: its first interest day is 2018-01-01', () => {
    const result = calc({
      principal: 100_000,
      due: '2017-12-31',
      asOf: '2018-01-10',
    });
    expect(result.segments[0]?.start).toBe('2018-01-01');
  });

  it('a PENDING row counts as absent', () => {
    const pending = rates.map((row) =>
      row.semester_start === '2026-07-01'
        ? { ...row, status: 'PENDING' as const }
        : row,
    );
    expect(
      missing({
        principal: 100_000,
        due: '2026-09-30',
        asOf: '2026-10-30',
        rates: pending,
      }),
    ).toEqual(['2026-H2']);
  });

  it('with an agreed rate there is no window: 2028 works with no table', () => {
    const result = calc({
      principal: 100_000,
      due: '2027-12-31',
      asOf: '2028-01-10',
      agreed: 1000,
      rates: [],
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.rateBp).toBe(1000);
  });
});

describe('due date, warnings and agreed rate', () => {
  it('no due date: issue date + 30 days, marked as estimated (art. 4)', () => {
    const result = calc({
      principal: 100_000,
      issue: '2026-08-31',
      due: null,
      asOf: '2026-10-30',
    });
    expect(result.dueDate).toBe('2026-09-30');
    expect(result.dueDateEstimated).toBe(true);
    expect(result.interest).toBe(855); // same as E1
    expect(result.warnings).toEqual([]);
  });

  it('a given due date is not estimated', () => {
    const result = calc({
      principal: 100_000,
      issue: '2026-08-01',
      due: '2026-09-30',
      asOf: '2026-10-30',
    });
    expect(result.dueDate).toBe('2026-09-30');
    expect(result.dueDateEstimated).toBe(false);
  });

  it.each([
    ['2026-09-29', false], // 59 days
    ['2026-09-30', false], // 60 days
    ['2026-10-01', true], // 61 days
  ])('term ending %s warns TERM_OVER_60_DAYS: %s', (due, warns) => {
    const result = calc({
      principal: 100_000,
      issue: '2026-08-01',
      due,
      asOf: '2026-11-30',
    });
    expect(result.warnings).toEqual(warns ? ['TERM_OVER_60_DAYS'] : []);
  });

  it('the warning is also given when nothing is overdue', () => {
    const result = calc({
      principal: 100_000,
      issue: '2026-01-01',
      due: '2026-06-01',
      asOf: '2026-01-02',
    });
    expect(result.warnings).toEqual(['TERM_OVER_60_DAYS']);
    expect(result.interest).toBe(0);
  });

  it('an agreed rate replaces the legal one and needs no table', () => {
    // E3 dates with 12 % instead of 10.15 % / 10.40 %: still cut on 30 June / 1 July.
    const c: Case = {
      principal: 1_000_000,
      due: '2026-06-20',
      asOf: '2026-07-10',
      agreed: 1200,
      rates: [],
    };
    const result = calc(c);
    expect(result.segments.map((s) => [s.end, s.rateBp, s.interest])).toEqual([
      ['2026-06-30', 1200, 3288],
      ['2026-07-10', 1200, 3288],
    ]);
    expectSameAsReference(c, result);
  });

  it('an agreed rate of 0 gives 0', () => {
    expect(
      calc({
        principal: 100_000,
        due: '2026-09-30',
        asOf: '2026-10-30',
        agreed: 0,
        rates: [],
      }).interest,
    ).toBe(0);
  });

  it('rejects a negative or fractional agreed rate', () => {
    for (const agreed of [-1, 10.5]) {
      expect(() =>
        calc({
          principal: 100_000,
          due: '2026-09-30',
          asOf: '2026-10-30',
          agreed,
        }),
      ).toThrow(RangeError);
    }
  });
});

describe('payments', () => {
  const base = { principal: 100_000, due: '2026-09-30', asOf: '2026-10-30' };

  it('a payment on the due date lowers the principal before any interest', () => {
    const c: Case = { ...base, payments: [['2026-09-30', 40_000]] };
    const result = calc(c);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ balance: 60_000, days: 30 });
    expect(result.interest).toBe(513); // 60000 * 10.40 % * 30 / 365 = 512.88
    expectSameAsReference(c, result);
  });

  it('a payment before the due date also lowers the principal', () => {
    const c: Case = { ...base, payments: [['2026-09-01', 40_000]] };
    expect(calc(c).interest).toBe(513);
    expectSameAsReference(c, calc(c));
  });

  it('a payment on day X: day X still accrues on the old balance', () => {
    const result = calc({ ...base, payments: [['2026-10-10', 40_000]] });
    expect(result.segments.map((s) => [s.end, s.balance])).toEqual([
      ['2026-10-10', 100_000],
      ['2026-10-30', 60_000],
    ]);
  });

  it('a payment after asOf is ignored', () => {
    const c: Case = { ...base, payments: [['2026-11-01', 40_000]] };
    const result = calc(c);
    expect(result.interest).toBe(855);
    expect(result.segments).toHaveLength(1);
    expectSameAsReference(c, result);
  });

  it('a payment on asOf itself changes nothing', () => {
    const result = calc({ ...base, payments: [['2026-10-30', 40_000]] });
    expect(result.interest).toBe(855);
    expect(result.segments).toHaveLength(1);
  });

  it('two payments on the same day make a single balance change', () => {
    const c: Case = {
      ...base,
      payments: [
        ['2026-10-10', 10_000],
        ['2026-10-10', 30_000],
      ],
    };
    const result = calc(c);
    expect(result.interest).toBe(627);
    expect(result.segments).toHaveLength(2);
    expectSameAsReference(c, result);
  });

  it('a payment that clears the balance stops the interest', () => {
    const c: Case = { ...base, payments: [['2026-10-10', 100_000]] };
    const result = calc(c);
    expect(result.interest).toBe(285);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.end).toBe('2026-10-10');
    expectSameAsReference(c, result);
  });

  it('a payment that clears the balance on the due date leaves no segments', () => {
    const result = calc({ ...base, payments: [['2026-09-30', 100_000]] });
    expect(result.interest).toBe(0);
    expect(result.segments).toEqual([]);
  });

  it('rejects payments that exceed the principal (negative balance)', () => {
    expect(() =>
      calc({
        ...base,
        payments: [
          ['2026-10-10', 60_000],
          ['2026-10-20', 40_001],
        ],
      }),
    ).toThrow(RangeError);
  });

  it('ignores an over-payment dated after asOf', () => {
    expect(() =>
      calc({ ...base, payments: [['2026-12-01', 500_000]] }),
    ).not.toThrow();
  });

  it('rejects a zero or negative payment and a non-positive principal', () => {
    expect(() => calc({ ...base, payments: [['2026-10-10', 0]] })).toThrow(
      RangeError,
    );
    expect(() => calc({ ...base, payments: [['2026-10-10', -5]] })).toThrow(
      RangeError,
    );
    expect(() => calc({ ...base, principal: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------
// Cross-check against the independent day-by-day implementation on pseudo-random cases.
// ---------------------------------------------------------------------------------------

// mulberry32: a tiny seeded generator, so a failure can be reproduced exactly.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MS_PER_DAY = 86_400_000;
const dayNumberOf = (iso: string): number =>
  Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY;
const isoOf = (day: number): string =>
  new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

const RANDOM_CASES = 5000;

describe('cross-check with the independent reference', () => {
  it(`agrees on ${String(RANDOM_CASES)} seeded pseudo-random cases (totals and segments)`, () => {
    const rnd = mulberry32(20_261_014);
    const int = (min: number, max: number): number =>
      min + Math.floor(rnd() * (max - min + 1));

    const dueStart = dayNumberOf('2017-06-01'); // some cases start before the window
    const dueEnd = dayNumberOf('2026-12-31');
    const windowEnd = dayNumberOf('2026-12-31');

    let withPayments = 0;
    let withAgreed = 0;
    let outOfWindow = 0;
    let segmentsCompared = 0;

    for (let n = 0; n < RANDOM_CASES; n++) {
      const principal = int(1, 10 ** int(0, 11));
      const due = int(dueStart, dueEnd);
      // asOf: mostly after the due date, sometimes before it, and sometimes beyond the window.
      const asOf = Math.min(
        due + int(-5, rnd() < 0.5 ? 400 : 2500),
        rnd() < 0.05 ? windowEnd + 400 : windowEnd,
      );
      const agreed = rnd() < 0.4 ? int(1, 3000) : null;

      const payments: [string, number][] = [];
      let left = principal;
      for (let k = int(0, 3); k > 0 && left > 0; k--) {
        const amount = rnd() < 0.2 ? left : int(1, left);
        left -= amount;
        payments.push([isoOf(int(due - 30, asOf + 10)), amount]);
      }

      const c: Case = {
        principal,
        due: isoOf(due),
        asOf: isoOf(asOf),
        payments,
        agreed,
      };

      const ref = referenceInterest({
        principal,
        dueDate: isoOf(due),
        asOf: c.asOf,
        payments: payments.map(([paidOn, amount]) => ({ paidOn, amount })),
        agreedRateBp: agreed,
        rates,
      });

      if (!ref.ok) {
        outOfWindow++;
        let thrown: unknown;
        try {
          calc(c);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `case ${String(n)}`).toBeInstanceOf(RateWindowError);
        expect((thrown as RateWindowError).missingSemesters).toEqual(
          ref.missingSemesters,
        );
        continue;
      }

      const result = calc(c);
      expect(result.interest, `case ${String(n)}`).toBe(ref.interest);
      expect(result.segments, `case ${String(n)}`).toEqual(ref.segments);
      segmentsCompared += result.segments.length;
      if (payments.length > 0) withPayments++;
      if (agreed !== null) withAgreed++;
    }

    // A guard against a generator that stopped exercising something.
    expect(withPayments).toBeGreaterThan(1000);
    expect(withAgreed).toBeGreaterThan(1000);
    expect(outOfWindow).toBeGreaterThan(50);
    expect(segmentsCompared).toBeGreaterThan(5000);
    console.info(
      `cross-check: ${String(RANDOM_CASES)} cases, ${String(withPayments)} with payments, ${String(withAgreed)} with agreed rate, ${String(outOfWindow)} out of window, ${String(segmentsCompared)} segments compared`,
    );
  }, 120_000);
});
