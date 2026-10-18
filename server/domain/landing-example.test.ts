// The home page shows a worked example with hard-coded segments (web/src/content/example.ts).
// This test recomputes them with the real engine and the real rate table, so the page can
// never show numbers the engine would not produce.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_AS_OF,
  EXAMPLE_COMPENSATION_CENTS,
  EXAMPLE_DUE_DATE,
  EXAMPLE_ISSUE_DATE,
  EXAMPLE_PRINCIPAL_CENTS,
  EXAMPLE_SEGMENTS,
} from '../../web/src/content/example.ts';
import { COMPENSATION_CENTS } from './claim.ts';
import type { ISODate } from './dates.ts';
import { calculateDefaultInterest } from './interest.ts';
import { toCents } from './money.ts';
import { parseRates } from './rates.ts';

const FILE = new URL('../../data/legal-interest-rates.json', import.meta.url);
const rates = parseRates(JSON.parse(readFileSync(FILE, 'utf8')) as unknown);

const date = (text: string) => text as ISODate;
const view = (
  segments: readonly {
    start: string;
    end: string;
    days: number;
    rateBp: number;
    balance: number;
    interest: number;
  }[],
) =>
  segments.map(({ start, end, days, rateBp, balance, interest }) => ({
    start,
    end,
    days,
    rateBp,
    balance,
    interest,
  }));

describe('home page example', () => {
  const base = {
    principal: toCents(EXAMPLE_PRINCIPAL_CENTS),
    issueDate: date(EXAMPLE_ISSUE_DATE),
    dueDate: date(EXAMPLE_DUE_DATE),
    asOf: date(EXAMPLE_AS_OF),
    agreedRateBp: null,
    rates,
  };

  it('matches the interest engine segment by segment', () => {
    const result = calculateDefaultInterest({ ...base, payments: [] });
    expect(view(result.segments)).toEqual(view(EXAMPLE_SEGMENTS));
    expect(result.interest).toBe(100_620);
  });

  it('uses the compensation the claim engine applies', () => {
    expect(EXAMPLE_COMPENSATION_CENTS).toBe(COMPENSATION_CENTS);
  });

  it('gives the figures of the same invoice after a partial payment of 2.000,00 EUR', () => {
    const result = calculateDefaultInterest({
      ...base,
      payments: [{ paidOn: date('2026-04-15'), amount: toCents(200_000) }],
    });
    expect(result.segments.map((s) => s.interest)).toEqual([
      27_347, 26_104, 14_667, 21_949,
    ]);
    expect(result.segments.map((s) => s.days)).toEqual([110, 105, 76, 111]);
    expect(result.interest).toBe(90_067);
  });
});
