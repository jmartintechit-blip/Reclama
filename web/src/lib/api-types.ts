// The shapes of what the API answers for invoices, payments, debtors, interest and claims. They
// mirror the server by hand (the web never imports server code); the server is the authority, and
// a test with a real-looking payload keeps the two honest. Amounts are integer cents everywhere.
import type { Compensation } from './session.tsx';

export type InvoiceStatus = 'OPEN' | 'PAID' | 'DISPUTED';
export type DebtorKind = 'BUSINESS' | 'PUBLIC_ADMIN' | 'CONSUMER' | 'UNKNOWN';
export type InterestError = 'RATE_WINDOW' | 'CALCULATION_FAILED';

export interface InvoiceView {
  id: string;
  debtor_id: string;
  number: string;
  issue_date: string;
  // null means "issue date + 30 days": due_date_effective is then an estimate.
  due_date: string | null;
  amount_cents: number;
  agreed_rate_bp: number | null;
  status: InvoiceStatus;
  paid_cents: number;
  balance_cents: number;
  due_date_effective: string | null;
  due_date_estimated: boolean;
  overdue: boolean;
  days_overdue: number;
  // As of today; null when interest_error says why.
  interest_cents: number | null;
  interest_error: InterestError | null;
}

export interface Payment {
  id: string;
  invoice_id: string;
  paid_on: string;
  amount_cents: number;
}

export interface InvoiceDetail extends InvoiceView {
  payments: Payment[];
}

// The totals count the invoices that are not PAID, over the first `truncated`-limited rows of
// the list. interest_cents leaves out the invoices counted in interest_unavailable_count.
export interface InvoiceTotals {
  count: number;
  outstanding_cents: number;
  interest_cents: number;
  overdue_count: number;
  interest_unavailable_count: number;
  truncated: boolean;
}

export interface PageInfo {
  limit: number;
  offset: number;
  total: number;
}

export interface InvoicesPage {
  invoices: InvoiceView[];
  totals: InvoiceTotals;
  page: PageInfo;
}

export interface Debtor {
  id: string;
  name: string;
  tax_id: string | null;
  email: string | null;
  kind: DebtorKind;
}

export interface DebtorsPage {
  debtors: Debtor[];
  page: PageInfo;
}

export interface InterestSegmentData {
  start: string;
  end: string;
  days: number;
  year_days: number;
  rate_bp: number;
  balance_cents: number;
  interest_cents: number;
}

export interface Interest {
  invoice_id: string;
  as_of: string;
  principal_cents: number;
  paid_cents: number;
  balance_cents: number;
  due_date_effective: string;
  due_date_estimated: boolean;
  interest_cents: number;
  warnings: string[];
  segments: InterestSegmentData[];
}

// POST /api/imports. The same shape comes back for a dry run (what WOULD happen) and for the
// real import (what happened); only the dry run carries `preview`.
export interface ImportRowIssue {
  // The line in the file; the header is line 1.
  row: number;
  // The column's canonical name (number, debtorName, ...), or null when the whole row is at fault.
  field: string | null;
  code: string;
  // English, written for developers: shown only when the app has no text for `code`.
  message: string;
}

export interface ImportPreviewRow {
  row: number;
  number: string;
  debtor_name: string;
  issue_date: string;
  due_date: string | null;
  amount_cents: number;
  already_imported: boolean;
}

export interface ImportOutcome {
  dry_run: boolean;
  rows_total: number;
  rows_valid: number;
  debtors_created: number;
  invoices_created: number;
  invoices_already_imported: number;
  errors: ImportRowIssue[];
  warnings: ImportRowIssue[];
  preview?: ImportPreviewRow[];
}

// GET/POST /api/claims. A claim is frozen when it is created: these are the numbers the server
// calculated then, not what the invoices say today.
export type ClaimEventKind =
  | 'REMINDER_SENT'
  | 'DEMAND_SENT'
  | 'BUROFAX_SENT'
  | 'MONITORIO_FILED'
  | 'PAID'
  | 'NOTE';

export interface ClaimBase {
  id: string;
  debtor_id: string;
  debtor_name: string;
  as_of: string;
  compensation_mode: Compensation;
  principal_cents: number;
  interest_cents: number;
  compensation_cents: number;
  total_cents: number;
}

export interface ClaimSummary extends ClaimBase {
  invoice_count: number;
  last_event: { kind: ClaimEventKind; occurred_on: string } | null;
  // Only the kind of step that is pending, or DONE (paid) / BLOCKED (the debtor is not a business).
  next_action: { action: string; earliest_on: string | null };
}

export interface ClaimLine {
  invoice_id: string;
  number: string;
  principal_cents: number;
  interest_cents: number;
  segments: InterestSegmentData[];
}

export interface ClaimDetail extends ClaimBase {
  lines: ClaimLine[];
}

export interface ClaimsPage {
  claims: ClaimSummary[];
  page: PageInfo;
}
