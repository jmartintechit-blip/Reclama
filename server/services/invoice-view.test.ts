import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Invoice } from '../db/invoices.ts';
import type { Payment } from '../db/payments.ts';
import type { ISODate } from '../domain/dates.ts';
import { toCents } from '../domain/money.ts';
import { parseRates } from '../domain/rates.ts';
import {
  buildInvoiceView,
  calculateInvoiceInterest,
  summarizeInvoices,
} from './invoice-view.ts';

const rates = parseRates(
  JSON.parse(
    readFileSync(
      new URL('../../data/legal-interest-rates.json', import.meta.url),
      'utf8',
    ),
  ) as unknown,
);
const date = (text: string) => text as ISODate;
const TODAY = date('2026-10-30');

function invoice(patch: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i-1',
    debtor_id: 'd-1',
    number: 'F-1',
    issue_date: date('2026-08-31'),
    due_date: date('2026-09-30'),
    amount_cents: toCents(100_000),
    agreed_rate_bp: null,
    status: 'OPEN',
    ...patch,
  };
}

const payment = (paidOn: string, cents: number): Payment => ({
  id: `p-${paidOn}`,
  invoice_id: 'i-1',
  paid_on: date(paidOn),
  amount_cents: toCents(cents),
});

describe('buildInvoiceView', () => {
  it('shows the interest as of today for 1.000,00 EUR due 30 Sep 2026: 855 cents (E1)', () => {
    const view = buildInvoiceView(invoice(), [], rates, TODAY);

    expect(view).toEqual({
      ...invoice(),
      paid_cents: 0,
      balance_cents: 100_000,
      due_date_effective: '2026-09-30',
      due_date_estimated: false,
      overdue: true,
      days_overdue: 30,
      interest_cents: 855,
      interest_error: null,
    });
  });

  it('uses the payments: 400,00 EUR paid on 10 Oct leaves 627 cents (E12)', () => {
    const view = buildInvoiceView(
      invoice(),
      [payment('2026-10-10', 40_000)],
      rates,
      TODAY,
    );

    expect(view).toMatchObject({
      paid_cents: 40_000,
      balance_cents: 60_000,
      overdue: true,
      interest_cents: 627,
    });
  });

  it('estimates the due date as issue + 30 days when there is none', () => {
    const view = buildInvoiceView(
      invoice({ due_date: null }),
      [],
      rates,
      TODAY,
    );

    expect(view).toMatchObject({
      due_date: null,
      due_date_effective: '2026-09-30',
      due_date_estimated: true,
      days_overdue: 30,
      interest_cents: 855,
    });
  });

  it('is not overdue on the due date, nor before it, and then owes no interest', () => {
    const onDueDate = buildInvoiceView(
      invoice(),
      [],
      rates,
      date('2026-09-30'),
    );
    const before = buildInvoiceView(invoice(), [], rates, date('2026-09-01'));
    const dayAfter = buildInvoiceView(invoice(), [], rates, date('2026-10-01'));

    expect(onDueDate).toMatchObject({
      overdue: false,
      days_overdue: 0,
      interest_cents: 0,
    });
    expect(before).toMatchObject({ overdue: false, interest_cents: 0 });
    expect(dayAfter).toMatchObject({
      overdue: true,
      days_overdue: 1,
      interest_cents: 28, // one day: 100000 * 10.40 % / 365 = 28.49
    });
  });

  it('reports interest_cents null and RATE_WINDOW outside the verified rates, never a guess', () => {
    const old = buildInvoiceView(
      invoice({ issue_date: date('2017-12-01'), due_date: date('2017-12-30') }),
      [],
      rates,
      TODAY,
    );
    const future = buildInvoiceView(invoice(), [], rates, date('2027-01-01'));

    for (const view of [old, future]) {
      expect(view).toMatchObject({
        interest_cents: null,
        interest_error: 'RATE_WINDOW',
        overdue: true,
        balance_cents: 100_000,
      });
    }
    expect(old.due_date_effective).toBe('2017-12-30');
    expect(old.days_overdue).toBe(3226);
  });

  it('needs no rate table when the invoice has an agreed rate', () => {
    const view = buildInvoiceView(
      invoice({ agreed_rate_bp: 1000 }),
      [],
      [],
      TODAY,
    );

    expect(view).toMatchObject({ interest_cents: 822, interest_error: null });
  });

  it('is not overdue when it is fully paid or marked PAID, whatever the balance', () => {
    const paid = buildInvoiceView(
      invoice({ status: 'PAID' }),
      [payment('2026-10-10', 100_000)],
      rates,
      TODAY,
    );
    const marked = buildInvoiceView(
      invoice({ status: 'PAID' }),
      [],
      rates,
      TODAY,
    );

    expect(paid).toMatchObject({
      balance_cents: 0,
      overdue: false,
      days_overdue: 0,
    });
    expect(marked).toMatchObject({ balance_cents: 100_000, overdue: false });
  });

  it('reports CALCULATION_FAILED instead of throwing when payments exceed the invoice', () => {
    const view = buildInvoiceView(
      invoice(),
      [payment('2026-10-01', 100_000), payment('2026-10-02', 5)],
      rates,
      TODAY,
    );

    expect(view).toMatchObject({
      interest_cents: null,
      interest_error: 'CALCULATION_FAILED',
      balance_cents: -5,
      due_date_effective: '2026-09-30',
    });
  });

  it('reports no due date, and no calculation, when issue + 30 days leaves the calendar', () => {
    const view = buildInvoiceView(
      invoice({ issue_date: date('9999-12-31'), due_date: null }),
      [],
      rates,
      TODAY,
    );

    expect(view).toMatchObject({
      due_date_effective: null,
      due_date_estimated: true,
      overdue: false,
      days_overdue: 0,
      interest_cents: null,
      interest_error: 'CALCULATION_FAILED',
    });
  });
});

describe('calculateInvoiceInterest', () => {
  it('gives the semester segments and the missing semesters', () => {
    const ok = calculateInvoiceInterest(
      invoice({
        due_date: date('2026-06-20'),
        amount_cents: toCents(1_000_000),
      }),
      [],
      rates,
      date('2026-07-10'),
    );
    const missing = calculateInvoiceInterest(
      invoice({ issue_date: date('2017-12-01'), due_date: date('2017-12-30') }),
      [],
      rates,
      TODAY,
    );

    expect(ok.ok && ok.result.interest).toBe(5630); // E3: 2781 + 2849
    expect(ok.ok && ok.result.segments.map((s) => s.interest)).toEqual([
      2781, 2849,
    ]);
    expect(missing).toEqual({
      ok: false,
      error: 'RATE_WINDOW',
      missingSemesters: ['2017-H2'],
    });
  });
});

describe('summarizeInvoices', () => {
  it('adds up balance, interest and overdue invoices of the ones that are not PAID', () => {
    const views = [
      buildInvoiceView(invoice({ id: 'a' }), [], rates, TODAY), // 100000, 855, overdue
      buildInvoiceView(
        invoice({ id: 'b', due_date: date('2026-12-01') }),
        [],
        rates,
        TODAY,
      ), // 100000, 0, not overdue
      buildInvoiceView(
        invoice({
          id: 'c',
          issue_date: date('2017-12-01'),
          due_date: date('2017-12-30'),
        }),
        [],
        rates,
        TODAY,
      ), // 100000, unavailable, overdue
      buildInvoiceView(
        invoice({ id: 'd', status: 'PAID' }),
        [payment('2026-10-01', 100_000)],
        rates,
        TODAY,
      ), // settled: counts for nothing
    ];

    expect(summarizeInvoices(views)).toEqual({
      outstanding_cents: 300_000,
      interest_cents: 855,
      overdue_count: 2,
      interest_unavailable_count: 1,
    });
    expect(summarizeInvoices([])).toEqual({
      outstanding_cents: 0,
      interest_cents: 0,
      overdue_count: 0,
      interest_unavailable_count: 0,
    });
  });
});
