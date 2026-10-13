// Default (late-payment) interest engine, plan 4.2. Pure code: simple interest, ACT/ACT, one
// segment per semester, half-up rounding per segment, all in BigInt so nothing can overflow
// or drift. The output is plain JSON (strings and integers) because a claim freezes it.
import { addDays, daysInYear, diffDays, type ISODate } from './dates.ts';
import { toCents, type Cents } from './money.ts';
import { verifiedRates, type LegalRate } from './rates.ts';

// Ley 3/2004 art. 4: without an agreed term the payment is due 30 days after the invoice.
const DEFAULT_TERM_DAYS = 30;
const MAX_TERM_DAYS = 60;

export interface InterestPayment {
  paidOn: ISODate;
  amount: Cents;
}

export interface InterestInput {
  principal: Cents;
  issueDate: ISODate;
  dueDate: ISODate | null;
  asOf: ISODate;
  payments: readonly InterestPayment[];
  agreedRateBp: number | null;
  rates: readonly LegalRate[];
}

export interface InterestSegment {
  start: ISODate; // inclusive
  end: ISODate; // inclusive
  days: number;
  yearDays: 365 | 366;
  rateBp: number;
  balance: Cents; // principal outstanding during the whole segment
  interest: Cents; // already rounded; the total is the sum of these
}

export type InterestWarning = 'TERM_OVER_60_DAYS';

export interface InterestResult {
  interest: Cents;
  segments: InterestSegment[];
  warnings: InterestWarning[];
  dueDate: ISODate; // the one used: the given one, or issue date + 30 days
  dueDateEstimated: boolean;
}

// Plan 4.5: the caller turns this into 422 RATE_WINDOW. Semesters look like "2027-H1".
export class RateWindowError extends Error {
  readonly missingSemesters: string[];

  constructor(missingSemesters: string[]) {
    super(
      `No verified legal rate for semester(s): ${missingSemesters.join(', ')}`,
    );
    this.name = 'RateWindowError';
    this.missingSemesters = missingSemesters;
  }
}

const semesterLabel = (date: ISODate): string =>
  `${date.slice(0, 4)}-H${Number(date.slice(5, 7)) <= 6 ? '1' : '2'}`;

const semesterEnd = (date: ISODate): ISODate =>
  (Number(date.slice(5, 7)) <= 6
    ? `${date.slice(0, 4)}-06-30`
    : `${date.slice(0, 4)}-12-31`) as ISODate;

// floor((2*P*bp*D + 10000*Y) / (20000*Y)) is round-half-up of P*bp*D / (10000*Y).
function segmentInterest(
  balance: bigint,
  rateBp: number,
  days: number,
  yearDays: number,
): bigint {
  const y = BigInt(yearDays);
  return (
    (2n * balance * BigInt(rateBp) * BigInt(days) + 10_000n * y) / (20_000n * y)
  );
}

function toCentsChecked(value: bigint): Cents {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Amount does not fit in a safe integer of cents');
  }
  return toCents(Number(value));
}

const sumOf = (payments: readonly InterestPayment[]): bigint =>
  payments.reduce((sum, p) => sum + BigInt(p.amount), 0n);

export function calculateDefaultInterest(input: InterestInput): InterestResult {
  const { principal, issueDate, asOf, agreedRateBp } = input;

  // Programmer errors: the database and the API validate these before they get here.
  if (principal <= 0) throw new RangeError('The principal must be positive');
  if (
    agreedRateBp !== null &&
    (!Number.isSafeInteger(agreedRateBp) || agreedRateBp < 0)
  ) {
    throw new RangeError('The agreed rate must be a non-negative integer');
  }
  if (input.payments.some((p) => p.amount <= 0)) {
    throw new RangeError('A payment must be positive');
  }

  const dueDateEstimated = input.dueDate === null;
  const dueDate = input.dueDate ?? addDays(issueDate, DEFAULT_TERM_DAYS);
  const warnings: InterestWarning[] = [];
  if (
    input.dueDate !== null &&
    diffDays(input.dueDate, issueDate) > MAX_TERM_DAYS
  ) {
    warnings.push('TERM_OVER_60_DAYS');
  }

  // A payment after asOf has not happened yet as far as this calculation is concerned.
  const paid = input.payments.filter((p) => p.paidOn <= asOf);
  if (sumOf(paid) > BigInt(principal)) {
    throw new RangeError('The payments exceed the principal');
  }
  const result = (
    segments: InterestSegment[],
    interest: bigint,
  ): InterestResult => ({
    interest: toCentsChecked(interest),
    segments,
    warnings,
    dueDate,
    dueDateEstimated,
  });

  if (asOf <= dueDate) return result([], 0n); // never touches the rates

  // Paid on or before the due date: lowers the principal before any interest accrues.
  let balance =
    BigInt(principal) - sumOf(paid.filter((p) => p.paidOn <= dueDate));
  // Paid later: day X still accrues on the old balance, the new one starts on X+1.
  const late = paid.filter((p) => p.paidOn > dueDate);
  const rates = verifiedRates(input.rates);

  const segments: InterestSegment[] = [];
  const missing: string[] = [];
  let total = 0n;
  let cursor = addDays(dueDate, 1);

  while (cursor <= asOf && balance > 0n) {
    // The segment ends at the earliest of: asOf, the semester end, the next payment day.
    let end = semesterEnd(cursor) < asOf ? semesterEnd(cursor) : asOf;
    for (const p of late) {
      if (p.paidOn >= cursor && p.paidOn < end) end = p.paidOn;
    }

    const rateBp =
      agreedRateBp ??
      rates.find((r) => r.semester_start <= cursor && cursor <= r.semester_end)
        ?.rate_bp;
    if (rateBp === undefined) {
      const label = semesterLabel(cursor);
      if (!missing.includes(label)) missing.push(label);
    } else {
      const days = diffDays(end, cursor) + 1;
      const yearDays = daysInYear(Number(cursor.slice(0, 4)));
      const interest = segmentInterest(balance, rateBp, days, yearDays);
      total += interest;
      segments.push({
        start: cursor,
        end,
        days,
        yearDays,
        rateBp,
        balance: toCentsChecked(balance),
        interest: toCentsChecked(interest),
      });
    }

    balance -= sumOf(late.filter((p) => p.paidOn === end));
    cursor = addDays(end, 1);
  }

  if (missing.length > 0) throw new RateWindowError(missing);
  return result(segments, total);
}
