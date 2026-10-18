import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dataOf,
  errorOf,
  startTestApp,
  type DebtorJson,
  type TestApp,
  type TestUser,
} from './test-app.ts';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
}, 30_000);
afterAll(async () => {
  await t.stop();
});

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

async function addInvoice(
  user: TestUser,
  debtorName: string,
  number: string,
  amountCents: number,
) {
  const res = await t.call(user, 'POST', '/api/invoices', {
    debtor: { name: debtorName },
    number,
    issue_date: '2026-08-01',
    due_date: '2026-09-30',
    amount_cents: amountCents,
  });
  expect(res.status, res.text).toBe(201);
  return (res.json as { data: { invoice: { id: string; debtor_id: string } } })
    .data.invoice;
}

const debtorsOf = (res: { json: unknown }) =>
  (res.json as { data: { debtors: DebtorJson[] } }).data.debtors;
const debtorOf = (res: { json: unknown }) =>
  (res.json as { data: { debtor: DebtorJson } }).data.debtor;

// A user with: Alfa (1 invoice, paid in full), Beta (no invoices), Zeta (2 invoices, one part-paid).
async function setup() {
  const user = await t.makeUser();
  const alfa = await addInvoice(user, 'Alfa S.L.', 'A-1', 20_000);
  await t.call(user, 'POST', `/api/invoices/${alfa.id}/payments`, {
    paid_on: '2026-10-01',
    amount_cents: 20_000,
  });
  await t.db.query(
    "insert into debtors (user_id, name, match_key) values ($1, 'Beta S.L.', 'beta')",
    [user.id],
  );
  const zeta = await addInvoice(user, 'Zeta S.L.', 'Z-1', 100_000);
  await addInvoice(user, 'Zeta S.L.', 'Z-2', 50_000);
  await t.call(user, 'POST', `/api/invoices/${zeta.id}/payments`, {
    paid_on: '2026-10-10',
    amount_cents: 30_000,
  });
  return { user, alfaId: alfa.debtor_id, zetaId: zeta.debtor_id };
}

describe('GET /api/debtors', () => {
  it('lists the debtors by name with invoice counts and what is still owed', async () => {
    const { user, alfaId, zetaId } = await setup();

    const res = await t.call(user, 'GET', '/api/debtors');

    expect(res.status).toBe(200);
    expect(debtorsOf(res)).toEqual([
      {
        id: alfaId,
        name: 'Alfa S.L.',
        tax_id: null,
        email: null,
        kind: 'UNKNOWN',
        invoice_count: 1,
        open_invoice_count: 0, // paid in full: the invoice became PAID
        outstanding_cents: 0,
      },
      {
        id: expect.any(String) as string,
        name: 'Beta S.L.',
        tax_id: null,
        email: null,
        kind: 'UNKNOWN',
        invoice_count: 0,
        open_invoice_count: 0,
        outstanding_cents: 0,
      },
      {
        id: zetaId,
        name: 'Zeta S.L.',
        tax_id: null,
        email: null,
        kind: 'UNKNOWN',
        invoice_count: 2,
        open_invoice_count: 2,
        outstanding_cents: 120_000, // 100.000 + 50.000 - 30.000
      },
    ]);
    expect(dataOf(res).page).toEqual({ limit: 50, offset: 0, total: 3 });
  });

  it('pages the list', async () => {
    const { user } = await setup();

    const res = await t.call(user, 'GET', '/api/debtors?limit=1&offset=1');

    expect(debtorsOf(res).map((d) => d.name)).toEqual(['Beta S.L.']);
    expect(dataOf(res).page).toEqual({ limit: 1, offset: 1, total: 3 });
    const past = await t.call(user, 'GET', '/api/debtors?offset=3');
    expect(debtorsOf(past)).toEqual([]);
  });

  it('never lists the debtors of another user', async () => {
    await setup();
    const stranger = await t.makeUser();

    const res = await t.call(stranger, 'GET', '/api/debtors');

    expect(debtorsOf(res)).toEqual([]);
    expect(dataOf(res).page).toEqual({ limit: 50, offset: 0, total: 0 });
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=abc',
    '?limit=1.5',
    '?limit=-1',
    '?limit=1e2',
    '?offset=-1',
    '?offset=abc',
    '?limit=1&limit=2',
  ])('answers 400 VALIDATION_ERROR for %s', async (query) => {
    const user = await t.makeUser();

    const res = await t.call(user, 'GET', `/api/debtors${query}`);

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/debtors/:id', () => {
  it('returns the debtor with the same figures as the list', async () => {
    const { user, zetaId } = await setup();

    const res = await t.call(user, 'GET', `/api/debtors/${zetaId}`);

    expect(res.status).toBe(200);
    expect(debtorOf(res)).toEqual({
      id: zetaId,
      name: 'Zeta S.L.',
      tax_id: null,
      email: null,
      kind: 'UNKNOWN',
      invoice_count: 2,
      open_invoice_count: 2,
      outstanding_cents: 120_000,
    });
  });

  it('answers 404 for a debtor of another user, an unknown id and a malformed id alike', async () => {
    const { zetaId } = await setup();
    const stranger = await t.makeUser();

    const answers = [
      await t.call(stranger, 'GET', `/api/debtors/${zetaId}`),
      await t.call(stranger, 'GET', `/api/debtors/${MISSING_ID}`),
      await t.call(stranger, 'GET', '/api/debtors/not-a-uuid'),
      await t.call(stranger, 'GET', "/api/debtors/1'%20or%20'1'='1"),
    ];

    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(errorOf(res)).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      expect(res.text).not.toContain('Zeta');
    }
  });
});

describe('PATCH /api/debtors/:id', () => {
  it('changes the kind and the e-mail, and null clears the e-mail', async () => {
    const { user, zetaId } = await setup();

    const first = await t.call(user, 'PATCH', `/api/debtors/${zetaId}`, {
      kind: 'BUSINESS',
      email: ' Zeta@Example.COM ',
    });

    expect(first.status).toBe(200);
    expect(debtorOf(first)).toMatchObject({
      id: zetaId,
      kind: 'BUSINESS',
      email: 'zeta@example.com', // trimmed and lower-cased
      invoice_count: 2,
      outstanding_cents: 120_000,
    });

    const cleared = await t.call(user, 'PATCH', `/api/debtors/${zetaId}`, {
      email: null,
    });
    expect(debtorOf(cleared)).toMatchObject({ kind: 'BUSINESS', email: null });
  });

  it('drops the keys it does not know and keeps the name, the tax id and the owner', async () => {
    const { user, zetaId } = await setup();
    const stranger = await t.makeUser();

    const res = await t.call(user, 'PATCH', `/api/debtors/${zetaId}`, {
      kind: 'CONSUMER',
      name: 'Hacked',
      tax_id: 'X1',
      user_id: stranger.id,
      id: MISSING_ID,
      invoice_count: 99,
    });

    expect(res.status).toBe(200);
    expect(debtorOf(res)).toMatchObject({
      id: zetaId,
      name: 'Zeta S.L.',
      tax_id: null,
      kind: 'CONSUMER',
      invoice_count: 2,
    });
    const { rows } = await t.db.query(
      'select user_id from debtors where id = $1',
      [zetaId],
    );
    expect(rows).toEqual([{ user_id: user.id }]);
  });

  it('treats an empty body as no change', async () => {
    const { user, zetaId } = await setup();

    const res = await t.call(user, 'PATCH', `/api/debtors/${zetaId}`, {});

    expect(res.status).toBe(200);
    expect(debtorOf(res)).toMatchObject({ name: 'Zeta S.L.', kind: 'UNKNOWN' });
  });

  it.each([
    ['an unknown kind', { kind: 'FRIEND' }],
    ['a lower-case kind', { kind: 'business' }],
    ['a number as kind', { kind: 1 }],
    ['an e-mail without a domain', { email: 'zeta@' }],
    ['a number as e-mail', { email: 12345 }],
    ['an empty e-mail', { email: '' }],
    ['an e-mail of 300 characters', { email: `${'a'.repeat(290)}@x.com` }],
    ['an array as the body', ['SECRETMARKER']],
  ])('answers 400 for %s without echoing it', async (_name, body) => {
    const { user, zetaId } = await setup();

    const res = await t.call(user, 'PATCH', `/api/debtors/${zetaId}`, body);

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect(res.text).not.toContain('SECRETMARKER');
    expect(res.text).not.toContain('12345');
  });

  it("answers 404 for another user's debtor and leaves it unchanged", async () => {
    const { user, zetaId } = await setup();
    const stranger = await t.makeUser();

    const res = await t.call(stranger, 'PATCH', `/api/debtors/${zetaId}`, {
      kind: 'CONSUMER',
      email: 'evil@example.com',
    });

    expect(res.status).toBe(404);
    const own = await t.call(user, 'GET', `/api/debtors/${zetaId}`);
    expect(debtorOf(own)).toMatchObject({ kind: 'UNKNOWN', email: null });
    expect(
      (await t.call(stranger, 'PATCH', '/api/debtors/not-a-uuid', {})).status,
    ).toBe(404);
  });
});
