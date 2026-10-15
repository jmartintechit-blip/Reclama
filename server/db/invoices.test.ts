import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toCents } from '../domain/money.ts';
import { findOrCreateDebtor, type Debtor } from './debtors.ts';
import type { Db } from './client.ts';
import {
  CLAIM_INVOICE_FK,
  DebtorNotFoundError,
  FOREIGN_KEY_VIOLATION,
  InvoiceDuplicateError,
  InvoiceInClaimError,
} from './errors.ts';
import {
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  setInvoiceStatus,
  updateInvoice,
  type NewInvoice,
} from './invoices.ts';
import { addPayment, listPayments } from './payments.ts';
import { createTestDb, type TestDb } from './test-db.ts';
import { date, newUser, putInClaim } from './test-fixtures.ts';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);
afterAll(async () => {
  await db.close();
});

function invoiceData(debtor: Debtor, patch: Partial<NewInvoice> = {}) {
  return {
    debtor_id: debtor.id,
    number: 'F-1',
    issue_date: date('2026-01-10'),
    due_date: date('2026-02-10'),
    amount_cents: toCents(100_000),
    ...patch,
  };
}

// A user with one debtor and one invoice.
async function setup() {
  const userId = await newUser(db);
  const debtor = await findOrCreateDebtor(db, userId, { name: 'Acme' });
  const invoice = await createInvoice(db, userId, invoiceData(debtor));
  return { userId, debtor, invoice };
}

describe('createInvoice', () => {
  it('creates an invoice with OPEN status and returns it', async () => {
    const userId = await newUser(db);
    const debtor = await findOrCreateDebtor(db, userId, { name: 'Acme' });

    const invoice = await createInvoice(
      db,
      userId,
      invoiceData(debtor, { agreed_rate_bp: 1200 }),
    );

    expect(invoice).toEqual({
      id: expect.any(String) as string,
      debtor_id: debtor.id,
      number: 'F-1',
      issue_date: '2026-01-10',
      due_date: '2026-02-10',
      amount_cents: 100_000,
      agreed_rate_bp: 1200,
      status: 'OPEN',
    });
    expect(await getInvoice(db, userId, invoice.id)).toEqual(invoice);
  });

  it('stores null for a missing due date and agreed rate', async () => {
    const userId = await newUser(db);
    const debtor = await findOrCreateDebtor(db, userId, { name: 'Acme' });

    const invoice = await createInvoice(db, userId, {
      debtor_id: debtor.id,
      number: 'F-9',
      issue_date: date('2026-03-01'),
      amount_cents: toCents(5),
    });

    expect(invoice.due_date).toBeNull();
    expect(invoice.agreed_rate_bp).toBeNull();
  });

  it('refuses a debtor of another user with DebtorNotFoundError and writes nothing', async () => {
    const a = await newUser(db);
    const b = await newUser(db);
    const debtorOfA = await findOrCreateDebtor(db, a, { name: 'Acme' });

    await expect(
      createInvoice(db, b, invoiceData(debtorOfA)),
    ).rejects.toBeInstanceOf(DebtorNotFoundError);

    expect(await listInvoices(db, a)).toEqual([]);
    expect(await listInvoices(db, b)).toEqual([]);
    const { rows } = await db.query(
      'select count(*)::int as n from invoices where debtor_id = $1',
      [debtorOfA.id],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('answers a debtor that does not exist exactly like a debtor of another user', async () => {
    const a = await newUser(db);
    const debtor = await findOrCreateDebtor(db, a, { name: 'Acme' });

    await expect(
      createInvoice(db, a, invoiceData(debtor, { debtor_id: MISSING_ID })),
    ).rejects.toBeInstanceOf(DebtorNotFoundError);
  });

  it('refuses a second invoice with the same number for the same debtor', async () => {
    const { userId, debtor } = await setup();

    await expect(
      createInvoice(db, userId, invoiceData(debtor)),
    ).rejects.toBeInstanceOf(InvoiceDuplicateError);
    expect(await listInvoices(db, userId)).toHaveLength(1);
  });

  it('accepts the same number for another debtor, and for another user', async () => {
    const { userId } = await setup();
    const otherDebtor = await findOrCreateDebtor(db, userId, { name: 'Beta' });
    const b = await newUser(db);
    const debtorOfB = await findOrCreateDebtor(db, b, { name: 'Acme' });

    await createInvoice(db, userId, invoiceData(otherDebtor));
    await createInvoice(db, b, invoiceData(debtorOfB));

    expect(await listInvoices(db, userId)).toHaveLength(2);
    expect(await listInvoices(db, b)).toHaveLength(1);
  });

  it('lets an unrelated database error through as it is', async () => {
    const { userId, debtor } = await setup();

    await expect(
      createInvoice(
        db,
        userId,
        invoiceData(debtor, { number: 'F-2', amount_cents: toCents(0) }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('listInvoices', () => {
  async function threeInvoices() {
    const userId = await newUser(db);
    const debtor = await findOrCreateDebtor(db, userId, { name: 'Acme' });
    const make = (number: string, issue: string) =>
      createInvoice(
        db,
        userId,
        invoiceData(debtor, {
          number,
          issue_date: date(issue),
          due_date: null,
        }),
      );
    const oldest = await make('F-1', '2026-01-01');
    const newest = await make('F-3', '2026-03-01');
    const middle = await make('F-2', '2026-02-01');
    return { userId, oldest, middle, newest };
  }

  it('lists the newest issue date first', async () => {
    const { userId, oldest, middle, newest } = await threeInvoices();

    expect(await listInvoices(db, userId)).toEqual([newest, middle, oldest]);
  });

  it('filters by status', async () => {
    const { userId, oldest, middle, newest } = await threeInvoices();
    await setInvoiceStatus(db, userId, middle.id, 'PAID');
    await setInvoiceStatus(db, userId, oldest.id, 'DISPUTED');

    expect(await listInvoices(db, userId, { status: 'OPEN' })).toEqual([
      newest,
    ]);
    expect(
      (await listInvoices(db, userId, { status: 'PAID' })).map((i) => i.id),
    ).toEqual([middle.id]);
    expect(
      (await listInvoices(db, userId, { status: 'DISPUTED' })).map((i) => i.id),
    ).toEqual([oldest.id]);
    expect(await listInvoices(db, userId)).toHaveLength(3);
  });

  it('pages the result and bounds the page size', async () => {
    const { userId, oldest, middle } = await threeInvoices();

    expect(
      (await listInvoices(db, userId, { limit: 2, offset: 1 })).map(
        (i) => i.id,
      ),
    ).toEqual([middle.id, oldest.id]);
    expect(await listInvoices(db, userId, { limit: 0 })).toHaveLength(1);
    expect(await listInvoices(db, userId, { limit: 10_000_000 })).toHaveLength(
      3,
    );
  });

  it('never lists the invoices of another user, with or without a filter', async () => {
    const { userId } = await threeInvoices();
    const b = await newUser(db);

    expect(await listInvoices(db, b)).toEqual([]);
    expect(await listInvoices(db, b, { status: 'OPEN' })).toEqual([]);
    expect(await listInvoices(db, MISSING_ID)).toEqual([]);
    expect(await listInvoices(db, userId)).toHaveLength(3);
  });
});

describe('getInvoice', () => {
  it('returns null for an invoice of another user or an unknown id', async () => {
    const { userId, invoice } = await setup();
    const b = await newUser(db);

    expect(await getInvoice(db, userId, invoice.id)).toEqual(invoice);
    expect(await getInvoice(db, b, invoice.id)).toBeNull();
    expect(await getInvoice(db, userId, MISSING_ID)).toBeNull();
  });
});

describe('updateInvoice', () => {
  it('changes only the fields in the patch, and null clears the optional ones', async () => {
    const { userId, invoice } = await setup();

    const changed = await updateInvoice(db, userId, invoice.id, {
      number: 'F-1-bis',
      amount_cents: toCents(250_000),
      due_date: null,
      agreed_rate_bp: 900,
    });

    expect(changed).toEqual({
      ...invoice,
      number: 'F-1-bis',
      amount_cents: 250_000,
      due_date: null,
      agreed_rate_bp: 900,
    });
    expect(
      await updateInvoice(db, userId, invoice.id, { agreed_rate_bp: null }),
    ).toMatchObject({ agreed_rate_bp: null, number: 'F-1-bis' });
  });

  it('returns the invoice unchanged for an empty patch', async () => {
    const { userId, invoice } = await setup();

    expect(await updateInvoice(db, userId, invoice.id, {})).toEqual(invoice);
  });

  it('cannot move the invoice to another debtor or user, nor change its status', async () => {
    const { userId, invoice } = await setup();
    const other = await findOrCreateDebtor(db, userId, { name: 'Beta' });

    await updateInvoice(db, userId, invoice.id, {
      number: 'F-7',
      debtor_id: other.id,
      user_id: MISSING_ID,
      status: 'PAID',
    } as { number: string });

    expect(await getInvoice(db, userId, invoice.id)).toEqual({
      ...invoice,
      number: 'F-7',
    });
  });

  it('refuses a number the debtor already uses', async () => {
    const { userId, debtor, invoice } = await setup();
    await createInvoice(db, userId, invoiceData(debtor, { number: 'F-2' }));

    await expect(
      updateInvoice(db, userId, invoice.id, { number: 'F-2' }),
    ).rejects.toBeInstanceOf(InvoiceDuplicateError);
    expect(await getInvoice(db, userId, invoice.id)).toEqual(invoice);
  });

  it('refuses to edit an invoice that is part of a claim and leaves it untouched', async () => {
    const { userId, debtor, invoice } = await setup();
    await putInClaim(db, userId, debtor.id, invoice.id);

    await expect(
      updateInvoice(db, userId, invoice.id, { amount_cents: toCents(1) }),
    ).rejects.toBeInstanceOf(InvoiceInClaimError);
    expect(await getInvoice(db, userId, invoice.id)).toEqual(invoice);
  });

  it('only treats the invoices of the claim as frozen', async () => {
    const { userId, debtor, invoice } = await setup();
    const free = await createInvoice(
      db,
      userId,
      invoiceData(debtor, { number: 'F-2' }),
    );
    await putInClaim(db, userId, debtor.id, invoice.id);

    expect(
      await updateInvoice(db, userId, free.id, { number: 'F-2-bis' }),
    ).toMatchObject({ number: 'F-2-bis' });
  });

  it('answers null, changing nothing, for an invoice of another user', async () => {
    const { userId, invoice } = await setup();
    const b = await newUser(db);

    expect(
      await updateInvoice(db, b, invoice.id, { amount_cents: toCents(1) }),
    ).toBeNull();
    expect(await updateInvoice(db, b, invoice.id, {})).toBeNull();
    expect(
      await updateInvoice(db, userId, MISSING_ID, { number: 'x' }),
    ).toBeNull();
    expect(await getInvoice(db, userId, invoice.id)).toEqual(invoice);
  });

  it('does not tell a claim of another user apart: it cannot freeze this invoice', async () => {
    // The claim line below belongs to user B and points at B's own invoice with the same shape.
    const { userId, invoice } = await setup();
    const other = await setup();
    await putInClaim(db, other.userId, other.debtor.id, other.invoice.id);

    expect(
      await updateInvoice(db, userId, invoice.id, { number: 'still-editable' }),
    ).toMatchObject({ number: 'still-editable' });
  });
});

describe('setInvoiceStatus', () => {
  it('changes the status, also when the invoice is in a claim', async () => {
    const { userId, debtor, invoice } = await setup();
    await putInClaim(db, userId, debtor.id, invoice.id);

    expect(await setInvoiceStatus(db, userId, invoice.id, 'PAID')).toEqual({
      ...invoice,
      status: 'PAID',
    });
  });

  it('answers null, changing nothing, for an invoice of another user or a missing one', async () => {
    const { userId, invoice } = await setup();
    const b = await newUser(db);

    expect(await setInvoiceStatus(db, b, invoice.id, 'PAID')).toBeNull();
    expect(await setInvoiceStatus(db, userId, MISSING_ID, 'PAID')).toBeNull();
    expect(await getInvoice(db, userId, invoice.id)).toEqual(invoice);
  });
});

describe('deleteInvoice', () => {
  it('deletes the invoice and its payments', async () => {
    const { userId, invoice } = await setup();
    await addPayment(db, userId, invoice.id, {
      paid_on: date('2026-02-01'),
      amount_cents: toCents(100),
    });

    expect(await deleteInvoice(db, userId, invoice.id)).toBe(true);

    expect(await getInvoice(db, userId, invoice.id)).toBeNull();
    const { rows } = await db.query(
      'select count(*)::int as n from payments where invoice_id = $1',
      [invoice.id],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('answers false for a missing invoice', async () => {
    const { userId } = await setup();

    expect(await deleteInvoice(db, userId, MISSING_ID)).toBe(false);
  });

  it('answers false, deleting nothing, for an invoice of another user', async () => {
    const { userId, invoice } = await setup();
    const b = await newUser(db);
    await addPayment(db, userId, invoice.id, {
      paid_on: date('2026-02-01'),
      amount_cents: toCents(100),
    });

    expect(await deleteInvoice(db, b, invoice.id)).toBe(false);

    expect(await getInvoice(db, userId, invoice.id)).toEqual(invoice);
    expect(await listPayments(db, userId, invoice.id)).toHaveLength(1);
  });

  it('refuses to delete an invoice that is part of a claim', async () => {
    const { userId, debtor, invoice } = await setup();
    await putInClaim(db, userId, debtor.id, invoice.id);

    await expect(deleteInvoice(db, userId, invoice.id)).rejects.toBeInstanceOf(
      InvoiceInClaimError,
    );
    expect(await getInvoice(db, userId, invoice.id)).toEqual(invoice);
  });

  it('maps the foreign key of the claim lines too (a claim created while the delete runs)', async () => {
    const foreignKeyError = Object.assign(new Error('violates foreign key'), {
      code: FOREIGN_KEY_VIOLATION,
      constraint: CLAIM_INVOICE_FK,
    });
    const failing: Db = { query: () => Promise.reject(foreignKeyError) };

    await expect(
      deleteInvoice(failing, MISSING_ID, MISSING_ID),
    ).rejects.toBeInstanceOf(InvoiceInClaimError);
  });

  it('does not map a foreign key error of another constraint', async () => {
    const other = Object.assign(new Error('violates foreign key'), {
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'something_else_fkey',
    });
    const failing: Db = { query: () => Promise.reject(other) };

    await expect(deleteInvoice(failing, MISSING_ID, MISSING_ID)).rejects.toBe(
      other,
    );
  });
});
