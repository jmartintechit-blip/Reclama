// The IDOR matrix. User A owns a debtor, an invoice, a payment and a claim; user B calls EVERY registered
// route that has a path parameter, with every method it supports, using A's ids. Each call must
// answer 404 (what B sees is the same as for an id that does not exist), must show nothing of A
// and must leave A's data exactly as it was.
//
// The list of routes comes from the route registry of the real app, so a new route with a
// `:param` is picked up by itself; and it FAILS until a request for it is added to REQUESTS below,
// so nobody can forget to test it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { getRegisteredRoutes, type RegisteredRoute } from '../http/routes.ts';
import {
  errorOf,
  invoiceOf,
  startTestApp,
  type TestApp,
  type TestUser,
} from './test-app.ts';

interface Ids {
  debtorId: string;
  invoiceId: string;
  paymentId: string;
  claimId: string;
}

interface Request {
  path: string;
  body?: unknown;
}

// One well-formed request per route with a path parameter, built from the ids of A's data. The
// body is valid, so a 404 can only come from the ownership check and not from validation.
const REQUESTS: Record<string, (ids: Ids) => Request> = {
  'GET /api/debtors/:id': ({ debtorId }) => ({
    path: `/api/debtors/${debtorId}`,
  }),
  'PATCH /api/debtors/:id': ({ debtorId }) => ({
    path: `/api/debtors/${debtorId}`,
    body: { kind: 'CONSUMER', email: 'attacker@example.com' },
  }),
  'GET /api/invoices/:id': ({ invoiceId }) => ({
    path: `/api/invoices/${invoiceId}`,
  }),
  'PATCH /api/invoices/:id': ({ invoiceId }) => ({
    path: `/api/invoices/${invoiceId}`,
    body: { number: 'HACKED', amount_cents: 999_999, status: 'PAID' },
  }),
  'DELETE /api/invoices/:id': ({ invoiceId }) => ({
    path: `/api/invoices/${invoiceId}`,
  }),
  'POST /api/invoices/:id/payments': ({ invoiceId }) => ({
    path: `/api/invoices/${invoiceId}/payments`,
    body: { paid_on: '2026-10-11', amount_cents: 500 },
  }),
  'GET /api/invoices/:id/interest': ({ invoiceId }) => ({
    path: `/api/invoices/${invoiceId}/interest`,
  }),
  'GET /api/claims/:id': ({ claimId }) => ({
    path: `/api/claims/${claimId}`,
  }),
  'GET /api/claims/:id/letter.pdf': ({ claimId }) => ({
    path: `/api/claims/${claimId}/letter.pdf`,
  }),
  'POST /api/claims/:id/events': ({ claimId }) => ({
    path: `/api/claims/${claimId}/events`,
    body: { kind: 'NOTE', occurred_on: '2026-10-30', note: 'attacker note' },
  }),
};

const describeRoute = ({ method, path }: RegisteredRoute) =>
  `${method} ${path}`;
const routesWithParams = getRegisteredRoutes(createApp()).filter((route) =>
  route.path.includes(':'),
);

// Things only A's data contains: none of them may ever appear in an answer to B.
const MARKERS = [
  'MARKER-DEBTOR',
  'MARKER-INV-77',
  'marker-tax-id',
  'marker@example.com',
  '7654321',
];

let t: TestApp;
let a: TestUser;
let b: TestUser;
beforeAll(async () => {
  t = await startTestApp();
  a = await t.makeUser();
  b = await t.makeUser();
  // The letter needs the business data of the sender: A, the owner, must be able to get her PDF.
  const profile = await t.call(a, 'PATCH', '/api/me/profile', {
    business_name: 'Estudio Ficticio S.L.',
    tax_id: 'B12345674',
    address: 'Calle de Ejemplo 12, Madrid',
  });
  expect(profile.status, profile.text).toBe(200);
}, 30_000);
afterAll(async () => {
  await t.stop();
});

// A fresh debtor, invoice, payment and claim of A for each request (a DELETE would use one up).
// The claim has an invoice of its own, so the invoice routes above can still edit and delete theirs.
async function makeFixture(): Promise<Ids> {
  const created = await t.call(a, 'POST', '/api/invoices', {
    debtor: {
      name: 'MARKER-DEBTOR S.L.',
      tax_id: 'marker-tax-id',
      email: 'marker@example.com',
    },
    number: `MARKER-INV-77-${String(Math.random()).slice(2, 10)}`,
    issue_date: '2026-08-31',
    due_date: '2026-09-30',
    amount_cents: 7_654_321,
  });
  expect(created.status, created.text).toBe(201);
  const invoice = invoiceOf(created);
  const paid = await t.call(a, 'POST', `/api/invoices/${invoice.id}/payments`, {
    paid_on: '2026-10-10',
    amount_cents: 1_000,
  });
  expect(paid.status, paid.text).toBe(201);
  const { payment } = (paid.json as { data: { payment: { id: string } } }).data;

  const business = await t.call(
    a,
    'PATCH',
    `/api/debtors/${invoice.debtor_id}`,
    {
      kind: 'BUSINESS',
    },
  );
  expect(business.status, business.text).toBe(200);
  const claimed = await t.call(a, 'POST', '/api/invoices', {
    debtor_id: invoice.debtor_id,
    number: `MARKER-INV-77-${String(Math.random()).slice(2, 10)}`,
    issue_date: '2026-08-31',
    due_date: '2026-09-30',
    amount_cents: 7_654_321,
  });
  expect(claimed.status, claimed.text).toBe(201);
  const claim = await t.call(a, 'POST', '/api/claims', {
    debtor_id: invoice.debtor_id,
    invoice_ids: [invoiceOf(claimed).id],
  });
  expect(claim.status, claim.text).toBe(201);
  const { id: claimId } = (claim.json as { data: { claim: { id: string } } })
    .data.claim;
  return {
    debtorId: invoice.debtor_id,
    invoiceId: invoice.id,
    paymentId: payment.id,
    claimId,
  };
}

// Every row of A in the tables that hold her data, in a stable order.
async function snapshotOfA(): Promise<unknown[]> {
  const tables: [string, string][] = [
    ['debtors', 'id'],
    ['invoices', 'id'],
    ['payments', 'id'],
    ['claims', 'id'],
    ['claim_invoices', 'claim_id, invoice_id'],
    ['claim_events', 'id'],
  ];
  const out: unknown[] = [];
  for (const [table, order] of tables) {
    const { rows } = await t.db.query(
      `select * from ${table} where user_id = $1 order by ${order}`,
      [a.id],
    );
    out.push(rows);
  }
  return out;
}

describe('the IDOR matrix of the real app', () => {
  it('has a request for every route with a path parameter, and none for a route that does not exist', () => {
    const registered = routesWithParams.map(describeRoute).sort();
    const mapped = Object.keys(REQUESTS).sort();

    expect(registered.length).toBeGreaterThan(0);
    expect(
      registered.filter((key) => !(key in REQUESTS)),
      'routes with a :param and NO request in REQUESTS: add one',
    ).toEqual([]);
    expect(mapped, 'REQUESTS has entries for routes that do not exist').toEqual(
      registered,
    );
  });

  it.each(
    routesWithParams.map((route) => ({ key: describeRoute(route), route })),
  )(
    '$key: B gets 404 with nothing of A, and A keeps her data',
    async ({ key, route }) => {
      const build = REQUESTS[key];
      if (!build) throw new Error(`No IDOR request for ${key}`);
      const ids = await makeFixture();
      const before = await snapshotOfA();
      const { path, body } = build(ids);

      const attack = await t.call(b, route.method, path, body);

      expect(attack.status, attack.text).toBe(404);
      expect(errorOf(attack)).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Not found',
      });
      for (const marker of [
        ...MARKERS,
        ids.invoiceId,
        ids.debtorId,
        ids.paymentId,
        ids.claimId,
      ]) {
        expect(attack.text).not.toContain(marker);
      }
      expect(await snapshotOfA()).toEqual(before);

      // The request itself is well formed: A, the owner, is served by the same route.
      const own = await t.call(a, route.method, path, body);
      expect(own.status, own.text).toBeGreaterThanOrEqual(200);
      expect(own.status, own.text).toBeLessThan(300);
    },
  );

  it.each(
    routesWithParams.map((route) => ({ key: describeRoute(route), route })),
  )(
    '$key: a malformed id answers 404 as well, for A and for B',
    async ({ key, route }) => {
      const build = REQUESTS[key];
      if (!build) throw new Error(`No IDOR request for ${key}`);
      const junk = 'not-a-uuid';
      const { path, body } = build({
        debtorId: junk,
        invoiceId: junk,
        paymentId: junk,
        claimId: junk,
      });

      for (const user of [a, b]) {
        const res = await t.call(user, route.method, path, body);
        expect(res.status, res.text).toBe(404);
        expect(errorOf(res).code).toBe('NOT_FOUND');
      }
    },
  );
});

describe('the routes without a path parameter', () => {
  it("does not let B create an invoice for A's debtor, and says the same as for a missing debtor", async () => {
    const ids = await makeFixture();
    const before = await snapshotOfA();
    const body = {
      debtor_id: ids.debtorId,
      number: 'B-OWN',
      issue_date: '2026-08-31',
      amount_cents: 1_000,
    };

    const res = await t.call(b, 'POST', '/api/invoices', body);
    const missing = await t.call(b, 'POST', '/api/invoices', {
      ...body,
      debtor_id: '00000000-0000-4000-8000-000000000000',
    });

    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('DEBTOR_NOT_FOUND');
    expect(res.json).toEqual({
      error: {
        ...errorOf(missing),
        request_id: errorOf(res).request_id,
      },
    });
    expect(await snapshotOfA()).toEqual(before);
    const { rows } = await t.db.query(
      'select count(*)::int as n from invoices where user_id = $1',
      [b.id],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("gives B nothing of A in the lists, with or without A's debtor id as a filter", async () => {
    const ids = await makeFixture();

    const answers = [
      await t.call(b, 'GET', '/api/invoices'),
      await t.call(b, 'GET', `/api/invoices?debtor_id=${ids.debtorId}`),
      await t.call(b, 'GET', '/api/debtors'),
      await t.call(b, 'GET', '/api/claims'),
    ];

    for (const res of answers) {
      expect(res.status).toBe(200);
      for (const marker of [
        ...MARKERS,
        ids.invoiceId,
        ids.debtorId,
        ids.claimId,
      ]) {
        expect(res.text).not.toContain(marker);
      }
    }
    expect(answers[1]?.json).toMatchObject({
      data: { invoices: [], totals: { count: 0, outstanding_cents: 0 } },
    });
    expect(answers[3]?.json).toEqual({
      data: { claims: [], page: { limit: 50, offset: 0, total: 0 } },
    });
  });

  it("does not let B claim A's debtor or A's invoices, and says the same as for ids that do not exist", async () => {
    const ids = await makeFixture();
    const before = await snapshotOfA();
    const mine = await t.call(b, 'POST', '/api/invoices', {
      debtor: { name: 'B-OWN S.L.' },
      number: 'B-OWN',
      issue_date: '2026-08-31',
      due_date: '2026-09-30',
      amount_cents: 1_000,
    });
    const own = invoiceOf(mine);
    await t.call(b, 'PATCH', `/api/debtors/${own.debtor_id}`, {
      kind: 'BUSINESS',
    });
    const missingId = '00000000-0000-4000-8000-000000000000';

    const foreignDebtor = await t.call(b, 'POST', '/api/claims', {
      debtor_id: ids.debtorId,
    });
    const missingDebtor = await t.call(b, 'POST', '/api/claims', {
      debtor_id: missingId,
    });
    const foreignInvoice = await t.call(b, 'POST', '/api/claims', {
      debtor_id: own.debtor_id,
      invoice_ids: [own.id, ids.invoiceId],
    });
    const missingInvoice = await t.call(b, 'POST', '/api/claims', {
      debtor_id: own.debtor_id,
      invoice_ids: [own.id, missingId],
    });

    for (const [attack, missing, code] of [
      [foreignDebtor, missingDebtor, 'DEBTOR_NOT_FOUND'],
      [foreignInvoice, missingInvoice, 'INVOICE_NOT_FOUND'],
    ] as const) {
      expect(attack.status, attack.text).toBe(404);
      expect(errorOf(attack).code).toBe(code);
      expect(attack.json).toEqual({
        error: {
          ...errorOf(missing),
          request_id: errorOf(attack).request_id,
        },
      });
      expect(attack.text).not.toContain(ids.invoiceId);
      expect(attack.text).not.toContain(ids.debtorId);
    }
    expect(await snapshotOfA()).toEqual(before);
    const { rows } = await t.db.query(
      'select count(*)::int as n from claims where user_id = $1',
      [b.id],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('creates B its own debtor, even with the same name and tax id as one of A', async () => {
    const ids = await makeFixture();
    const before = await snapshotOfA();

    const res = await t.call(b, 'POST', '/api/invoices', {
      debtor: { name: 'MARKER-DEBTOR S.L.', tax_id: 'marker-tax-id' },
      number: 'B-1',
      issue_date: '2026-08-31',
      amount_cents: 1_000,
    });

    expect(res.status).toBe(201);
    expect(invoiceOf(res).debtor_id).not.toBe(ids.debtorId);
    expect(await snapshotOfA()).toEqual(before);
  });
});
