// What the API shows for an invoice: the stored row plus what is derived from it (paid, balance,
// due date, overdue, interest as of a day). Pure code: the list, the detail and the interest
// endpoint all use these functions, so they can never disagree about a number.
import type { Invoice } from '../db/invoices.ts';
import type { Payment } from '../db/payments.ts';
import type { ISODate } from '../domain/dates.ts';
import { diffDays } from '../domain/dates.ts';
import {
  calculateDefaultInterest,
  RateWindowError,
  type InterestResult,
} from '../domain/interest.ts';
import { toCents, type Cents } from '../domain/money.ts';
import type { LegalRate } from '../domain/rates.ts';

export type InterestOutcome =
  | { ok: true; result: InterestResult }
  | { ok: false; error: 'RATE_WINDOW'; missingSemesters: string[] }
  // The engine refused the data (for example imported dates near year 9999, or payments that
  // add up to more than the invoice). One bad invoice must not break a whole list.
  | { ok: false; error: 'CALCULATION_FAILED' };

export function calculateInvoiceInterest(
  invoice: Invoice,
  payments: readonly Payment[],
  rates: readonly LegalRate[],
  asOf: ISODate,
): InterestOutcome {
  try {
    return {
      ok: true,
      result: calculateDefaultInterest({
        principal: invoice.amount_cents,
        issueDate: invoice.issue_date,
        dueDate: invoice.due_date,
        asOf,
        payments: payments.map((p) => ({
          paidOn: p.paid_on,
          amount: p.amount_cents,
        })),
        agreedRateBp: invoice.agreed_rate_bp,
        rates,
      }),
    };
  } catch (error) {
    if (error instanceof RateWindowError) {
      return {
        ok: false,
        error: 'RATE_WINDOW',
        missingSemesters: error.missingSemesters,
      };
    }
    if (error instanceof RangeError) {
      return { ok: false, error: 'CALCULATION_FAILED' };
    }
    throw error;
  }
}

export interface InvoiceView extends Invoice {
  paid_cents: Cents;
  balance_cents: Cents;
  // The given due date, or issue date + 30 days. null only when that sum does not fit the
  // calendar (imported data near year 9999); then nothing can be calculated for the invoice.
  due_date_effective: ISODate | null;
  due_date_estimated: boolean;
  // Still owed and past its due date. An invoice marked PAID is never overdue, whatever its balance.
  overdue: boolean;
  days_overdue: number;
  interest_cents: Cents | null; // as of `today`; null when interest_error says why
  interest_error: 'RATE_WINDOW' | 'CALCULATION_FAILED' | null;
}

// With `asOf` on the issue date the engine does no interest work and no rate lookup: it only
// reports the due date it would use. It is how the due date is found when the real calculation
// fails (null when even that is impossible).
function probeDueDate(invoice: Invoice): ISODate | null {
  const outcome = calculateInvoiceInterest(invoice, [], [], invoice.issue_date);
  return outcome.ok ? outcome.result.dueDate : null;
}

export function buildInvoiceView(
  invoice: Invoice,
  payments: readonly Payment[],
  rates: readonly LegalRate[],
  today: ISODate,
): InvoiceView {
  const paid = toCents(payments.reduce((sum, p) => sum + p.amount_cents, 0));
  const balance = toCents(invoice.amount_cents - paid);
  const outcome = calculateInvoiceInterest(invoice, payments, rates, today);
  const dueDate = outcome.ok ? outcome.result.dueDate : probeDueDate(invoice);
  const overdue =
    invoice.status !== 'PAID' &&
    balance > 0 &&
    dueDate !== null &&
    dueDate < today;
  return {
    ...invoice,
    paid_cents: paid,
    balance_cents: balance,
    due_date_effective: dueDate,
    due_date_estimated: invoice.due_date === null,
    overdue,
    days_overdue: overdue ? diffDays(today, dueDate) : 0,
    interest_cents: outcome.ok ? outcome.result.interest : null,
    interest_error: outcome.ok ? null : outcome.error,
  };
}

export interface InvoiceSummary {
  outstanding_cents: Cents;
  interest_cents: Cents;
  overdue_count: number;
  interest_unavailable_count: number;
}

// Only invoices that are not PAID count: a settled invoice owes nothing and a claim leaves it out
// too. `interest_cents` adds up the interest that could be calculated; the invoices where it
// could not are counted apart, so the total is never mistaken for a complete one.
export function summarizeInvoices(
  views: readonly InvoiceView[],
): InvoiceSummary {
  const open = views.filter((v) => v.status !== 'PAID');
  return {
    outstanding_cents: toCents(open.reduce((s, v) => s + v.balance_cents, 0)),
    interest_cents: toCents(
      open.reduce((s, v) => s + (v.interest_cents ?? 0), 0),
    ),
    overdue_count: open.filter((v) => v.overdue).length,
    interest_unavailable_count: open.filter((v) => v.interest_cents === null)
      .length,
  };
}
