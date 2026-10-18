import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toCents } from '../domain/money.ts';
import type { Db } from './client.ts';
import { findOrCreateDebtor } from './debtors.ts';
import { PaymentExceedsBalanceError } from './errors.ts';
import { createInvoice, getInvoice } from './invoices.ts';
import {
  addPayment,
  listPayments,
  listPaymentsForInvoices,
} from './payments.ts';
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
  // are covered by the trigger tests at the end of this file.
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

describe('addPayment and the PAID status', () => {
  it('sets the invoice to PAID only when the payment brings the balance to zero', async () => {
    const { userId, invoice } = await setup();

    await addPayment(db, userId, invoice.id, pay(40_000));
    expect((await getInvoice(db, userId, invoice.id))?.status).toBe('OPEN');

    await addPayment(db, userId, invoice.id, pay(60_000));
    expect((await getInvoice(db, userId, invoice.id))?.status).toBe('PAID');
  });

  it('does not touch the status when the payment is refused, nor the invoice of another user', async () => {
    const { userId, invoice } = await setup();
    const other = await setup();

    await expect(
      addPayment(db, userId, invoice.id, pay(100_001)),
    ).rejects.toBeInstanceOf(PaymentExceedsBalanceError);
    expect(
      await addPayment(db, userId, other.invoice.id, pay(100_000)),
    ).toBeNull();

    expect((await getInvoice(db, userId, invoice.id))?.status).toBe('OPEN');
    expect((await getInvoice(db, other.userId, other.invoice.id))?.status).toBe(
      'OPEN',
    );
    expect(await listPayments(db, other.userId, other.invoice.id)).toEqual([]);
  });
});

describe('listPaymentsForInvoices', () => {
  it('returns the payments of several invoices in one query, oldest first, and ignores ids of other users', async () => {
    const { userId, invoice } = await setup();
    const second = await createInvoice(db, userId, {
      debtor_id: invoice.debtor_id,
      number: 'F-2',
      issue_date: date('2026-01-10'),
      amount_cents: toCents(50_000),
    });
    const stranger = await setup();
    await addPayment(db, userId, invoice.id, pay(1_000, '2026-03-01'));
    await addPayment(db, userId, second.id, pay(2_000, '2026-02-01'));
    await addPayment(db, stranger.userId, stranger.invoice.id, pay(3_000));

    const payments = await listPaymentsForInvoices(db, userId, [
      invoice.id,
      second.id,
      stranger.invoice.id,
      MISSING_ID,
    ]);

    expect(payments.map((p) => [p.invoice_id, p.amount_cents])).toEqual([
      [second.id, 2_000],
      [invoice.id, 1_000],
    ]);
    expect(await listPaymentsForInvoices(db, userId, [])).toEqual([]);
  });
});

// Two payments that run at the same instant both pass the check inside addPayment (see its
// comment). PGlite has one connection, so the race itself cannot be reproduced here; these tests
// insert with raw SQL, which skips that check, to prove that the database refuses the sum.
describe('the overpayment trigger', () => {
  const insertRaw = (userId: string, invoiceId: string, cents: number) =>
    db.query(
      `insert into payments (user_id, invoice_id, paid_on, amount_cents)
       values ($1, $2, '2026-02-01', $3)`,
      [userId, invoiceId, cents],
    );
  const refused = {
    code: '23514',
    constraint: 'payments_total_within_invoice',
  };

  it('refuses a payment that makes the total pass the amount and accepts one that reaches it', async () => {
    const { userId, invoice } = await setup();

    await insertRaw(userId, invoice.id, 60_000);
    await expect(insertRaw(userId, invoice.id, 60_000)).rejects.toMatchObject(
      refused,
    );
    await insertRaw(userId, invoice.id, 40_000);
    await expect(insertRaw(userId, invoice.id, 1)).rejects.toMatchObject(
      refused,
    );

    // Same date, so the order of the list is not defined: compare the amounts sorted.
    const payments = await listPayments(db, userId, invoice.id);
    expect(payments.map((p) => p.amount_cents).sort((x, y) => x - y)).toEqual([
      40_000, 60_000,
    ]);
  });

  it('refuses one payment above the whole amount, and counts only the same invoice', async () => {
    const { userId, invoice } = await setup();
    const other = await createInvoice(db, userId, {
      debtor_id: invoice.debtor_id,
      number: 'F-2',
      issue_date: date('2026-01-10'),
      amount_cents: toCents(100_000),
    });

    await expect(insertRaw(userId, invoice.id, 100_001)).rejects.toMatchObject(
      refused,
    );
    await insertRaw(userId, other.id, 100_000);
    await insertRaw(userId, invoice.id, 100_000); // not counted against the other invoice
  });

  it('leaves a payment for a missing invoice to the foreign key', async () => {
    const { userId } = await setup();

    await expect(insertRaw(userId, MISSING_ID, 1)).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('is reported by addPayment as PAYMENT_EXCEEDS_BALANCE with the balance left', async () => {
    const { userId, invoice } = await setup();
    await addPayment(db, userId, invoice.id, pay(60_000));
    // The statement of a payment that lost the race: it passes addPayment's own check and the
    // trigger refuses it.
    const racing: Db = {
      query: (sql, params) =>
        sql.includes('with inserted')
          ? Promise.reject(Object.assign(new Error('refused'), refused))
          : db.query(sql, params),
    };

    const error: unknown = await addPayment(
      racing,
      userId,
      invoice.id,
      pay(60_000),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaymentExceedsBalanceError);
    expect((error as PaymentExceedsBalanceError).remainingCents).toBe(40_000);
  });

  it('does not hide other errors of the insert', async () => {
    const { userId, invoice } = await setup();
    const broken: Db = {
      query: () => Promise.reject(new Error('connection reset')),
    };

    await expect(
      addPayment(broken, userId, invoice.id, pay(1)),
    ).rejects.toThrow('connection reset');
  });
});
