// Legal late-payment interest rates (Ley 3/2004, art. 7): one row per calendar semester, in
// basis points (1040 = 10.40 %). The source of truth is data/legal-interest-rates.json; this
// file only describes, parses and checks it. Pure code: no I/O.
import { addDays, parseISODate, type ISODate } from './dates.ts';

// Art. 7.2: the ECB rate of the last auction of the previous semester + 8 percentage points.
export const LEGAL_SPREAD_BP = 800;

const BOE_REF = /^BOE-A-\d{4}-\d+$/;

export type RateStatus = 'VERIFIED' | 'PENDING';

// The field names are the JSON keys and the table columns on purpose: one name from the file
// to the database.
export interface LegalRate {
  semester_start: ISODate;
  semester_end: ISODate;
  rate_bp: number;
  ecb_mro_bp: number;
  spread_bp: number;
  boe_ref: string | null;
  published_on: ISODate | null;
  status: RateStatus;
}

const FIELDS = [
  'semester_start',
  'semester_end',
  'rate_bp',
  'ecb_mro_bp',
  'spread_bp',
  'boe_ref',
  'published_on',
  'status',
];

function parseRow(item: unknown, index: number): LegalRate {
  const fail = (message: string): never => {
    throw new Error(`Rate row ${String(index)}: ${message}`);
  };
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return fail('must be an object');
  }
  const row = item as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!FIELDS.includes(key)) fail(`unknown field "${key}"`);
  }

  const date = (key: string): ISODate => {
    const value = row[key];
    const parsed = typeof value === 'string' ? parseISODate(value) : null;
    return parsed ?? fail(`${key} must be a valid YYYY-MM-DD date`);
  };
  // Integers only: a float such as 10.4 would make the money maths inexact.
  const int = (key: string): number => {
    const value = row[key];
    return typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : fail(`${key} must be an integer`);
  };
  const { boe_ref, status } = row;
  if (boe_ref !== null && typeof boe_ref !== 'string') {
    fail('boe_ref must be a string or null');
  }
  if (status !== 'VERIFIED' && status !== 'PENDING') {
    return fail('status must be VERIFIED or PENDING');
  }

  return {
    semester_start: date('semester_start'),
    semester_end: date('semester_end'),
    rate_bp: int('rate_bp'),
    ecb_mro_bp: int('ecb_mro_bp'),
    spread_bp: int('spread_bp'),
    boe_ref: boe_ref as string | null,
    published_on: row.published_on === null ? null : date('published_on'),
    status,
  };
}

// Checks the SHAPE of the file content (types, integers, valid dates). The business rules
// (contiguity, rate = ecb + spread...) are checked by verifyRates.
export function parseRates(json: unknown): LegalRate[] {
  if (!Array.isArray(json)) {
    throw new Error('The rate table must be a JSON array');
  }
  const items: unknown[] = json;
  return items.map(parseRow);
}

// The last day of the semester that starts on `start`, or null if `start` is not 1 Jan / 1 Jul.
function expectedEnd(start: ISODate): string | null {
  const year = start.slice(0, 4);
  if (start.slice(5) === '01-01') return `${year}-06-30`;
  if (start.slice(5) === '07-01') return `${year}-12-31`;
  return null;
}

// Returns the list of broken invariants; an empty list means the table is sound. It is also
// what `npm run rates:verify` runs in CI, so a typo in the JSON cannot reach production.
export function verifyRates(rows: readonly LegalRate[]): string[] {
  const problems: string[] = [];
  if (rows.length === 0) problems.push('The rate table is empty');

  const starts = new Set<string>();
  const refs = new Set<string>();
  for (const row of rows) {
    const id = row.semester_start;

    const end = expectedEnd(id);
    if (end === null) {
      problems.push(`${id}: semester_start must be 1 January or 1 July`);
    } else if (row.semester_end !== end) {
      problems.push(
        `${id}: semester_end is ${row.semester_end}, expected ${end}`,
      );
    }
    if (row.spread_bp !== LEGAL_SPREAD_BP) {
      problems.push(
        `${id}: spread_bp is ${String(row.spread_bp)}, the law says ${String(LEGAL_SPREAD_BP)}`,
      );
    }
    if (row.rate_bp !== row.ecb_mro_bp + row.spread_bp) {
      problems.push(
        `${id}: rate_bp ${String(row.rate_bp)} is not ecb_mro_bp ${String(row.ecb_mro_bp)} + spread_bp ${String(row.spread_bp)}`,
      );
    }

    if (starts.has(id)) problems.push(`${id}: duplicate semester_start`);
    starts.add(id);

    if (row.boe_ref !== null) {
      if (!BOE_REF.test(row.boe_ref)) {
        problems.push(`${id}: invalid boe_ref "${row.boe_ref}"`);
      }
      if (refs.has(row.boe_ref)) {
        problems.push(`${id}: duplicate boe_ref ${row.boe_ref}`);
      }
      refs.add(row.boe_ref);
    }
    if (
      row.status === 'VERIFIED' &&
      (row.boe_ref === null || row.published_on === null)
    ) {
      problems.push(`${id}: a VERIFIED row needs boe_ref and published_on`);
    }
  }

  // From the first to the last semester there must be no gap and no overlap.
  const sorted = [...rows].sort((a, b) =>
    a.semester_start < b.semester_start ? -1 : 1,
  );
  for (const [i, row] of sorted.entries()) {
    const previous = sorted[i - 1];
    if (
      previous === undefined ||
      previous.semester_start === row.semester_start
    ) {
      continue; // the first row, or a duplicate that is already reported
    }
    if (row.semester_start <= previous.semester_end) {
      problems.push(
        `${row.semester_start}: overlaps the semester that starts ${previous.semester_start}`,
      );
    } else if (row.semester_start !== addDays(previous.semester_end, 1)) {
      problems.push(
        `${row.semester_start}: gap after the semester that ends ${previous.semester_end}`,
      );
    }
  }
  return problems;
}

// Plan 4.5: a PENDING row counts as absent, so the interest engine only sees these.
export function verifiedRates(rows: readonly LegalRate[]): LegalRate[] {
  return rows.filter((row) => row.status === 'VERIFIED');
}
