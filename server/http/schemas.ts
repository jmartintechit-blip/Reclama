// Zod pieces shared by the routes that take invoice and debtor data. Zod drops the keys a schema
// does not list, so a client can never write anything else (user_id, status of a payment...).
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../db/query-helpers.ts';
import { parseISODate } from '../domain/dates.ts';
import { toCents } from '../domain/money.ts';

// A text field: trimmed, not empty, at most `max` characters, and without control characters
// (a NUL byte makes Postgres fail with a 500).
export const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value), {
      message: 'Must not contain control characters',
    });

// Dates are limited to these years: it keeps "issue date + 30 days" and the interest loop far
// from the limits of the calendar code and refuses typos such as the year 0202 or 20260.
const MIN_DATE = '1990-01-01';
const MAX_DATE = '2099-12-31';

// A real calendar date, exactly YYYY-MM-DD.
export const isoDate = z
  .string()
  .max(10)
  .transform((value, ctx) => {
    const parsed = parseISODate(value);
    if (parsed === null) {
      ctx.issues.push({
        code: 'custom',
        message: 'Must be a valid date (YYYY-MM-DD)',
        input: value,
      });
      return z.NEVER;
    }
    if (parsed < MIN_DATE || parsed > MAX_DATE) {
      ctx.issues.push({
        code: 'custom',
        message: `Must be between ${MIN_DATE} and ${MAX_DATE}`,
        input: value,
      });
      return z.NEVER;
    }
    return parsed;
  });

// 1,000,000,000.00 EUR. Far more than any invoice of this product, and small enough that the
// sums of a list and the interest stay exact integers.
export const MAX_AMOUNT_CENTS = 100_000_000_000;
export const amountCents = z
  .number()
  .int()
  .min(1)
  .max(MAX_AMOUNT_CENTS)
  .transform((value) => toCents(value));

// An agreed late-payment rate in basis points (1040 = 10.40 %); 100 % at most.
export const rateBp = z.number().int().min(0).max(10_000);

// ?limit= and ?offset=: digits only, so "1e3", "-1" or "0x10" are refused, not guessed.
const queryInt = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, { message: 'Must be a whole number' })
    .transform(Number)
    .pipe(z.number().min(min).max(max));

export const pageQuery = {
  limit: queryInt(1, MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: queryInt(0, 1_000_000).default(0),
};

export const uuid = z.uuid();

// The `:id` of a path. null when it is not a UUID: the routes answer 404 (the same answer as for
// an id that does not exist or is somebody else's), so Postgres never sees a malformed id.
export function idParam(value: unknown): string | null {
  const parsed = uuid.safeParse(value);
  return parsed.success ? parsed.data : null;
}
