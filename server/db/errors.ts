import type { Cents } from '../domain/money.ts';

// Business-rule failures of the repositories. They are thrown (not returned) because they come
// out of the middle of a write; the HTTP layer maps each `code` to a status. No message carries
// user data.
export class DebtorNotFoundError extends Error {
  readonly code = 'DEBTOR_NOT_FOUND';
  constructor() {
    super('Debtor not found');
    this.name = 'DebtorNotFoundError';
  }
}

export class InvoiceDuplicateError extends Error {
  readonly code = 'INVOICE_DUPLICATE';
  constructor() {
    super('This debtor already has an invoice with that number');
    this.name = 'InvoiceDuplicateError';
  }
}

export class InvoiceInClaimError extends Error {
  readonly code = 'INVOICE_IN_CLAIM';
  constructor() {
    super('The invoice is part of a claim and cannot be changed');
    this.name = 'InvoiceInClaimError';
  }
}

// The database CHECK (due date on or after the issue date). The API validates it first; this is
// the backstop for a request that slips past (two edits racing, a code path that forgets).
export class InvoiceDatesError extends Error {
  readonly code = 'DUE_BEFORE_ISSUE';
  constructor() {
    super('The due date is before the issue date');
    this.name = 'InvoiceDatesError';
  }
}

export class PaymentExceedsBalanceError extends Error {
  readonly code = 'PAYMENT_EXCEEDS_BALANCE';
  readonly remainingCents: Cents;
  constructor(remainingCents: Cents) {
    super('The payment is larger than the remaining balance');
    this.name = 'PaymentExceedsBalanceError';
    this.remainingCents = remainingCents;
  }
}

// The database trigger (a check violation) that refuses a lowering of the amount below what has
// already been paid. The API validates it first; this is the backstop for a payment that lands
// between that check and the update.
export class InvoiceAmountBelowPaidError extends Error {
  readonly code = 'AMOUNT_BELOW_PAID';
  readonly paidCents: Cents;
  constructor(paidCents: Cents) {
    super('The amount is below what has already been paid');
    this.name = 'InvoiceAmountBelowPaidError';
    this.paidCents = paidCents;
  }
}

// Postgres error codes. Both pg and PGlite put them in `error.code`, and the name of the
// violated constraint in `error.constraint`.
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const CHECK_VIOLATION = '23514';

// Default names Postgres gives to the constraints of the initial schema (the tests check them).
export const INVOICE_DATES_CHECK = 'invoices_check';
export const INVOICE_DEBTOR_FK = 'invoices_user_id_debtor_id_fkey';
export const INVOICE_NUMBER_UNIQUE = 'invoices_user_id_debtor_id_number_key';
export const CLAIM_INVOICE_FK = 'claim_invoices_user_id_invoice_id_fkey';

// Names given by the triggers of the payment guard migration to the check violations they raise.
export const PAYMENT_TOTAL_CHECK = 'payments_total_within_invoice';
export const INVOICE_AMOUNT_CHECK = 'invoices_amount_covers_payments';

// Matching the constraint name too, so an unrelated violation is never mistaken for the one
// we expect (it is rethrown and ends as a 500, not as a wrong business answer).
export function violates(
  error: unknown,
  code: string,
  constraint: string,
): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code &&
    'constraint' in error &&
    error.constraint === constraint
  );
}
