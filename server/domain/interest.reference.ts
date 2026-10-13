// REFERENCE implementation, used only by tests to cross-check interest.ts (plan T12).
// It deliberately shares no logic with the production engine: it walks DAY BY DAY, works out
// the semester, the year length, the rate and the balance of each day on its own, adds exact
// fractions (BigInt numerator/denominator) and only then groups the days into runs to apply
// the same half-up rounding. It does not use dates.ts either: it has its own calendar maths
// (Howard Hinnant's civil-date algorithms) so a bug there cannot hide in both places.
import type { LegalRate } from './rates.ts';

export interface ReferenceInput {
  principal: number;
  dueDate: string; // the effective due date
  asOf: string;
  payments: readonly { paidOn: string; amount: number }[];
  agreedRateBp: number | null;
  rates: readonly LegalRate[];
}

export interface ReferenceSegment {
  start: string;
  end: string;
  days: number;
  yearDays: number;
  rateBp: number;
  balance: number;
  interest: number;
}

export type ReferenceResult =
  | { ok: true; interest: number; segments: ReferenceSegment[] }
  | { ok: false; missingSemesters: string[] };

// Days since 1970-01-01 for a civil date.
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36_524) -
      Math.floor(doe / 146_096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

const pad = (n: number, width: number): string =>
  String(n).padStart(width, '0');
const text = (days: number): string => {
  const { y, m, d } = civilFromDays(days);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
};
const dayNumber = (iso: string): number =>
  daysFromCivil(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)),
    Number(iso.slice(8, 10)),
  );

// Gregorian rule written differently from dates.ts: count by year instead of by modulo chain.
const yearLength = (y: number): number =>
  y % 400 === 0 ? 366 : y % 100 === 0 ? 365 : y % 4 === 0 ? 366 : 365;

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

// An exact fraction, always reduced.
interface Fraction {
  num: bigint;
  den: bigint;
}
function add(a: Fraction, b: Fraction): Fraction {
  const num = a.num * b.den + b.num * a.den;
  const den = a.den * b.den;
  const g = gcd(num, den);
  return g === 0n ? { num: 0n, den: 1n } : { num: num / g, den: den / g };
}

interface Run {
  year: number;
  half: number;
  balance: number;
  rateBp: number;
  first: number; // day numbers
  last: number;
  sum: Fraction; // exact interest of the run: sum over its days of balance * bp / (10000 * Y)
}

export function referenceInterest(input: ReferenceInput): ReferenceResult {
  const first = dayNumber(input.dueDate) + 1;
  const last = dayNumber(input.asOf);
  const payments = input.payments.map((p) => ({
    day: dayNumber(p.paidOn),
    amount: p.amount,
  }));

  const runs: Run[] = [];
  const missing = new Set<string>();

  for (let day = first; day <= last; day++) {
    const { y, m } = civilFromDays(day);
    const half = m <= 6 ? 1 : 2;
    // The balance of a day: the principal minus every payment made on an EARLIER day.
    const paidBefore = payments
      .filter((p) => p.day < day)
      .reduce((sum, p) => sum + p.amount, 0);
    const balance = input.principal - paidBefore;
    if (balance === 0) continue;

    let rateBp: number | undefined = input.agreedRateBp ?? undefined;
    if (rateBp === undefined) {
      const row = input.rates.find(
        (r) =>
          r.status === 'VERIFIED' &&
          Number(r.semester_start.slice(0, 4)) === y &&
          Number(r.semester_start.slice(5, 7)) === (half === 1 ? 1 : 7),
      );
      if (row === undefined) {
        missing.add(`${pad(y, 4)}-H${String(half)}`);
        continue;
      }
      rateBp = row.rate_bp;
    }

    const perDay: Fraction = {
      num: BigInt(balance) * BigInt(rateBp),
      den: 10_000n * BigInt(yearLength(y)),
    };
    const open = runs.at(-1);
    if (
      open !== undefined &&
      open.last === day - 1 &&
      open.year === y &&
      open.half === half &&
      open.balance === balance
    ) {
      open.last = day;
      open.sum = add(open.sum, perDay);
    } else {
      runs.push({
        year: y,
        half,
        balance,
        rateBp,
        first: day,
        last: day,
        sum: add({ num: 0n, den: 1n }, perDay),
      });
    }
  }

  if (missing.size > 0) {
    return { ok: false, missingSemesters: [...missing].sort() };
  }

  const segments = runs.map((run): ReferenceSegment => {
    // Half-up: floor(x + 1/2) = floor((2*num + den) / (2*den)) for x = num/den >= 0.
    const rounded = (2n * run.sum.num + run.sum.den) / (2n * run.sum.den);
    return {
      start: text(run.first),
      end: text(run.last),
      days: run.last - run.first + 1,
      yearDays: yearLength(run.year),
      rateBp: run.rateBp,
      balance: run.balance,
      interest: Number(rounded),
    };
  });
  return {
    ok: true,
    interest: segments.reduce((sum, s) => sum + s.interest, 0),
    segments,
  };
}
