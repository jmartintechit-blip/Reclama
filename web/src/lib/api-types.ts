// The shapes of what the API answers for invoices, payments, debtors and interest. They mirror
// the server by hand (the web never imports server code); the server is the authority, and a
// test with a real-looking payload keeps the two honest. Amounts are integer cents everywhere.

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
