import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toCents } from '../domain/money.ts';
import { findOrCreateDebtor } from './debtors.ts';
import { PaymentExceedsBalanceError } from './errors.ts';
import { createInvoice } from './invoices.ts';
import { addPayment, listPayments } from './payments.ts';
import { createTestDb, type TestDb } from './test-db.ts';
import { date, newUser } from './test-fixtures.ts';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);
afterAll(async () => {
  await db.close();
});

// A user with one invoice of 1.000,00 EUR (100000 cents).
async function setup() {
  const userId = await newUser(db);
  const debtor = await findOrCreateDebtor(db, userId, { name: 'Acme' });
  const invoice = await createInvoice(db, userId, {
    debtor_id: debtor.id,
    number: 'F-1',
    issue_date: date('2026-01-10'),
    amount_cents: toCents(100_000),
  });
  return { userId, invoice };
}

const pay = (cents: number, paid_on = '2026-02-01') => ({
  paid_on: date(paid_on),
  amount_cents: toCents(cents),
});

describe('addPayment', () => {
  it('records a payment and returns it', async () => {
    const { userId, invoice } = await setup();

    const payment = await addPayment(db, userId, invoice.id, pay(30_000));

    expect(payment).toEqual({
      id: expect.any(String) as string,
      invoice_id: invoice.id,
      paid_on: '2026-02-01',
      amount_cents: 30_000,
    });
  });

  it('accepts a payment of exactly the whole amount', async () => {
    const { userId, invoice } = await setup();

    expect(
      await addPayment(db, userId, invoice.id, pay(100_000)),
    ).not.toBeNull();
  });

  it('refuses one cent above the amount, saying what is left, and writes nothing', async () => {
    const { userId, invoice } = await setup();

    const error: unknown = await addPayment(
      db,
      userId,
      invoice.id,
      pay(100_001),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaymentExceedsBalanceError);
    expect((error as PaymentExceedsBalanceError).remainingCents).toBe(100_000);
    expect(await listPayments(db, userId, invoice.id)).toEqual([]);
  });

  // The behaviour of payments that come one after another. Two payments at the same instant
  // are not covered here on purpose: see the comment on addPayment.
  it('counts the earlier payments: the sum can reach the amount but never pass it', async () => {
    const { userId, invoice } = await setup();

    await addPayment(db, userId, invoice.id, pay(60_000, '2026-02-01'));
    await addPayment(db, userId, invoice.id, pay(25_000, '2026-02-02'));

    await expect(
      addPayment(db, userId, invoice.id, pay(15_001)),
    ).rejects.toMatchObject({
      code: 'PAYMENT_EXCEEDS_BALANCE',
      remainingCents: 15_000,
    });
    expect(
      await addPayment(db, userId, invoice.id, pay(15_000, '2026-02-03')),
    ).not.toBeNull();
    await expect(
      addPayment(db, userId, invoice.id, pay(1)),
    ).rejects.toMatchObject({ remainingCents: 0 });

    const payments = await listPayments(db, userId, invoice.id);
    expect(payments.map((p) => p.amount_cents)).toEqual([
      60_000, 25_000, 15_000,
    ]);
    expect(payments.reduce((sum, p) => sum + p.amount_cents, 0)).toBe(100_000);
  });

  it('answers null for an invoice that does not exist', async () => {
    const { userId } = await setup();

    expect(await addPayment(db, userId, MISSING_ID, pay(1))).toBeNull();
  });

  it('answers null, writing nothing, for an invoice of another user', async () => {
    const { userId, invoice } = await setup();
    const b = await newUser(db);

    expect(await addPayment(db, b, invoice.id, pay(1))).toBeNull();
    expect(await addPayment(db, b, invoice.id, pay(100_000_000))).toBeNull();

    expect(await listPayments(db, userId, invoice.id)).toEqual([]);
    const { rows } = await db.query(
      'select count(*)::int as n from payments where invoice_id = $1',
      [invoice.id],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('counts only the payments of the same invoice', async () => {
    const { userId, invoice } = await setup();
    const debtor = await findOrCreateDebtor(db, userId, { name: 'Beta' });
    const other = await createInvoice(db, userId, {
      debtor_id: debtor.id,
      number: 'F-1',
      issue_date: date('2026-01-10'),
      amount_cents: toCents(100_000),
    });
    await addPayment(db, userId, other.id, pay(100_000));

    expect(
      await addPayment(db, userId, invoice.id, pay(100_000)),
    ).not.toBeNull();
  });
});

describe('listPayments', () => {
  it('lists the payments of the invoice, oldest first', async () => {
    const { userId, invoice } = await setup();
    const late = await addPayment(
      db,
      userId,
      invoice.id,
      pay(100, '2026-03-01'),
    );
    const early = await addPayment(
      db,
      userId,
      invoice.id,
      pay(200, '2026-02-01'),
    );

    expect(await listPayments(db, userId, invoice.id)).toEqual([early, late]);
  });

  it('returns nothing for an invoice of another user or an unknown one', async () => {
    const { userId, invoice } = await setup();
    const b = await newUser(db);
    await addPayment(db, userId, invoice.id, pay(100));

    expect(await listPayments(db, b, invoice.id)).toEqual([]);
    expect(await listPayments(db, userId, MISSING_ID)).toEqual([]);
    expect(await listPayments(db, userId, invoice.id)).toHaveLength(1);
  });
});
