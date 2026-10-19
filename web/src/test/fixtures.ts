// Canned API answers for the invoice screens. Everything is fictitious. The shapes mirror what
// the server sends (see lib/api-types.ts).
import type {
  Debtor,
  Interest,
  InvoiceDetail,
  InvoiceView,
  Payment,
} from '../lib/api-types.ts';
import { todayMadrid } from '../lib/dates.ts';

export const DEBTOR_ID = '5a1f2c3e-0000-4000-8000-0000000000d1';
export const INVOICE_ID = '2b9df557-69f0-4aa3-a1d3-784ea6a42b1c';

export const TODAY = todayMadrid();

// An ISO date `days` away from today (negative: in the past).
export function dayFromToday(days: number): string {
  const [y, m, d] = TODAY.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days));
  return date.toISOString().slice(0, 10);
}

export const debtor = (overrides: Partial<Debtor> = {}): Debtor => ({
  id: DEBTOR_ID,
  name: 'Talleres Ejemplo S.L.',
  tax_id: 'B00000001',
  email: null,
  kind: 'BUSINESS',
  ...overrides,
});

export const invoice = (overrides: Partial<InvoiceView> = {}): InvoiceView => ({
  id: INVOICE_ID,
  debtor_id: DEBTOR_ID,
  number: 'FA-2025-001',
  issue_date: dayFromToday(-420),
  due_date: dayFromToday(-398),
  amount_cents: 184_250,
  agreed_rate_bp: null,
  status: 'OPEN',
  paid_cents: 0,
  balance_cents: 184_250,
  due_date_effective: dayFromToday(-398),
  due_date_estimated: false,
  overdue: true,
  days_overdue: 398,
  interest_cents: 20_532,
  interest_error: null,
  ...overrides,
});

export const detail = (
  overrides: Partial<InvoiceView> = {},
  payments: Payment[] = [],
): { invoice: InvoiceDetail } => ({
  invoice: { ...invoice(overrides), payments },
});

export const payment = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'p-1',
  invoice_id: INVOICE_ID,
  paid_on: '2026-04-15',
  amount_cents: 50_000,
  ...overrides,
});

export const totals = (overrides = {}) => ({
  count: 2,
  outstanding_cents: 1_854_465,
  interest_cents: 71_463,
  overdue_count: 1,
  interest_unavailable_count: 0,
  truncated: false,
  ...overrides,
});

export function invoicesPage(
  invoices: InvoiceView[],
  options: {
    total?: number;
    limit?: number;
    offset?: number;
    totals?: Record<string, unknown>;
  } = {},
) {
  return {
    data: {
      invoices,
      totals: totals({ count: invoices.length, ...options.totals }),
      page: {
        limit: options.limit ?? 50,
        offset: options.offset ?? 0,
        total: options.total ?? invoices.length,
      },
    },
  };
}

export function debtorsPage(debtors: Debtor[]) {
  return {
    data: {
      debtors,
      page: { limit: 100, offset: 0, total: debtors.length },
    },
  };
}

const seg = (
  start: string,
  end: string,
  days: number,
  rate_bp: number,
  balance_cents: number,
  interest_cents: number,
) => ({
  start,
  end,
  days,
  year_days: 365,
  rate_bp,
  balance_cents,
  interest_cents,
});

// The real answer for an invoice due 2025-09-16, 500 EUR paid on 2026-04-15 and calculated on
// 2026-10-19: a semester start, the payment and a rate change.
export const interest = (
  overrides: Partial<Interest> = {},
): { interest: Interest } => ({
  interest: {
    invoice_id: INVOICE_ID,
    as_of: '2026-10-19',
    principal_cents: 184_250,
    paid_cents: 50_000,
    balance_cents: 134_250,
    due_date_effective: '2025-09-16',
    due_date_estimated: false,
    interest_cents: 17_894,
    warnings: [],
    segments: [
      seg('2025-09-17', '2025-12-31', 106, 1015, 184_250, 5431),
      seg('2026-01-01', '2026-04-15', 105, 1015, 184_250, 5380),
      seg('2026-04-16', '2026-06-30', 76, 1015, 134_250, 2837),
      seg('2026-07-01', '2026-10-19', 111, 1040, 134_250, 4246),
    ],
    ...overrides,
  },
});
