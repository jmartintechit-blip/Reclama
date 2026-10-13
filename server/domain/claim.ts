// Claim totals (plan 4.4): default interest per overdue invoice plus the optional EUR 40
// compensation of Ley 3/2004 art. 8. Pure code: no I/O, no clock. The result is plain JSON
// because a claim freezes it (claims + claim_invoices tables).
import type { ISODate } from './dates.ts';
import {
  calculateDefaultInterest,
  type InterestPayment,
  type InterestSegment,
  type InterestWarning,
} from './interest.ts';
import { toCents, type Cents } from './money.ts';
import type { LegalRate } from './rates.ts';

export const COMPENSATION_CENTS = toCents(4000);

// Stored with every claim: if the rules change later, old claims stay traceable.
export const CALC_VERSION = 'interest-v1';

export type CompensationMode = 'NONE' | 'PER_INVOICE' | 'PER_CLAIM';
export type DebtorKind = 'BUSINESS' | 'PUBLIC_ADMIN' | 'CONSUMER' | 'UNKNOWN';

export interface ClaimInvoiceInput {
  id: string;
  principal: Cents; // the invoice amount; payments are subtracted here
  issueDate: ISODate;
  dueDate: ISODate | null;
  agreedRateBp: number | null;
  payments: readonly InterestPayment[];
}

export interface ClaimInput {
  asOf: ISODate;
  debtorKind: DebtorKind;
  b2bConfirmed: boolean; // only read when debtorKind is UNKNOWN
  compensationMode: CompensationMode;
  rates: readonly LegalRate[];
  invoices: readonly ClaimInvoiceInput[];
}

// What claim_invoices freezes for each claimed invoice.
export interface ClaimLine {
  id: string;
  principal: Cents; // still owed at asOf
  interest: Cents;
  segments: InterestSegment[];
  warnings: InterestWarning[];
  dueDate: ISODate;
  dueDateEstimated: boolean;
}

export interface ClaimResult {
  lines: ClaimLine[];
  notOverdue: string[]; // invoice ids that add nothing, not even compensation
  settled: string[]; // invoice ids with nothing left to pay at asOf
  principal: Cents;
  interest: Cents;
  compensation: Cents;
  total: Cents;
  compensationMode: CompensationMode;
  calcVersion: string;
}

export type ClaimErrorCode =
  'NOT_OVERDUE' | 'DEBTOR_NOT_B2B' | 'DEBTOR_KIND_UNCONFIRMED';

// The API maps the code to a 422 response.
export class ClaimError extends Error {
  readonly code: ClaimErrorCode;

  constructor(code: ClaimErrorCode, message: string) {
    super(message);
    this.name = 'ClaimError';
    this.code = code;
  }
}

const sum = (values: readonly number[]): Cents =>
  toCents(values.reduce((total, value) => total + value, 0));

// Checked before any interest work: Ley 3/2004 only covers business-to-business debts.
function assertB2b(debtorKind: DebtorKind, b2bConfirmed: boolean): void {
  if (debtorKind === 'PUBLIC_ADMIN' || debtorKind === 'CONSUMER') {
    throw new ClaimError(
      'DEBTOR_NOT_B2B',
      'Ley 3/2004 does not cover public administrations or consumers',
    );
  }
  if (debtorKind === 'UNKNOWN' && !b2bConfirmed) {
    throw new ClaimError(
      'DEBTOR_KIND_UNCONFIRMED',
      'Confirm that the debtor is a business before claiming',
    );
  }
}

export function computeClaim(input: ClaimInput): ClaimResult {
  const { asOf, compensationMode } = input;
  assertB2b(input.debtorKind, input.b2bConfirmed);

  const lines: ClaimLine[] = [];
  const notOverdue: string[] = [];
  const settled: string[] = [];

  for (const invoice of input.invoices) {
    const paid = sum(
      invoice.payments.filter((p) => p.paidOn <= asOf).map((p) => p.amount),
    );
    if (paid > invoice.principal) {
      throw new RangeError('The payments exceed the principal');
    }
    const balance = toCents(invoice.principal - paid);
    if (balance === 0) {
      settled.push(invoice.id);
      continue;
    }

    const result = calculateDefaultInterest({
      principal: invoice.principal,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      asOf,
      payments: invoice.payments,
      agreedRateBp: invoice.agreedRateBp,
      rates: input.rates,
    });
    // Same rule as the engine: interest starts the day after the due date.
    if (asOf <= result.dueDate) {
      notOverdue.push(invoice.id);
      continue;
    }

    lines.push({
      id: invoice.id,
      principal: balance,
      interest: result.interest,
      segments: result.segments,
      warnings: result.warnings,
      dueDate: result.dueDate,
      dueDateEstimated: result.dueDateEstimated,
    });
  }

  if (lines.length === 0) {
    throw new ClaimError(
      'NOT_OVERDUE',
      'No invoice is overdue at the claim date',
    );
  }

  let compensation = toCents(0);
  if (compensationMode === 'PER_INVOICE') {
    compensation = toCents(COMPENSATION_CENTS * lines.length);
  } else if (compensationMode === 'PER_CLAIM') {
    compensation = COMPENSATION_CENTS;
  }

  const principal = sum(lines.map((l) => l.principal));
  const interest = sum(lines.map((l) => l.interest));
  return {
    lines,
    notOverdue,
    settled,
    principal,
    interest,
    compensation,
    total: sum([principal, interest, compensation]),
    compensationMode,
    calcVersion: CALC_VERSION,
  };
}
