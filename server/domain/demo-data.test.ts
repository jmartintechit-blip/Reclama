import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffDays, type ISODate } from './dates.ts';
import { buildDemoData, demoToday } from './demo-data.ts';
import { calculateDefaultInterest } from './interest.ts';
import { toCents } from './money.ts';
import { parseRates, type LegalRate } from './rates.ts';

const date = (text: string): ISODate => text as ISODate;
const rates = parseRates(
  JSON.parse(
    readFileSync(
      new URL('../../data/legal-interest-rates.json', import.meta.url),
      'utf8',
    ),
  ),
);
// The last day of the last verified semester in data/legal-interest-rates.json.
const LAST_VERIFIED_DAY = date('2026-12-31');

const pending = (row: LegalRate): LegalRate => ({
  ...row,
  status: 'PENDING',
  boe_ref: null,
  published_on: null,
});

describe('demoToday', () => {
  it('is the real day while the verified rates still reach it', () => {
    expect(demoToday(date('2026-10-18'), rates)).toBe('2026-10-18');
    expect(demoToday(LAST_VERIFIED_DAY, rates)).toBe('2026-12-31');
  });

  it('stops at the last day of the last verified semester', () => {
    expect(demoToday(date('2027-01-01'), rates)).toBe('2026-12-31');
    expect(demoToday(date('2027-03-01'), rates)).toBe('2026-12-31');
  });

  it('does not count a PENDING semester', () => {
    const last = rates.at(-1);
    if (!last) throw new Error('no rates');
    const withPendingTail = [...rates.slice(0, -1), pending(last)];

    expect(demoToday(date('2026-10-18'), withPendingTail)).toBe('2026-06-30');
  });

  it('is null when there is no verified rate', () => {
    expect(demoToday(date('2026-10-18'), [])).toBeNull();
    expect(demoToday(date('2026-10-18'), rates.map(pending))).toBeNull();
  });
});

// The three days: a normal one, the last day of the window and one past it (it must clamp).
const DAYS = ['2026-10-18', '2026-12-31', '2027-03-01'].map(date);

describe.each(DAYS)('buildDemoData for the real day %s', (realDay) => {
  const today = demoToday(realDay, rates);
  if (today === null) throw new Error('the rates are not empty');
  const data = buildDemoData(today);

  it('has the promised shape', () => {
    expect(data.debtors.map((debtor) => debtor.kind).sort()).toEqual([
      'BUSINESS',
      'BUSINESS',
      'BUSINESS',
      'CONSUMER',
      'PUBLIC_ADMIN',
      'UNKNOWN',
    ]);
    expect(data.invoices).toHaveLength(14);
    expect(data.payments).toHaveLength(1);
    expect(data.profile.default_compensation).toBe('PER_CLAIM');
    // Every debtor has an invoice and every reference points at something.
    const owners = new Set(data.invoices.map((invoice) => invoice.debtor));
    expect([...owners].sort()).toEqual(data.debtors.map((_, index) => index));
    expect(new Set(data.invoices.map((invoice) => invoice.number)).size).toBe(
      14,
    );
    const names = data.debtors.map((debtor) => debtor.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is relative to the demo day: 11 overdue by 10 to 400 days and 3 not yet due', () => {
    const overdue = data.invoices.filter((invoice) => invoice.dueDate < today);
    const notDue = data.invoices.filter((invoice) => invoice.dueDate > today);

    expect(overdue).toHaveLength(11);
    expect(notDue).toHaveLength(3);
    for (const { dueDate } of overdue) {
      expect(diffDays(today, dueDate)).toBeGreaterThanOrEqual(10);
      expect(diffDays(today, dueDate)).toBeLessThanOrEqual(400);
    }
    for (const { issueDate, dueDate } of data.invoices) {
      expect(issueDate <= dueDate).toBe(true);
      expect(issueDate <= today).toBe(true); // nothing is issued in the future
    }
  });

  it('has one partial payment after the due date and nothing paid in full', () => {
    const [payment] = data.payments;
    const invoice = data.invoices[payment?.invoice ?? -1];
    if (!payment || !invoice) throw new Error('the payment has no invoice');

    expect(payment.amountCents).toBeGreaterThan(0);
    expect(payment.amountCents).toBeLessThan(invoice.amountCents);
    expect(payment.paidOn > invoice.dueDate).toBe(true);
    expect(payment.paidOn <= today).toBe(true);
  });

  it('keeps every due date and every interest calculation inside the verified rates', () => {
    for (const invoice of data.invoices) {
      const paid = data.payments
        .filter((payment) => data.invoices[payment.invoice] === invoice)
        .map((payment) => ({
          paidOn: payment.paidOn,
          amount: toCents(payment.amountCents),
        }));

      // Throws RateWindowError if any day from the due date to the demo day has no verified rate.
      const result = calculateDefaultInterest({
        principal: toCents(invoice.amountCents),
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        asOf: today,
        payments: paid,
        agreedRateBp: null,
        rates,
      });

      expect(result.dueDate).toBe(invoice.dueDate);
      expect(result.warnings).toEqual([]);
      if (invoice.dueDate < today) {
        expect(result.interest).toBeGreaterThan(0);
      } else {
        expect(result.interest).toBe(0);
      }
    }
  });

  it('is fictitious: example emails, made-up tax ids, no phone numbers, only the documentation IBAN', () => {
    expect(data.profile.iban).toBe('ES9121000418450200051332');
    expect(data.profile.business_name).toBe('Estudio Ficticio Norte S.L.');

    for (const debtor of data.debtors) {
      expect(debtor.email).toMatch(/^[a-z0-9.]+@example\.(com|org)$/);
      expect(debtor.name).toMatch(/ejemplo|muestra|ficticia|prueba/i);
      // Letter, digits, check character; the province code 00 is never issued to a real company.
      expect(debtor.taxId).toMatch(
        /^([A-Z]00\d{6}|[A-Z]00\d{5}[A-Z]|0{7}\d[A-Z])$/,
      );
    }
    expect(data.profile.tax_id).toMatch(/^[A-Z]00\d{6}$/);

    // No digit run long enough to be a phone number anywhere but in the IBAN.
    const { iban, ...profileText } = data.profile;
    expect(iban).toMatch(/^ES\d{22}$/);
    const strings = JSON.stringify([profileText, data.debtors, data.invoices]);
    expect(strings).not.toMatch(/\d{9,}/);
    expect(strings).not.toMatch(/\+\d/);
    expect(strings).not.toMatch(/@(?!example\.(com|org)")/);
  });
});

describe('buildDemoData on different days', () => {
  it('keeps the same offsets and amounts, shifted with the day', () => {
    const early = buildDemoData(date('2026-10-18'));
    const late = buildDemoData(date('2026-12-31'));

    for (const [index, invoice] of early.invoices.entries()) {
      const other = late.invoices[index];
      expect(diffDays(other?.dueDate ?? invoice.dueDate, invoice.dueDate)).toBe(
        74, // 18 Oct -> 31 Dec
      );
      expect(other?.amountCents).toBe(invoice.amountCents);
    }
  });
});
