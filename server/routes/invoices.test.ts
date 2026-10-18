import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAX_INVOICES_PER_USER } from '../db/invoices.ts';
import { hashKeyPart } from '../db/rate-limits.ts';
import { putInClaim } from '../db/test-fixtures.ts';
import {
  errorOf,
  invoiceOf,
  startTestApp,
  type Answer,
  type DebtorJson,
  type InvoiceJson,
  type PaymentJson,
  type TestApp,
  type TestUser,
} from './test-app.ts';
import { TOTALS_ROW_CAP } from './invoices.ts';

const NOW = '2026-10-30T10:00:00Z'; // 2026-10-30 in Madrid
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const statements: string[] = [];
let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ now: NOW, statements });
}, 30_000);
afterAll(async () => {
  await t.stop();
});
afterEach(() => {
  t.setNow(NOW);
});

// 1.000,00 EUR issued 31 Aug 2026 and due 30 Sep 2026: on 30 Oct it is 30 days late, which is
// 855 cents of interest at 10.40 % (worked example E1).
const BASE = {
  debtor: { name: 'Acme S.L.' },
  number: 'F-1',
  issue_date: '2026-08-31',
  due_date: '2026-09-30',
  amount_cents: 100_000,
};

async function create(
  user: TestUser,
  patch: Record<string, unknown> = {},
): Promise<InvoiceJson> {
  const res = await t.call(user, 'POST', '/api/invoices', {
    ...BASE,
    ...patch,
  });
  expect(res.status, res.text).toBe(201);
  return invoiceOf(res);
}

const pay = (
  user: TestUser,
  invoiceId: string,
  paidOn: string,
  cents: number,
) =>
  t.call(user, 'POST', `/api/invoices/${invoiceId}/payments`, {
    paid_on: paidOn,
    amount_cents: cents,
  });

// Stored payments above the invoice amount cannot be created any more: a database trigger refuses
// them. The tests of how the API copes with such data (for example, rows written before the
// trigger existed) switch the trigger off for the insert and back on right after.
async function insertOverpaid(userId: string, invoiceId: string) {
  await t.db.query('alter table payments disable trigger payments_check_total');
  await t.db.query(
    `insert into payments (user_id, invoice_id, paid_on, amount_cents)
     values ($1, $2, '2026-10-01', 100000), ($1, $2, '2026-10-02', 5)`,
    [userId, invoiceId],
  );
  await t.db.query('alter table payments enable trigger payments_check_total');
}

const get = async (user: TestUser, id: string) =>
  invoiceOf(await t.call(user, 'GET', `/api/invoices/${id}`));

async function count(
  table: 'debtors' | 'invoices' | 'payments',
  user: TestUser,
) {
  const { rows } = await t.db.query(
    `select count(*)::int as n from ${table} where user_id = $1`,
    [user.id],
  );
  return (rows[0] as { n: number }).n;
}

interface Totals {
  count: number;
  outstanding_cents: number;
  interest_cents: number;
  overdue_count: number;
  interest_unavailable_count: number;
  truncated: boolean;
}
interface ListData {
  invoices: InvoiceJson[];
  totals: Totals;
  page: { limit: number; offset: number; total: number };
}
const listOf = (res: Answer) => (res.json as { data: ListData }).data;

describe('POST /api/invoices', () => {
  it('creates an invoice with a new debtor and shows its interest as of today', async () => {
    const user = await t.makeUser();

    const res = await t.call(user, 'POST', '/api/invoices', {
      ...BASE,
      debtor: {
        name: ' Acme S.L. ',
        tax_id: 'b-12 345 678',
        email: 'Pay@Acme.COM',
      },
    });

    expect(res.status).toBe(201);
    expect(invoiceOf(res)).toEqual({
      id: expect.any(String) as string,
      debtor_id: expect.any(String) as string,
      number: 'F-1',
      issue_date: '2026-08-31',
      due_date: '2026-09-30',
      amount_cents: 100_000,
      agreed_rate_bp: null,
      status: 'OPEN',
      paid_cents: 0,
      balance_cents: 100_000,
      due_date_effective: '2026-09-30',
      due_date_estimated: false,
      overdue: true,
      days_overdue: 30,
      interest_cents: 855,
      interest_error: null,
      payments: [],
    });
    const debtors = await t.call(user, 'GET', '/api/debtors');
    expect(
      (debtors.json as { data: { debtors: DebtorJson[] } }).data.debtors,
    ).toMatchObject([
      {
        id: invoiceOf(res).debtor_id,
        name: 'Acme S.L.',
        tax_id: 'B12345678',
        email: 'pay@acme.com',
        kind: 'UNKNOWN',
        invoice_count: 1,
        outstanding_cents: 100_000,
      },
    ]);
  });

  it('finds the debtor again by name and tax id, keeps its stored e-mail, and accepts its id', async () => {
    const user = await t.makeUser();
    const first = await t.call(user, 'POST', '/api/invoices', {
      ...BASE,
      debtor: { name: 'Muñoz S.L.', email: 'first@example.com' },
    });

    const second = await create(user, {
      debtor: { name: 'MUNOZ  s.l.', email: 'second@example.com' },
      number: 'F-2',
    });
    const third = await create(user, {
      debtor: undefined,
      debtor_id: second.debtor_id,
      number: 'F-3',
    });

    expect(second.debtor_id).toBe(invoiceOf(first).debtor_id);
    expect(third.debtor_id).toBe(second.debtor_id);
    expect(await count('debtors', user)).toBe(1);
    const { rows } = await t.db.query(
      'select email from debtors where user_id = $1',
      [user.id],
    );
    expect(rows).toEqual([{ email: 'first@example.com' }]);
  });

  it('estimates the due date as issue + 30 days when none is given', async () => {
    const user = await t.makeUser();

    const missing = await create(user, { due_date: undefined, number: 'F-2' });
    const explicitNull = await create(user, { due_date: null, number: 'F-3' });

    for (const invoice of [missing, explicitNull]) {
      expect(invoice).toMatchObject({
        due_date: null,
        due_date_effective: '2026-09-30',
        due_date_estimated: true,
        days_overdue: 30,
        interest_cents: 855,
      });
    }
  });

  it('uses the agreed rate instead of the legal one', async () => {
    const user = await t.makeUser();

    const invoice = await create(user, { agreed_rate_bp: 1000 });

    // 100.000 cents x 10 % x 30 / 365 = 821.9, rounded half up
    expect(invoice).toMatchObject({
      agreed_rate_bp: 1000,
      interest_cents: 822,
    });
  });

  it('accepts a due date equal to the issue date', async () => {
    const user = await t.makeUser();

    const invoice = await create(user, { due_date: '2026-08-31' });

    expect(invoice.due_date).toBe('2026-08-31');
  });

  it('drops the keys it does not know: status, owner, id, derived figures', async () => {
    const user = await t.makeUser();
    const stranger = await t.makeUser();

    const invoice = await create(user, {
      user_id: stranger.id,
      id: MISSING_ID,
      status: 'PAID',
      paid_cents: 100_000,
      interest_cents: 1,
    });

    expect(invoice).toMatchObject({
      status: 'OPEN',
      paid_cents: 0,
      interest_cents: 855,
    });
    expect(invoice.id).not.toBe(MISSING_ID);
    expect(await count('invoices', user)).toBe(1);
    expect(await count('invoices', stranger)).toBe(0);
  });

  const bad: [string, Record<string, unknown>][] = [
    ['a missing number', { number: undefined }],
    ['a blank number', { number: '   ' }],
    ['a number of 201 characters', { number: 'x'.repeat(201) }],
    ['a number of 5000 characters', { number: 'x'.repeat(5000) }],
    ['a number with a NUL byte', { number: 'F\u00001' }],
    ['a number that is a JSON number', { number: 12345 }],
    ['a zero amount', { amount_cents: 0 }],
    ['a negative amount', { amount_cents: -5 }],
    ['a fractional amount', { amount_cents: 10.5 }],
    ['an amount as text', { amount_cents: '100' }],
    ['a null amount', { amount_cents: null }],
    ['an amount above the maximum', { amount_cents: 100_000_000_001 }],
    ['an unsafe integer amount', { amount_cents: 2 ** 53 }],
    ['a missing issue date', { issue_date: undefined }],
    ['an issue date that does not exist', { issue_date: '2026-02-30' }],
    ['an issue date in dd/mm/yyyy', { issue_date: '30/10/2026' }],
    ['an issue date without zeros', { issue_date: '2026-1-1' }],
    ['an issue date with a time', { issue_date: '2026-10-30T00:00:00Z' }],
    ['an issue date before 1990', { issue_date: '1989-12-31', due_date: null }],
    ['an issue date after 2099', { issue_date: '2100-01-01', due_date: null }],
    ['a due date that is not a date', { due_date: 'soon' }],
    ['a negative agreed rate', { agreed_rate_bp: -1 }],
    ['an agreed rate above 100 %', { agreed_rate_bp: 10_001 }],
    ['a fractional agreed rate', { agreed_rate_bp: 10.5 }],
    ['neither debtor nor debtor_id', { debtor: undefined }],
    ['both debtor and debtor_id', { debtor_id: MISSING_ID }],
    ['a debtor_id that is not a uuid', { debtor: undefined, debtor_id: 'abc' }],
    ['a debtor without a name', { debtor: {} }],
    ['a debtor name of 201 characters', { debtor: { name: 'x'.repeat(201) } }],
    [
      'a debtor tax id of 31 characters',
      { debtor: { name: 'A', tax_id: 'x'.repeat(31) } },
    ],
    [
      'a debtor e-mail that is not valid',
      { debtor: { name: 'A', email: 'nope' } },
    ],
  ];
  it.each(bad)(
    'answers 400 VALIDATION_ERROR for %s and writes nothing',
    async (_name, patch) => {
      const user = await t.makeUser();

      const res = await t.call(user, 'POST', '/api/invoices', {
        ...BASE,
        ...patch,
      });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(res.text.length).toBeLessThan(1000); // no input is echoed back
      expect(await count('invoices', user)).toBe(0);
      expect(await count('debtors', user)).toBe(0);
    },
  );

  it('answers 400 for an array or an empty body', async () => {
    const user = await t.makeUser();

    expect((await t.call(user, 'POST', '/api/invoices', [BASE])).status).toBe(
      400,
    );
    expect((await t.call(user, 'POST', '/api/invoices', {})).status).toBe(400);
  });

  it('answers 422 DUE_BEFORE_ISSUE before touching the database: not even the debtor is created', async () => {
    const user = await t.makeUser();

    const res = await t.call(user, 'POST', '/api/invoices', {
      ...BASE,
      due_date: '2026-08-30',
    });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('DUE_BEFORE_ISSUE');
    expect(await count('debtors', user)).toBe(0);
    expect(await count('invoices', user)).toBe(0);
  });

  it('answers 409 INVOICE_DUPLICATE for the same number of the same debtor only', async () => {
    const user = await t.makeUser();
    const other = await t.makeUser();
    await create(user);

    const again = await t.call(user, 'POST', '/api/invoices', BASE);
    const otherDebtor = await t.call(user, 'POST', '/api/invoices', {
      ...BASE,
      debtor: { name: 'Another S.L.' },
    });
    const otherUser = await t.call(other, 'POST', '/api/invoices', BASE);

    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('INVOICE_DUPLICATE');
    expect(otherDebtor.status).toBe(201);
    expect(otherUser.status).toBe(201);
    expect(await count('invoices', user)).toBe(2);
  });

  it('answers 404 DEBTOR_NOT_FOUND for a debtor_id that does not exist', async () => {
    const user = await t.makeUser();

    const res = await t.call(user, 'POST', '/api/invoices', {
      ...BASE,
      debtor: undefined,
      debtor_id: MISSING_ID,
    });

    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('DEBTOR_NOT_FOUND');
    expect(await count('invoices', user)).toBe(0);
  });

  it('answers 401 without a session', async () => {
    const res = await t.call(null, 'POST', '/api/invoices', BASE);

    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });
});

describe('GET /api/invoices/:id', () => {
  it('returns the invoice with its payments, oldest first', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    const late = await pay(user, invoice.id, '2026-10-20', 10_000);
    const early = await pay(user, invoice.id, '2026-10-10', 40_000);

    const res = await t.call(user, 'GET', `/api/invoices/${invoice.id}`);

    expect(res.status).toBe(200);
    const body = invoiceOf(res);
    expect(body).toMatchObject({
      id: invoice.id,
      paid_cents: 50_000,
      balance_cents: 50_000,
      status: 'OPEN',
    });
    const payments = body.payments as PaymentJson[];
    expect(payments.map((p) => [p.paid_on, p.amount_cents])).toEqual([
      ['2026-10-10', 40_000],
      ['2026-10-20', 10_000],
    ]);
    expect(payments[0]).toEqual(
      (early.json as { data: { payment: PaymentJson } }).data.payment,
    );
    expect(late.status).toBe(201);
  });

  it('answers 404 for an unknown id and for text that is not a uuid', async () => {
    const user = await t.makeUser();

    for (const id of [MISSING_ID, 'not-a-uuid', '123', "x'%20or%201=1"]) {
      const res = await t.call(user, 'GET', `/api/invoices/${id}`);
      expect(res.status, id).toBe(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
    }
  });
});

describe('PATCH /api/invoices/:id', () => {
  it('changes the fields sent, clears due_date and the agreed rate with null, and recalculates', async () => {
    const user = await t.makeUser();
    const invoice = await create(user, { agreed_rate_bp: 500 });

    const res = await t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {
      number: ' F-9 ',
      amount_cents: 150_000,
      due_date: null,
      agreed_rate_bp: 1000,
    });

    expect(res.status).toBe(200);
    expect(invoiceOf(res)).toMatchObject({
      id: invoice.id,
      number: 'F-9',
      amount_cents: 150_000,
      due_date: null,
      due_date_estimated: true,
      due_date_effective: '2026-09-30', // issue + 30 days
      agreed_rate_bp: 1000,
      balance_cents: 150_000,
      interest_cents: 1233, // 150.000 cents x 10 % x 30 / 365 = 1232.88
      status: 'OPEN',
    });

    const cleared = await t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {
      agreed_rate_bp: null,
    });
    expect(invoiceOf(cleared)).toMatchObject({
      agreed_rate_bp: null,
      number: 'F-9',
      interest_cents: 1282, // 150.000 cents x 10.40 % x 30 / 365 = 1282.19
    });
  });

  it('treats an empty body as no change', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);

    const res = await t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {});

    expect(res.status).toBe(200);
    expect(invoiceOf(res)).toEqual({ ...invoice, payments: [] });
  });

  it('checks the order of the dates against the stored row when only one is sent', async () => {
    const user = await t.makeUser();
    const invoice = await create(user); // issue 31 Aug, due 30 Sep
    const patch = (body: unknown) =>
      t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, body);

    const dueTooEarly = await patch({ due_date: '2026-08-30' });
    const issueTooLate = await patch({ issue_date: '2026-10-01' });
    const bothMoved = await patch({
      issue_date: '2026-10-01',
      due_date: '2026-10-15',
    });
    const sameDay = await patch({ due_date: '2026-10-01' });

    for (const res of [dueTooEarly, issueTooLate]) {
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('DUE_BEFORE_ISSUE');
    }
    expect(bothMoved.status).toBe(200);
    expect(sameDay.status).toBe(200); // due == issue
    expect(invoiceOf(sameDay)).toMatchObject({
      issue_date: '2026-10-01',
      due_date: '2026-10-01',
    });
  });

  it('refuses an amount below what is already paid (AMOUNT_BELOW_PAID) and accepts exactly the paid amount', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await pay(user, invoice.id, '2026-10-10', 40_000);
    const patch = (cents: number) =>
      t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {
        amount_cents: cents,
      });

    const below = await patch(39_999);
    expect(below.status).toBe(422);
    expect(errorOf(below)).toMatchObject({
      code: 'AMOUNT_BELOW_PAID',
      details: { paid_cents: 40_000 },
    });
    expect((await get(user, invoice.id)).amount_cents).toBe(100_000);

    // The balance is now zero, so the invoice is PAID.
    const exact = await patch(40_000);
    expect(exact.status).toBe(200);
    expect(invoiceOf(exact)).toMatchObject({
      amount_cents: 40_000,
      balance_cents: 0,
      status: 'PAID',
      overdue: false,
    });
  });

  it('refuses to reopen a fully paid invoice (INVOICE_FULLY_PAID) but allows PAID', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await pay(user, invoice.id, '2026-10-10', 100_000);
    const setStatus = (status: string) =>
      t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, { status });

    for (const status of ['OPEN', 'DISPUTED']) {
      const res = await setStatus(status);
      expect(res.status, status).toBe(422);
      expect(errorOf(res).code).toBe('INVOICE_FULLY_PAID');
    }
    expect((await setStatus('PAID')).status).toBe(200);
    expect((await get(user, invoice.id)).status).toBe('PAID');
  });

  it('reopens an invoice that was PAID by its payments when the amount goes up', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await pay(user, invoice.id, '2026-10-10', 100_000);

    const res = await t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {
      amount_cents: 130_000,
    });

    expect(invoiceOf(res)).toMatchObject({
      status: 'OPEN',
      balance_cents: 30_000,
      overdue: true,
    });
  });

  it('lets the user mark an invoice PAID by hand (paid outside the app) and reopen it', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);

    const paid = await t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {
      status: 'PAID',
    });
    const list = await t.call(user, 'GET', '/api/invoices');

    expect(invoiceOf(paid)).toMatchObject({
      status: 'PAID',
      balance_cents: 100_000, // no payment was recorded
      overdue: false,
      days_overdue: 0,
    });
    // A PAID invoice counts for nothing in the totals.
    expect(listOf(list).totals).toMatchObject({
      count: 1,
      outstanding_cents: 0,
      interest_cents: 0,
      overdue_count: 0,
    });

    const reopened = await t.call(
      user,
      'PATCH',
      `/api/invoices/${invoice.id}`,
      {
        status: 'DISPUTED',
      },
    );
    expect(invoiceOf(reopened)).toMatchObject({
      status: 'DISPUTED',
      overdue: true,
    });
  });

  it('refuses an issue date after an existing payment (PAYMENT_BEFORE_ISSUE)', async () => {
    const user = await t.makeUser();
    const invoice = await create(user, { due_date: null });
    await pay(user, invoice.id, '2026-09-05', 1_000);

    const res = await t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {
      issue_date: '2026-09-06',
    });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('PAYMENT_BEFORE_ISSUE');
    expect((await get(user, invoice.id)).issue_date).toBe('2026-08-31');
  });

  it('answers 409 INVOICE_DUPLICATE for the number of another invoice of the same debtor', async () => {
    const user = await t.makeUser();
    await create(user, { number: 'A' });
    const second = await create(user, { number: 'B' });

    const res = await t.call(user, 'PATCH', `/api/invoices/${second.id}`, {
      number: 'A',
    });
    const same = await t.call(user, 'PATCH', `/api/invoices/${second.id}`, {
      number: 'B',
    });

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('INVOICE_DUPLICATE');
    expect(same.status).toBe(200);
  });

  it('answers 409 INVOICE_IN_CLAIM for the fields of an invoice in a claim, but still lets its status change', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await putInClaim(t.db, user.id, invoice.debtor_id, invoice.id);

    const edit = await t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {
      number: 'CHANGED',
      status: 'DISPUTED',
    });
    const status = await t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {
      status: 'DISPUTED',
    });

    expect(edit.status).toBe(409);
    expect(errorOf(edit).code).toBe('INVOICE_IN_CLAIM');
    // The refused request changed nothing, the status included.
    expect(invoiceOf(status)).toMatchObject({
      number: 'F-1',
      status: 'DISPUTED',
    });
  });

  it('drops the keys it does not know: debtor, owner, derived figures', async () => {
    const user = await t.makeUser();
    const stranger = await t.makeUser();
    const invoice = await create(user);
    const other = await create(user, {
      debtor: { name: 'Other S.L.' },
      number: 'F-2',
    });

    const res = await t.call(user, 'PATCH', `/api/invoices/${invoice.id}`, {
      debtor_id: other.debtor_id,
      user_id: stranger.id,
      id: MISSING_ID,
      paid_cents: 5,
      interest_cents: 1,
      payments: [],
    });

    expect(res.status).toBe(200);
    expect(invoiceOf(res)).toEqual({ ...invoice, payments: [] });
    const { rows } = await t.db.query(
      'select user_id, debtor_id from invoices where id = $1',
      [invoice.id],
    );
    expect(rows).toEqual([{ user_id: user.id, debtor_id: invoice.debtor_id }]);
  });

  const bad: [string, Record<string, unknown>][] = [
    ['an empty number', { number: '' }],
    ['a null number', { number: null }],
    ['a number of 201 characters', { number: 'x'.repeat(201) }],
    ['a zero amount', { amount_cents: 0 }],
    ['a fractional amount', { amount_cents: 1.5 }],
    ['a null amount', { amount_cents: null }],
    ['an amount above the maximum', { amount_cents: 100_000_000_001 }],
    ['a null issue date', { issue_date: null }],
    ['an issue date that does not exist', { issue_date: '2026-13-01' }],
    ['a due date that does not exist', { due_date: '2026-02-30' }],
    ['an unknown status', { status: 'LOST' }],
    ['a lower-case status', { status: 'paid' }],
    ['a null status', { status: null }],
    ['an agreed rate above 100 %', { agreed_rate_bp: 10_001 }],
    ['a negative agreed rate', { agreed_rate_bp: -1 }],
  ];
  it.each(bad)(
    'answers 400 VALIDATION_ERROR for %s and changes nothing',
    async (_name, patch) => {
      const user = await t.makeUser();
      const invoice = await create(user);

      const res = await t.call(
        user,
        'PATCH',
        `/api/invoices/${invoice.id}`,
        patch,
      );

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(await get(user, invoice.id)).toEqual({ ...invoice, payments: [] });
    },
  );

  it('answers 404 for an unknown id and for text that is not a uuid', async () => {
    const user = await t.makeUser();

    for (const id of [MISSING_ID, 'not-a-uuid']) {
      const res = await t.call(user, 'PATCH', `/api/invoices/${id}`, {
        number: 'X',
      });
      expect(res.status, id).toBe(404);
    }
  });
});

describe('DELETE /api/invoices/:id', () => {
  it('deletes the invoice and its payments with 204, and then it is gone', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await pay(user, invoice.id, '2026-10-10', 1_000);

    const res = await t.call(user, 'DELETE', `/api/invoices/${invoice.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(
      (await t.call(user, 'GET', `/api/invoices/${invoice.id}`)).status,
    ).toBe(404);
    expect(await count('payments', user)).toBe(0);
    expect(
      (await t.call(user, 'DELETE', `/api/invoices/${invoice.id}`)).status,
    ).toBe(404);
    expect(
      (await t.call(user, 'DELETE', '/api/invoices/not-a-uuid')).status,
    ).toBe(404);
  });

  it('answers 409 INVOICE_IN_CLAIM for an invoice in a claim and keeps it', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await putInClaim(t.db, user.id, invoice.debtor_id, invoice.id);

    const res = await t.call(user, 'DELETE', `/api/invoices/${invoice.id}`);

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('INVOICE_IN_CLAIM');
    expect((await get(user, invoice.id)).id).toBe(invoice.id);
  });
});

describe('POST /api/invoices/:id/payments', () => {
  it('records a partial payment, then the payment that settles the invoice sets it to PAID', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);

    const first = await pay(user, invoice.id, '2026-10-10', 40_000);

    expect(first.status).toBe(201);
    const firstBody = first.json as {
      data: { payment: PaymentJson; invoice: InvoiceJson };
    };
    expect(firstBody.data.payment).toEqual({
      id: expect.any(String) as string,
      invoice_id: invoice.id,
      paid_on: '2026-10-10',
      amount_cents: 40_000,
    });
    expect(firstBody.data.invoice).toMatchObject({
      status: 'OPEN',
      paid_cents: 40_000,
      balance_cents: 60_000,
      overdue: true,
      interest_cents: 627, // worked example E12: 285 + 342
      payments: [firstBody.data.payment],
    });

    const second = await pay(user, invoice.id, '2026-10-20', 60_000);

    expect(second.status).toBe(201);
    expect(invoiceOf(second)).toMatchObject({
      status: 'PAID',
      paid_cents: 100_000,
      balance_cents: 0,
      overdue: false,
      days_overdue: 0,
      interest_cents: 456, // 285 (10 days on 100.000) + 171 (10 days on 60.000)
    });
    expect((await get(user, invoice.id)).status).toBe('PAID');
  });

  it('refuses a payment above the balance (PAYMENT_EXCEEDS_BALANCE) and says how much is left', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await pay(user, invoice.id, '2026-10-10', 40_000);

    const res = await pay(user, invoice.id, '2026-10-11', 60_001);

    expect(res.status).toBe(422);
    expect(errorOf(res)).toMatchObject({
      code: 'PAYMENT_EXCEEDS_BALANCE',
      details: { remaining_cents: 60_000 },
    });
    expect((await get(user, invoice.id)).paid_cents).toBe(40_000);

    await pay(user, invoice.id, '2026-10-12', 60_000);
    const settled = await pay(user, invoice.id, '2026-10-13', 1);
    expect(errorOf(settled)).toMatchObject({
      code: 'PAYMENT_EXCEEDS_BALANCE',
      details: { remaining_cents: 0 },
    });
  });

  it('judges "the future" by the calendar day in Madrid', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);

    const tomorrow = await pay(user, invoice.id, '2026-10-31', 1_000);
    t.setNow('2026-10-30T23:30:00Z'); // 31 Oct 00:30 in Madrid
    const todayInMadrid = await pay(user, invoice.id, '2026-10-31', 1_000);
    const dayAfter = await pay(user, invoice.id, '2026-11-01', 1_000);

    expect(tomorrow.status).toBe(422);
    expect(errorOf(tomorrow).code).toBe('PAYMENT_IN_FUTURE');
    expect(todayInMadrid.status).toBe(201);
    expect(dayAfter.status).toBe(422);
    expect(await count('payments', user)).toBe(1);
  });

  it('refuses a payment before the issue date (PAYMENT_BEFORE_ISSUE) and accepts the issue date itself', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);

    const before = await pay(user, invoice.id, '2026-08-30', 1_000);
    const onTheDay = await pay(user, invoice.id, '2026-08-31', 1_000);

    expect(before.status).toBe(422);
    expect(errorOf(before).code).toBe('PAYMENT_BEFORE_ISSUE');
    expect(onTheDay.status).toBe(201);
  });

  it('accepts a payment on an invoice that is in a claim', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await putInClaim(t.db, user.id, invoice.debtor_id, invoice.id);

    const res = await pay(user, invoice.id, '2026-10-10', 100_000);

    expect(res.status).toBe(201);
    expect(invoiceOf(res).status).toBe('PAID');
  });

  const bad: [string, unknown][] = [
    ['a zero amount', { paid_on: '2026-10-10', amount_cents: 0 }],
    ['a negative amount', { paid_on: '2026-10-10', amount_cents: -1 }],
    ['a fractional amount', { paid_on: '2026-10-10', amount_cents: 0.5 }],
    ['an amount as text', { paid_on: '2026-10-10', amount_cents: '100' }],
    ['a missing amount', { paid_on: '2026-10-10' }],
    ['a missing date', { amount_cents: 100 }],
    [
      'a date that does not exist',
      { paid_on: '2026-02-30', amount_cents: 100 },
    ],
    ['a date in dd/mm/yyyy', { paid_on: '10/10/2026', amount_cents: 100 }],
    [
      'a date of 5000 characters',
      { paid_on: 'x'.repeat(5000), amount_cents: 100 },
    ],
    ['an array', [{ paid_on: '2026-10-10', amount_cents: 100 }]],
  ];
  it.each(bad)(
    'answers 400 VALIDATION_ERROR for %s and records nothing',
    async (_name, body) => {
      const user = await t.makeUser();
      const invoice = await create(user);

      const res = await t.call(
        user,
        'POST',
        `/api/invoices/${invoice.id}/payments`,
        body,
      );

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(res.text.length).toBeLessThan(1000);
      expect(await count('payments', user)).toBe(0);
    },
  );

  it('drops the keys it does not know', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    const stranger = await t.makeUser();

    const res = await t.call(
      user,
      'POST',
      `/api/invoices/${invoice.id}/payments`,
      {
        paid_on: '2026-10-10',
        amount_cents: 1_000,
        user_id: stranger.id,
        invoice_id: MISSING_ID,
        id: MISSING_ID,
      },
    );

    expect(res.status).toBe(201);
    const { rows } = await t.db.query(
      'select user_id, invoice_id from payments',
    );
    expect(rows).toContainEqual({ user_id: user.id, invoice_id: invoice.id });
    expect(await count('payments', stranger)).toBe(0);
  });

  it('answers 404 for an unknown id and for text that is not a uuid', async () => {
    const user = await t.makeUser();

    for (const id of [MISSING_ID, 'not-a-uuid']) {
      const res = await pay(user, id, '2026-10-10', 100);
      expect(res.status, id).toBe(404);
    }
  });
});

interface InterestData {
  interest: {
    invoice_id: string;
    as_of: string;
    principal_cents: number;
    paid_cents: number;
    balance_cents: number;
    due_date_effective: string;
    due_date_estimated: boolean;
    interest_cents: number;
    warnings: string[];
    segments: Record<string, unknown>[];
  };
}
const interestOf = (res: Answer) =>
  (res.json as { data: InterestData }).data.interest;

describe('GET /api/invoices/:id/interest', () => {
  it('returns the breakdown as of today by default: 855 cents in one segment (E1)', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);

    const res = await t.call(
      user,
      'GET',
      `/api/invoices/${invoice.id}/interest`,
    );

    expect(res.status).toBe(200);
    expect(interestOf(res)).toEqual({
      invoice_id: invoice.id,
      as_of: '2026-10-30',
      principal_cents: 100_000,
      paid_cents: 0,
      balance_cents: 100_000,
      due_date_effective: '2026-09-30',
      due_date_estimated: false,
      interest_cents: 855,
      warnings: [],
      segments: [
        {
          start: '2026-10-01',
          end: '2026-10-30',
          days: 30,
          year_days: 365,
          rate_bp: 1040,
          balance_cents: 100_000,
          interest_cents: 855,
        },
      ],
    });
  });

  it('gives the same figure as the invoice view and the list', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await pay(user, invoice.id, '2026-10-10', 40_000);

    const view = await get(user, invoice.id);
    const breakdown = interestOf(
      await t.call(user, 'GET', `/api/invoices/${invoice.id}/interest`),
    );
    const listed = listOf(await t.call(user, 'GET', '/api/invoices'))
      .invoices[0];

    expect(breakdown.interest_cents).toBe(627);
    expect(view.interest_cents).toBe(627);
    expect(listed?.interest_cents).toBe(627);
  });

  it('splits at the semester change: 2.781 + 2.849 = 5.630 cents (E3)', async () => {
    const user = await t.makeUser();
    const invoice = await create(user, {
      issue_date: '2026-05-21',
      due_date: '2026-06-20',
      amount_cents: 1_000_000,
    });

    const res = await t.call(
      user,
      'GET',
      `/api/invoices/${invoice.id}/interest?as_of=2026-07-10`,
    );

    const breakdown = interestOf(res);
    expect(breakdown).toMatchObject({
      as_of: '2026-07-10',
      interest_cents: 5630,
    });
    expect(
      breakdown.segments.map((s) => [
        s.start,
        s.end,
        s.days,
        s.rate_bp,
        s.interest_cents,
      ]),
    ).toEqual([
      ['2026-06-21', '2026-06-30', 10, 1015, 2781],
      ['2026-07-01', '2026-07-10', 10, 1040, 2849],
    ]);
  });

  it('applies the payments made up to as_of only, and shows the balance of that day', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await pay(user, invoice.id, '2026-10-10', 40_000);

    const before = interestOf(
      await t.call(
        user,
        'GET',
        `/api/invoices/${invoice.id}/interest?as_of=2026-10-05`,
      ),
    );
    const after = interestOf(
      await t.call(
        user,
        'GET',
        `/api/invoices/${invoice.id}/interest?as_of=2026-10-30`,
      ),
    );

    expect(before).toMatchObject({
      paid_cents: 0,
      balance_cents: 100_000,
      interest_cents: 142, // 5 days
    });
    expect(after).toMatchObject({
      paid_cents: 40_000,
      balance_cents: 60_000,
      interest_cents: 627,
    });
  });

  it('is zero, with no segments, on the due date and before it', async () => {
    const user = await t.makeUser();
    const invoice = await create(user, { due_date: null });

    for (const asOf of ['2026-09-30', '2026-09-01', '2026-01-01']) {
      const res = await t.call(
        user,
        'GET',
        `/api/invoices/${invoice.id}/interest?as_of=${asOf}`,
      );
      expect(interestOf(res)).toMatchObject({
        interest_cents: 0,
        segments: [],
        due_date_estimated: true,
        due_date_effective: '2026-09-30',
      });
    }
  });

  it('warns when the agreed term is over 60 days', async () => {
    const user = await t.makeUser();
    const invoice = await create(user, {
      issue_date: '2026-06-01',
      due_date: '2026-08-15',
    });

    const res = await t.call(
      user,
      'GET',
      `/api/invoices/${invoice.id}/interest`,
    );

    expect(interestOf(res).warnings).toEqual(['TERM_OVER_60_DAYS']);
  });

  it('answers 422 RATE_WINDOW with the missing semesters, never a guess', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    const old = await create(user, {
      number: 'OLD',
      issue_date: '2017-12-01',
      due_date: '2017-12-30',
    });

    const future = await t.call(
      user,
      'GET',
      `/api/invoices/${invoice.id}/interest?as_of=2027-01-01`,
    );
    const past = await t.call(user, 'GET', `/api/invoices/${old.id}/interest`);

    expect(future.status).toBe(422);
    expect(errorOf(future)).toMatchObject({
      code: 'RATE_WINDOW',
      details: { missing_semesters: ['2027-H1'] },
    });
    expect(past.status).toBe(422);
    expect(errorOf(past).details).toEqual({ missing_semesters: ['2017-H2'] });
  });

  it('still works outside the rate window when the invoice has an agreed rate', async () => {
    const user = await t.makeUser();
    const invoice = await create(user, { agreed_rate_bp: 1000 });

    const res = await t.call(
      user,
      'GET',
      `/api/invoices/${invoice.id}/interest?as_of=2027-03-01`,
    );

    expect(res.status).toBe(200);
    expect(interestOf(res).interest_cents).toBeGreaterThan(0);
  });

  it('answers 422 CALCULATION_FAILED when the stored payments exceed the invoice', async () => {
    const user = await t.makeUser();
    const invoice = await create(user);
    await insertOverpaid(user.id, invoice.id);

    const res = await t.call(
      user,
      'GET',
      `/api/invoices/${invoice.id}/interest`,
    );

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('CALCULATION_FAILED');
  });

  it.each([
    '?as_of=2026-02-30',
    '?as_of=tomorrow',
    '?as_of=30/10/2026',
    '?as_of=2026-10-30T00:00:00Z',
    '?as_of=2026-10-30&as_of=2026-10-31',
    '?as_of=',
    '?as_of=2100-01-01',
    '?as_of=1989-12-31',
  ])('answers 400 for as_of %s', async (query) => {
    const user = await t.makeUser();
    const invoice = await create(user);

    const res = await t.call(
      user,
      'GET',
      `/api/invoices/${invoice.id}/interest${query}`,
    );

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('answers 404 for an unknown id and for text that is not a uuid', async () => {
    const user = await t.makeUser();

    for (const id of [MISSING_ID, 'not-a-uuid']) {
      const res = await t.call(user, 'GET', `/api/invoices/${id}/interest`);
      expect(res.status, id).toBe(404);
    }
  });
});

// 130 invoices in four debtors, created by the CSV import (so the imported invoices are shown too).
const CSV_HEADER =
  'Factura;Cliente;NIF/CIF;Email;Fecha emisión;Vencimiento;Importe';
const numbered = (prefix: string, n: number, rest: (i: string) => string) =>
  Array.from({ length: n }, (_, i) => {
    const id = String(i + 1).padStart(3, '0');
    return `${prefix}-${id};${rest(id)}`;
  });
const IMPORTED_CSV = [
  CSV_HEADER,
  // 60 x 1.000,00 EUR, due 30 Sep 2026: 30 days late, 855 cents each
  ...numbered('A', 60, () => 'Alfa S.L.;;;01/08/2026;30/09/2026;1000,00'),
  // 40 x 500,00 EUR, due in December: not overdue
  ...numbered('B', 40, () => 'Beta S.L.;;;01/10/2026;01/12/2026;500,00'),
  // 25 x 200,00 EUR, due in February 2016: before the first verified rate
  ...numbered('G', 25, () => 'Gamma S.L.;;;01/01/2016;01/02/2016;200,00'),
  // 5 x 1.000,00 EUR without a due date: issue + 30 days = 30 Sep 2026
  ...numbered('D', 5, () => 'Delta S.L.;;;31/08/2026;;1000,00'),
].join('\n');

describe('GET /api/invoices', () => {
  let user: TestUser;
  let debtors: Record<string, string>;
  beforeAll(async () => {
    user = await t.makeUser();
    const imported = await t.call(user, 'POST', '/api/imports', {
      csv_base64: Buffer.from(IMPORTED_CSV).toString('base64'),
    });
    expect(imported.status, imported.text).toBe(200);
    const list = await t.call(user, 'GET', '/api/debtors');
    debtors = Object.fromEntries(
      (list.json as { data: { debtors: DebtorJson[] } }).data.debtors.map(
        (d) => [d.name, d.id],
      ),
    );
  });

  const ALL_TOTALS: Totals = {
    count: 130,
    // 60 + 5 invoices of 100.000, 40 of 50.000, 25 of 20.000
    outstanding_cents: 9_000_000,
    interest_cents: 65 * 855, // Beta owes 0 and the Gamma interest is unavailable
    overdue_count: 90, // Alfa 60 + Gamma 25 + Delta 5
    interest_unavailable_count: 25,
    truncated: false,
  };

  it('shows the first page and the totals of ALL the invoices, not only of the page', async () => {
    const res = await t.call(user, 'GET', '/api/invoices?limit=10');

    expect(res.status).toBe(200);
    const data = listOf(res);
    expect(data.invoices).toHaveLength(10);
    expect(data.page).toEqual({ limit: 10, offset: 0, total: 130 });
    expect(data.totals).toEqual(ALL_TOTALS);
  });

  it('pages through every invoice once, newest issue date first, with constant totals', async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < 140; offset += 50) {
      const res = await t.call(
        user,
        'GET',
        `/api/invoices?limit=50&offset=${String(offset)}`,
      );
      const data = listOf(res);
      expect(data.totals).toEqual(ALL_TOTALS);
      expect(data.page).toEqual({ limit: 50, offset, total: 130 });
      seen.push(...data.invoices.map((i) => i.number));
    }

    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
    // Issue date descending, then number descending: Beta (1 Oct), Alfa (1 Aug)... Gamma (2016) last.
    expect(seen[0]).toBe('B-040');
    expect(seen[39]).toBe('B-001');
    expect(seen[40]).toBe('D-005'); // 31 Aug
    expect(seen.at(-1)).toBe('G-001');
  });

  it('uses 50 as the default page size and returns nothing past the end', async () => {
    const first = listOf(await t.call(user, 'GET', '/api/invoices'));
    const past = listOf(await t.call(user, 'GET', '/api/invoices?offset=130'));

    expect(first.invoices).toHaveLength(50);
    expect(first.page.limit).toBe(50);
    expect(past.invoices).toEqual([]);
    expect(past.totals).toEqual(ALL_TOTALS);
  });

  it('shows exact figures for an overdue, a not yet due, an estimated and an out-of-window invoice', async () => {
    const data = listOf(
      await t.call(user, 'GET', '/api/invoices?limit=100&offset=0'),
    );
    const more = listOf(
      await t.call(user, 'GET', '/api/invoices?limit=100&offset=100'),
    );
    const byNumber = new Map(
      [...data.invoices, ...more.invoices].map((i) => [i.number, i]),
    );

    expect(byNumber.get('A-003')).toEqual({
      id: expect.any(String) as string,
      debtor_id: debtors['Alfa S.L.'],
      number: 'A-003',
      issue_date: '2026-08-01',
      due_date: '2026-09-30',
      amount_cents: 100_000,
      agreed_rate_bp: null,
      status: 'OPEN',
      paid_cents: 0,
      balance_cents: 100_000,
      due_date_effective: '2026-09-30',
      due_date_estimated: false,
      overdue: true,
      days_overdue: 30,
      interest_cents: 855,
      interest_error: null,
    });
    expect(byNumber.get('B-001')).toMatchObject({
      overdue: false,
      days_overdue: 0,
      interest_cents: 0,
      interest_error: null,
      balance_cents: 50_000,
    });
    expect(byNumber.get('D-002')).toMatchObject({
      due_date: null,
      due_date_effective: '2026-09-30',
      due_date_estimated: true,
      interest_cents: 855,
    });
    expect(byNumber.get('G-001')).toMatchObject({
      due_date_effective: '2016-02-01',
      overdue: true,
      days_overdue: 3924,
      interest_cents: null,
      interest_error: 'RATE_WINDOW',
    });
    // The list does not carry the payments (the detail does).
    expect(byNumber.get('A-003')).not.toHaveProperty('payments');
  });

  it('filters by debtor and the totals follow the filter', async () => {
    const res = await t.call(
      user,
      'GET',
      `/api/invoices?debtor_id=${debtors['Gamma S.L.'] ?? ''}&limit=5`,
    );

    const data = listOf(res);
    expect(data.page).toEqual({ limit: 5, offset: 0, total: 25 });
    expect(
      data.invoices.every((i) => i.debtor_id === debtors['Gamma S.L.']),
    ).toBe(true);
    expect(data.totals).toEqual({
      count: 25,
      outstanding_cents: 500_000,
      interest_cents: 0,
      overdue_count: 25,
      interest_unavailable_count: 25,
      truncated: false,
    });
  });

  it('adds the interest of the invoices that can be calculated and counts the others apart', async () => {
    const res = await t.call(
      user,
      'GET',
      `/api/invoices?debtor_id=${debtors['Delta S.L.'] ?? ''}`,
    );

    expect(listOf(res).totals).toMatchObject({
      count: 5,
      interest_cents: 5 * 855,
      interest_unavailable_count: 0,
    });
  });

  it('computes the payments of the page and of the totals in ONE query', async () => {
    statements.length = 0;

    const res = await t.call(user, 'GET', '/api/invoices?limit=100');

    expect(res.status).toBe(200);
    expect(statements.filter((sql) => /from payments/.test(sql))).toHaveLength(
      1,
    );
    expect(
      statements.filter((sql) => /any\(\$2::uuid\[\]\)/.test(sql)),
    ).toHaveLength(1);
    // session, count, page, cap list, rates, payments: a fixed number whatever the rows
    expect(statements.length).toBeLessThanOrEqual(8);
  });

  it('answers 400 for a query that is not valid', async () => {
    const queries = [
      '?status=LOST',
      '?status=open',
      '?status=OPEN&status=PAID',
      '?debtor_id=abc',
      '?debtor_id=',
      '?limit=0',
      '?limit=101',
      '?limit=ten',
      '?limit=2.5',
      '?offset=-1',
      '?offset=1e3',
    ];
    for (const query of queries) {
      const res = await t.call(user, 'GET', `/api/invoices${query}`);
      expect(res.status, query).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
  });

  it('ignores a query key it does not know', async () => {
    const res = await t.call(
      user,
      'GET',
      '/api/invoices?limit=1&user_id=x&sort=amount',
    );

    expect(res.status).toBe(200);
    expect(listOf(res).invoices).toHaveLength(1);
  });

  it('answers 401 without a session', async () => {
    const res = await t.call(null, 'GET', '/api/invoices');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/invoices with statuses and a failing invoice', () => {
  it('filters by status and leaves PAID invoices out of the totals', async () => {
    const user = await t.makeUser();
    const open = await create(user, { number: 'OPEN' }); // overdue, 855
    const paid = await create(user, { number: 'PAID' });
    const disputed = await create(user, { number: 'DISPUTED' });
    await pay(user, paid.id, '2026-10-10', 100_000);
    await t.call(user, 'PATCH', `/api/invoices/${disputed.id}`, {
      status: 'DISPUTED',
    });
    const ids = (res: Answer) => listOf(res).invoices.map((i) => i.id);

    const all = listOf(await t.call(user, 'GET', '/api/invoices'));
    const onlyOpen = await t.call(user, 'GET', '/api/invoices?status=OPEN');
    const onlyPaid = await t.call(user, 'GET', '/api/invoices?status=PAID');
    const onlyDisputed = await t.call(
      user,
      'GET',
      '/api/invoices?status=DISPUTED',
    );

    expect(ids(onlyOpen)).toEqual([open.id]);
    expect(ids(onlyPaid)).toEqual([paid.id]);
    expect(ids(onlyDisputed)).toEqual([disputed.id]);
    expect(all.totals).toEqual({
      count: 3,
      outstanding_cents: 200_000, // the PAID invoice owes nothing
      interest_cents: 1_710,
      overdue_count: 2,
      interest_unavailable_count: 0,
      truncated: false,
    });
    expect(listOf(onlyPaid).totals).toEqual({
      count: 1,
      outstanding_cents: 0,
      interest_cents: 0,
      overdue_count: 0,
      interest_unavailable_count: 0,
      truncated: false,
    });
    expect(listOf(onlyPaid).page.total).toBe(1);
    // The PAID invoice still shows its own figures: 10 days of interest accrued before it was paid.
    expect(listOf(onlyPaid).invoices[0]).toMatchObject({
      status: 'PAID',
      balance_cents: 0,
      interest_cents: 285,
    });
  });

  it('shows an invoice the engine cannot handle as an error row instead of failing the whole list', async () => {
    const user = await t.makeUser();
    const good = await create(user, { number: 'GOOD' });
    const overpaid = await create(user, { number: 'OVERPAID' });
    await insertOverpaid(user.id, overpaid.id);
    await t.db.query(
      `insert into invoices (user_id, debtor_id, number, issue_date, amount_cents)
       values ($1, $2, 'FAR', '9999-12-31', 100000)`,
      [user.id, good.debtor_id],
    );

    const res = await t.call(user, 'GET', '/api/invoices');

    expect(res.status).toBe(200);
    const byNumber = new Map(listOf(res).invoices.map((i) => [i.number, i]));
    expect(byNumber.get('GOOD')).toMatchObject({
      interest_cents: 855,
      interest_error: null,
    });
    expect(byNumber.get('OVERPAID')).toMatchObject({
      interest_cents: null,
      interest_error: 'CALCULATION_FAILED',
      balance_cents: -5,
    });
    expect(byNumber.get('FAR')).toMatchObject({
      due_date_effective: null,
      overdue: false,
      interest_cents: null,
      interest_error: 'CALCULATION_FAILED',
    });
    expect(listOf(res).totals).toMatchObject({
      count: 3,
      interest_cents: 855,
      interest_unavailable_count: 2,
    });
  });
});

describe('GET /api/invoices totals cap', () => {
  it('sums at most the first 2.000 invoices and says so with truncated', async () => {
    const user = await t.makeUser();
    const first = await create(user, { amount_cents: 1_000 });
    // Newer than the first invoice, so they come first in the list and fill the cap.
    await t.db.query(
      `insert into invoices (user_id, debtor_id, number, issue_date, due_date, amount_cents)
       select $1, $2, 'T-' || g, '2026-10-01', '2026-12-01', 1000
         from generate_series(1, ${String(TOTALS_ROW_CAP)}) g`,
      [user.id, first.debtor_id],
    );

    const over = listOf(await t.call(user, 'GET', '/api/invoices?limit=1'));
    await t.db.query(
      `delete from invoices where user_id = $1 and number = 'T-1'`,
      [user.id],
    );
    const exact = listOf(await t.call(user, 'GET', '/api/invoices?limit=1'));

    expect(over.page.total).toBe(TOTALS_ROW_CAP + 1);
    expect(over.totals).toMatchObject({
      count: TOTALS_ROW_CAP + 1,
      outstanding_cents: TOTALS_ROW_CAP * 1_000, // the 2.001st invoice is not in the sum
      truncated: true,
    });
    expect(exact.totals).toMatchObject({
      count: TOTALS_ROW_CAP,
      outstanding_cents: TOTALS_ROW_CAP * 1_000,
      truncated: false,
    });
  }, 60_000);
});

describe('invoice limit per user', () => {
  it('refuses the invoice after the limit with INVOICE_LIMIT_REACHED, creating nothing', async () => {
    const user = await t.makeUser();
    const first = await create(user, { number: 'A-0' });
    // Everything but one place is taken (written straight to the database).
    await t.db.query(
      `insert into invoices (user_id, debtor_id, number, issue_date, amount_cents)
       select $1, $2, 'A-' || g, '2026-01-01', 1000 from generate_series(1, $3::int) g`,
      [user.id, first.debtor_id, MAX_INVOICES_PER_USER - 2],
    );

    const last = await t.call(user, 'POST', '/api/invoices', {
      ...BASE,
      number: 'LAST',
    });
    const over = await t.call(user, 'POST', '/api/invoices', {
      ...BASE,
      number: 'OVER',
      debtor: { name: 'Brand new debtor' },
    });

    expect(last.status).toBe(201);
    expect(over.status).toBe(422);
    expect(errorOf(over)).toMatchObject({
      code: 'INVOICE_LIMIT_REACHED',
      details: { limit: MAX_INVOICES_PER_USER },
    });
    expect(await count('invoices', user)).toBe(MAX_INVOICES_PER_USER);
    expect(await count('debtors', user)).toBe(1); // the refused request did not create its debtor
    // The limit is per user.
    const other = await t.makeUser();
    expect((await t.call(other, 'POST', '/api/invoices', BASE)).status).toBe(
      201,
    );
  }, 60_000);
});

describe('write rate limit', () => {
  it('allows 120 writes per hour per user, shared by all the write routes, and not for reads', async () => {
    const user = await t.makeUser();
    const other = await t.makeUser();

    for (let i = 0; i < 120; i += 1) {
      const res = await t.call(user, 'DELETE', `/api/invoices/${MISSING_ID}`);
      expect(res.status, String(i)).toBe(404);
    }

    const blocked = [
      await t.call(user, 'DELETE', `/api/invoices/${MISSING_ID}`),
      await t.call(user, 'POST', '/api/invoices', BASE),
      await t.call(user, 'PATCH', `/api/invoices/${MISSING_ID}`, {
        number: 'X',
      }),
      await t.call(user, 'POST', `/api/invoices/${MISSING_ID}/payments`, {
        paid_on: '2026-10-01',
        amount_cents: 1,
      }),
      await t.call(user, 'PATCH', `/api/debtors/${MISSING_ID}`, {
        kind: 'BUSINESS',
      }),
    ];
    expect(blocked.map((res) => res.status)).toEqual([429, 429, 429, 429, 429]);
    expect(errorOf(blocked[0] as Answer).code).toBe('RATE_LIMITED');
    expect(Number(blocked[0]?.headers.get('retry-after'))).toBeGreaterThan(0);
    // Reads are not limited, and another user has their own counter.
    expect((await t.call(user, 'GET', '/api/invoices')).status).toBe(200);
    expect((await t.call(other, 'POST', '/api/invoices', BASE)).status).toBe(
      201,
    );
    // The key holds a hash of the user id, never the id itself.
    const { rows } = await t.db.query(
      'select key from rate_limits where key = $1',
      [`write:${hashKeyPart(user.id)}`],
    );
    expect(rows).toHaveLength(1);
  }, 60_000);
});
