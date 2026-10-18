import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_CLAIMS_PER_USER,
  MAX_EVENTS_PER_CLAIM,
  MAX_INVOICES_PER_CLAIM,
} from '../db/claims.ts';
import { hashKeyPart } from '../db/rate-limits.ts';
import {
  errorOf,
  invoiceOf,
  startTestApp,
  type Answer,
  type InvoiceJson,
  type TestApp,
  type TestUser,
} from './test-app.ts';

const NOW = '2026-10-30T10:00:00Z'; // 2026-10-30 in Madrid
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ now: NOW });
}, 30_000);
afterAll(async () => {
  await t.stop();
});
afterEach(() => {
  t.setNow(NOW);
});

interface SegmentJson {
  start: string;
  end: string;
  days: number;
  year_days: number;
  rate_bp: number;
  balance_cents: number;
  interest_cents: number;
}
interface NextActionJson {
  action: string;
  reason: string;
  earliest_on: string | null;
  wait_days: number;
  warnings: { code: string; message: string }[];
  guide: {
    title: string;
    why: string;
    steps: string[];
    prepare: string[];
    outcomes: string[];
    notes: string[];
    template: { text: string; placeholders: string[] } | null;
  };
}
interface ClaimJson {
  id: string;
  debtor_id: string;
  debtor_name: string;
  as_of: string;
  compensation_mode: string;
  principal_cents: number;
  interest_cents: number;
  compensation_cents: number;
  total_cents: number;
  calc_version: string;
  lines: {
    invoice_id: string;
    number: string;
    principal_cents: number;
    interest_cents: number;
    segments: SegmentJson[];
  }[];
  events: {
    id: string;
    kind: string;
    occurred_on: string;
    note: string | null;
  }[];
  next_action?: NextActionJson; // only on GET /api/claims/:id
}
interface ClaimListItem extends Omit<
  ClaimJson,
  'lines' | 'events' | 'next_action'
> {
  invoice_count: number;
  last_event: { kind: string; occurred_on: string } | null;
  next_action: { action: string; earliest_on: string | null };
}
const claimOf = (res: Answer) =>
  (res.json as { data: { claim: ClaimJson } }).data.claim;
const eventOf = (res: Answer) =>
  (res.json as { data: { event: ClaimJson['events'][number] } }).data.event;

// 1.000,00 EUR issued 31 Aug 2026 and due 30 Sep 2026: on 30 Oct it is 30 days late, which is
// 855 cents of interest at 10.40 %; 500 EUR with the same dates gives 427.
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

async function setKind(user: TestUser, debtorId: string, kind: string) {
  const res = await t.call(user, 'PATCH', `/api/debtors/${debtorId}`, { kind });
  expect(res.status, res.text).toBe(200);
}

// A BUSINESS debtor with two invoices, 1,000 EUR and 500 EUR.
async function setup(user: TestUser, name = 'Acme S.L.') {
  const a = await create(user, { debtor: { name }, number: 'F-1' });
  const b = await create(user, {
    debtor: undefined,
    debtor_id: a.debtor_id,
    number: 'F-2',
    amount_cents: 50_000,
  });
  await setKind(user, a.debtor_id, 'BUSINESS');
  return { debtorId: a.debtor_id, a, b };
}

// Another invoice of the same debtor.
const more = (user: TestUser, debtorId: string, patch: object) =>
  create(user, { debtor: undefined, debtor_id: debtorId, ...patch });

const claim = (user: TestUser, body: unknown) =>
  t.call(user, 'POST', '/api/claims', body);

async function claimOK(user: TestUser, body: unknown): Promise<ClaimJson> {
  const res = await claim(user, body);
  expect(res.status, res.text).toBe(201);
  return claimOf(res);
}

async function count(table: string, user: TestUser): Promise<number> {
  const { rows } = await t.db.query(
    `select count(*)::int as n from ${table} where user_id = $1`,
    [user.id],
  );
  return (rows[0] as { n: number }).n;
}

describe('POST /api/claims', () => {
  it('claims every overdue open invoice of the debtor, calculated on the server, with the compensation of the profile', async () => {
    const user = await t.makeUser();
    const { debtorId, a, b } = await setup(user);

    const res = await claim(user, { debtor_id: debtorId });

    expect(res.status, res.text).toBe(201);
    const created = claimOf(res);
    expect(created).toEqual({
      id: expect.any(String) as string,
      debtor_id: debtorId,
      debtor_name: 'Acme S.L.',
      as_of: '2026-10-30',
      compensation_mode: 'PER_CLAIM', // the default of a new profile
      principal_cents: 150_000,
      interest_cents: 1282,
      compensation_cents: 4000,
      total_cents: 155_282,
      calc_version: 'interest-v1',
      lines: [
        {
          invoice_id: a.id,
          number: 'F-1',
          principal_cents: 100_000,
          interest_cents: 855,
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
        },
        {
          invoice_id: b.id,
          number: 'F-2',
          principal_cents: 50_000,
          interest_cents: 427,
          segments: [
            {
              start: '2026-10-01',
              end: '2026-10-30',
              days: 30,
              year_days: 365,
              rate_bp: 1040,
              balance_cents: 50_000,
              interest_cents: 427,
            },
          ],
        },
      ],
      events: [],
    });
    expect(res.json).not.toHaveProperty('data.claim.next_action');
  });

  it.each([
    ['PER_INVOICE', 8000, 159_282],
    ['PER_CLAIM', 4000, 155_282],
    ['NONE', 0, 151_282],
  ])(
    'compensation_mode %s gives compensation %i and total %i',
    async (mode, compensation, total) => {
      const user = await t.makeUser();
      const { debtorId } = await setup(user);

      const created = await claimOK(user, {
        debtor_id: debtorId,
        compensation_mode: mode,
      });

      expect(created).toMatchObject({
        compensation_mode: mode,
        interest_cents: 1282,
        compensation_cents: compensation,
        total_cents: total,
      });
    },
  );

  it('uses the compensation mode the profile has when none is sent', async () => {
    const user = await t.makeUser();
    const { debtorId } = await setup(user);
    const patched = await t.call(user, 'PATCH', '/api/me/profile', {
      default_compensation: 'PER_INVOICE',
    });
    expect(patched.status).toBe(200);

    const created = await claimOK(user, { debtor_id: debtorId });

    expect(created).toMatchObject({
      compensation_mode: 'PER_INVOICE',
      total_cents: 159_282,
    });
  });

  it('ignores any number or owner the client sends', async () => {
    const user = await t.makeUser();
    const other = await t.makeUser();
    const { debtorId } = await setup(user);

    const created = await claimOK(user, {
      debtor_id: debtorId,
      user_id: other.id,
      principal_cents: 1,
      interest_cents: 1,
      total_cents: 1,
      calc_version: 'hacked',
    });

    expect(created).toMatchObject({
      total_cents: 155_282,
      calc_version: 'interest-v1',
    });
    expect(await count('claims', user)).toBe(1);
    expect(await count('claims', other)).toBe(0);
  });

  it('leaves out what is not claimable: not due yet, paid, disputed, in another claim and other debtors', async () => {
    const user = await t.makeUser();
    const { debtorId, a, b } = await setup(user);
    await more(user, debtorId, {
      number: 'FUTURE',
      issue_date: '2026-10-15',
      due_date: '2026-11-14',
    });
    const paid = await more(user, debtorId, { number: 'PAID' });
    expect(
      (
        await t.call(user, 'POST', `/api/invoices/${paid.id}/payments`, {
          paid_on: '2026-10-10',
          amount_cents: 100_000,
        })
      ).status,
    ).toBe(201);
    const disputed = await more(user, debtorId, { number: 'DISPUTED' });
    expect(
      (
        await t.call(user, 'PATCH', `/api/invoices/${disputed.id}`, {
          status: 'DISPUTED',
        })
      ).status,
    ).toBe(200);
    const claimed = await more(user, debtorId, { number: 'CLAIMED' });
    await claimOK(user, { debtor_id: debtorId, invoice_ids: [claimed.id] });
    await create(user, { debtor: { name: 'Other S.L.' }, number: 'OTHER' });

    const created = await claimOK(user, {
      debtor_id: debtorId,
      compensation_mode: 'PER_INVOICE',
    });

    expect(created.lines.map((l) => l.invoice_id)).toEqual([a.id, b.id]);
    expect(created.compensation_cents).toBe(8000); // two invoices, not seven
  });

  it('claims only the given invoices, and a repeated id counts once', async () => {
    const user = await t.makeUser();
    const { debtorId, a, b } = await setup(user);

    const created = await claimOK(user, {
      debtor_id: debtorId,
      invoice_ids: [b.id, b.id],
      compensation_mode: 'NONE',
    });

    expect(created.lines.map((l) => l.invoice_id)).toEqual([b.id]);
    expect(created).toMatchObject({
      principal_cents: 50_000,
      total_cents: 50_427,
    });
    const next = await claimOK(user, {
      debtor_id: debtorId,
      invoice_ids: [a.id],
    });
    expect(next.lines).toHaveLength(1); // the other invoice was free all along
  });

  it('claims what is still owed after a payment, with the interest on the balance of each period', async () => {
    const user = await t.makeUser();
    const { debtorId, a } = await setup(user);
    await t.call(user, 'POST', `/api/invoices/${a.id}/payments`, {
      paid_on: '2026-10-10',
      amount_cents: 40_000,
    });

    const created = await claimOK(user, {
      debtor_id: debtorId,
      invoice_ids: [a.id],
      compensation_mode: 'NONE',
    });

    // 1-10 Oct on 1,000.00 EUR (the payment day still accrues on the old balance) = 285,
    // 11-30 Oct on 600.00 EUR = 342.
    expect(created.lines[0]).toMatchObject({
      principal_cents: 60_000,
      interest_cents: 627,
    });
    expect(created.lines[0]?.segments.map((s) => s.balance_cents)).toEqual([
      100_000, 60_000,
    ]);
  });

  describe('as_of', () => {
    it('can be a past day: the interest is calculated up to it', async () => {
      const user = await t.makeUser();
      const { debtorId } = await setup(user);

      const created = await claimOK(user, {
        debtor_id: debtorId,
        as_of: '2026-10-15',
        compensation_mode: 'NONE',
      });

      // 15 days late: 427 on 1,000.00 EUR and 214 on 500.00 EUR.
      expect(created).toMatchObject({
        as_of: '2026-10-15',
        interest_cents: 641,
      });
    });

    it('cannot be in the future', async () => {
      const user = await t.makeUser();
      const { debtorId } = await setup(user);

      const res = await claim(user, {
        debtor_id: debtorId,
        as_of: '2026-10-31',
      });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('AS_OF_IN_FUTURE');
      expect(await count('claims', user)).toBe(0);
    });

    it('is checked as a real date', async () => {
      const user = await t.makeUser();
      const { debtorId } = await setup(user);

      const res = await claim(user, {
        debtor_id: debtorId,
        as_of: '2026-02-30',
      });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    });

    it.each(['2026-09-15', '2026-09-30'])(
      'on %s (before the due date, or on it) nothing is overdue: NOT_OVERDUE',
      async (asOf) => {
        const user = await t.makeUser();
        const { debtorId } = await setup(user);

        const res = await claim(user, { debtor_id: debtorId, as_of: asOf });

        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('NOT_OVERDUE');
        expect(await count('claims', user)).toBe(0);
      },
    );

    it('leaves out an invoice that is not yet overdue on that day, even when it was asked for', async () => {
      const user = await t.makeUser();
      const { debtorId, a } = await setup(user);
      const later = await more(user, debtorId, {
        number: 'LATER',
        due_date: '2026-10-20',
      });

      const created = await claimOK(user, {
        debtor_id: debtorId,
        invoice_ids: [a.id, later.id],
        as_of: '2026-10-15',
      });

      expect(created.lines.map((l) => l.invoice_id)).toEqual([a.id]);
    });
  });

  describe('the debtor', () => {
    it.each(['PUBLIC_ADMIN', 'CONSUMER'])(
      'a %s cannot be claimed with Ley 3/2004: DEBTOR_NOT_B2B',
      async (kind) => {
        const user = await t.makeUser();
        const { debtorId } = await setup(user);
        await setKind(user, debtorId, kind);

        const res = await claim(user, { debtor_id: debtorId });

        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('DEBTOR_NOT_B2B');
        expect(await count('claims', user)).toBe(0);
      },
    );

    it('an UNKNOWN kind asks for it to be set first', async () => {
      const user = await t.makeUser();
      const { debtorId } = await setup(user);
      await setKind(user, debtorId, 'UNKNOWN');

      const res = await claim(user, { debtor_id: debtorId });

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'DEBTOR_KIND_UNKNOWN',
        message:
          'Set the debtor kind to BUSINESS first with PATCH /api/debtors/:id',
      });
      expect(await count('claims', user)).toBe(0);
      // Control: once it is BUSINESS, the same request works.
      await setKind(user, debtorId, 'BUSINESS');
      expect((await claim(user, { debtor_id: debtorId })).status).toBe(201);
    });

    it('a missing debtor and another user’s debtor look the same: 404 DEBTOR_NOT_FOUND', async () => {
      const user = await t.makeUser();
      const other = await t.makeUser();
      const theirs = await setup(other);

      const foreign = await claim(user, { debtor_id: theirs.debtorId });
      const missing = await claim(user, { debtor_id: MISSING_ID });

      expect(foreign.status).toBe(404);
      expect(errorOf(foreign).code).toBe('DEBTOR_NOT_FOUND');
      expect(foreign.json).toEqual({
        error: { ...errorOf(missing), request_id: errorOf(foreign).request_id },
      });
      expect(await count('claims', other)).toBe(0);
    });
  });

  describe('nothing to claim', () => {
    it('answers NOT_OVERDUE when no invoice is overdue, and also when the debtor has none', async () => {
      const user = await t.makeUser();
      const first = await create(user, {
        number: 'FUTURE',
        issue_date: '2026-10-15',
        due_date: '2026-11-14',
      });
      await setKind(user, first.debtor_id, 'BUSINESS');
      const empty = await create(user, { debtor: { name: 'Empty S.L.' } });
      await setKind(user, empty.debtor_id, 'BUSINESS');
      await t.call(user, 'DELETE', `/api/invoices/${empty.id}`);

      for (const debtorId of [first.debtor_id, empty.debtor_id]) {
        const res = await claim(user, { debtor_id: debtorId });
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('NOT_OVERDUE');
      }
      expect(await count('claims', user)).toBe(0);
    });

    it('a second claim for the same debtor finds nothing left: no second claim, no duplicated line', async () => {
      const user = await t.makeUser();
      const { debtorId } = await setup(user);
      await claimOK(user, { debtor_id: debtorId });

      const again = await claim(user, { debtor_id: debtorId });

      expect(again.status).toBe(422);
      expect(errorOf(again).code).toBe('NOT_OVERDUE');
      expect(await count('claims', user)).toBe(1);
      expect(await count('claim_invoices', user)).toBe(2);
    });
  });

  it('answers RATE_WINDOW with the missing semesters and leaves nothing behind', async () => {
    const user = await t.makeUser();
    const { debtorId } = await setup(user);
    await more(user, debtorId, {
      number: 'OLD',
      issue_date: '2017-11-01',
      due_date: '2017-12-01',
    });

    const res = await claim(user, { debtor_id: debtorId });

    expect(res.status).toBe(422);
    expect(errorOf(res)).toMatchObject({
      code: 'RATE_WINDOW',
      details: { missing_semesters: ['2017-H2'] },
    });
    expect(await count('claims', user)).toBe(0);
    expect(await count('claim_invoices', user)).toBe(0);
  });

  describe('the invoices that are asked for', () => {
    it('a missing invoice and another user’s invoice look the same: 404 INVOICE_NOT_FOUND, nothing created', async () => {
      const user = await t.makeUser();
      const other = await t.makeUser();
      const { debtorId, a } = await setup(user);
      const theirs = await setup(other);

      const foreign = await claim(user, {
        debtor_id: debtorId,
        invoice_ids: [a.id, theirs.a.id],
      });
      const missing = await claim(user, {
        debtor_id: debtorId,
        invoice_ids: [a.id, MISSING_ID],
      });

      expect(foreign.status).toBe(404);
      expect(errorOf(foreign).code).toBe('INVOICE_NOT_FOUND');
      expect(foreign.json).toEqual({
        error: { ...errorOf(missing), request_id: errorOf(foreign).request_id },
      });
      expect(await count('claims', user)).toBe(0);
      expect(await count('claims', other)).toBe(0);
    });

    it('an invoice of another debtor of the same user: 422 INVOICE_OTHER_DEBTOR', async () => {
      const user = await t.makeUser();
      const { debtorId, a } = await setup(user);
      const elsewhere = await create(user, { debtor: { name: 'Other S.L.' } });

      const res = await claim(user, {
        debtor_id: debtorId,
        invoice_ids: [a.id, elsewhere.id],
      });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('INVOICE_OTHER_DEBTOR');
      expect(await count('claims', user)).toBe(0);
    });

    it('a fully paid or disputed invoice: 422 INVOICE_NOT_OPEN', async () => {
      const user = await t.makeUser();
      const { debtorId, a, b } = await setup(user);
      await t.call(user, 'POST', `/api/invoices/${a.id}/payments`, {
        paid_on: '2026-10-10',
        amount_cents: 100_000,
      });
      await t.call(user, 'PATCH', `/api/invoices/${b.id}`, {
        status: 'DISPUTED',
      });

      for (const id of [a.id, b.id]) {
        const res = await claim(user, {
          debtor_id: debtorId,
          invoice_ids: [id],
        });
        expect(res.status, res.text).toBe(422);
        expect(errorOf(res).code).toBe('INVOICE_NOT_OPEN');
      }
      expect(await count('claims', user)).toBe(0);
    });

    it('an invoice that is already in a claim: 409 INVOICE_IN_CLAIM, and the free invoice stays free', async () => {
      const user = await t.makeUser();
      const { debtorId, a, b } = await setup(user);
      await claimOK(user, { debtor_id: debtorId, invoice_ids: [a.id] });

      const res = await claim(user, {
        debtor_id: debtorId,
        invoice_ids: [b.id, a.id],
      });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('INVOICE_IN_CLAIM');
      expect(await count('claims', user)).toBe(1);
      expect(await count('claim_invoices', user)).toBe(1);
    });
  });

  it('is validated: ids, list and mode', async () => {
    const user = await t.makeUser();
    const { debtorId, a } = await setup(user);
    const bad: unknown[] = [
      {},
      { debtor_id: 'not-a-uuid' },
      { debtor_id: debtorId, invoice_ids: [] },
      { debtor_id: debtorId, invoice_ids: ['not-a-uuid'] },
      { debtor_id: debtorId, invoice_ids: a.id },
      { debtor_id: debtorId, compensation_mode: 'ALL' },
      { debtor_id: debtorId, as_of: '30/10/2026' },
    ];

    for (const body of bad) {
      const res = await claim(user, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    expect(await count('claims', user)).toBe(0);
  });

  describe('the size of a claim', () => {
    // A BUSINESS debtor with `n` overdue invoices, written straight to the database (the write
    // rate limit would stop the API long before 100). Returns the ids in number order.
    async function debtorWithInvoices(n: number) {
      const user = await t.makeUser();
      const first = await create(user, { number: 'F-0' });
      await setKind(user, first.debtor_id, 'BUSINESS');
      await t.db.query(
        `insert into invoices (user_id, debtor_id, number, issue_date, due_date, amount_cents)
         select $1::uuid, $2::uuid, 'G-' || lpad(g::text, 4, '0'), '2026-08-31', '2026-09-30', 100000
           from generate_series(1, $3::int) g`,
        [user.id, first.debtor_id, n - 1],
      );
      const { rows } = await t.db.query(
        'select id from invoices where user_id = $1 order by number',
        [user.id],
      );
      return {
        user,
        debtorId: first.debtor_id,
        ids: (rows as { id: string }[]).map((row) => row.id),
      };
    }

    it('claims exactly the limit of invoices, by default and by id', async () => {
      const byDefault = await debtorWithInvoices(MAX_INVOICES_PER_CLAIM);
      const byId = await debtorWithInvoices(MAX_INVOICES_PER_CLAIM);

      const a = await claimOK(byDefault.user, {
        debtor_id: byDefault.debtorId,
      });
      const b = await claimOK(byId.user, {
        debtor_id: byId.debtorId,
        invoice_ids: byId.ids,
      });

      expect(a.lines).toHaveLength(MAX_INVOICES_PER_CLAIM);
      expect(b.lines).toHaveLength(MAX_INVOICES_PER_CLAIM);
      expect(a.principal_cents).toBe(MAX_INVOICES_PER_CLAIM * 100_000);
    });

    it('refuses one invoice more than the limit with CLAIM_TOO_LARGE, by default and by id, creating nothing', async () => {
      const { user, debtorId, ids } = await debtorWithInvoices(
        MAX_INVOICES_PER_CLAIM + 1,
      );

      const byDefault = await claim(user, { debtor_id: debtorId });
      const byId = await claim(user, { debtor_id: debtorId, invoice_ids: ids });

      for (const res of [byDefault, byId]) {
        expect(res.status, res.text).toBe(422);
        expect(errorOf(res)).toMatchObject({
          code: 'CLAIM_TOO_LARGE',
          details: { limit: MAX_INVOICES_PER_CLAIM },
        });
      }
      expect(await count('claims', user)).toBe(0);
      expect(await count('claim_invoices', user)).toBe(0);
    });

    it('refuses a list over the limit before looking any invoice up', async () => {
      const user = await t.makeUser();
      const { debtorId } = await setup(user);
      // 101 ids that do not exist: with the size checked first the answer is not a 404.
      const ids = Array.from({ length: MAX_INVOICES_PER_CLAIM + 1 }, () =>
        randomUUID(),
      );

      const res = await claim(user, { debtor_id: debtorId, invoice_ids: ids });

      expect(res.status, res.text).toBe(422);
      expect(errorOf(res).code).toBe('CLAIM_TOO_LARGE');
    });

    it('lets the user claim the rest in a second claim', async () => {
      const { user, debtorId, ids } = await debtorWithInvoices(
        MAX_INVOICES_PER_CLAIM + 5,
      );

      const first = await claimOK(user, {
        debtor_id: debtorId,
        invoice_ids: ids.slice(0, MAX_INVOICES_PER_CLAIM),
      });
      const second = await claimOK(user, { debtor_id: debtorId }); // the 5 left

      expect(first.lines).toHaveLength(MAX_INVOICES_PER_CLAIM);
      expect(second.lines).toHaveLength(5);
    });

    it('does not count what cannot be claimed against the limit of the default selection', async () => {
      const { user, debtorId, ids } = await debtorWithInvoices(
        MAX_INVOICES_PER_CLAIM + 3,
      );
      // 3 of them are paid: 100 are left, which is exactly the limit.
      await t.db.query(
        `update invoices set status = 'PAID' where user_id = $1 and id = any($2::uuid[])`,
        [user.id, ids.slice(0, 3)],
      );

      const res = await claim(user, { debtor_id: debtorId });

      expect(res.status, res.text).toBe(201);
      expect(claimOf(res).lines).toHaveLength(MAX_INVOICES_PER_CLAIM);
    });
  });

  it('refuses the claim after the limit with CLAIM_LIMIT_REACHED, creating nothing', async () => {
    const user = await t.makeUser();
    const { debtorId, a, b } = await setup(user);
    // Everything but one place is taken (written straight to the database).
    await t.db.query(
      `insert into claims (user_id, debtor_id, as_of, compensation_mode, principal_cents,
                           interest_cents, compensation_cents, total_cents, calc_version)
       select $1::uuid, $2::uuid, '2026-10-01', 'NONE', 100, 0, 0, 100, 'test'
         from generate_series(1, $3::int)`,
      [user.id, debtorId, MAX_CLAIMS_PER_USER - 1],
    );

    const last = await claim(user, {
      debtor_id: debtorId,
      invoice_ids: [a.id],
    });
    const over = await claim(user, {
      debtor_id: debtorId,
      invoice_ids: [b.id],
    });

    expect(last.status, last.text).toBe(201);
    expect(over.status).toBe(422);
    expect(errorOf(over)).toMatchObject({
      code: 'CLAIM_LIMIT_REACHED',
      details: { limit: MAX_CLAIMS_PER_USER },
    });
    expect(await count('claims', user)).toBe(MAX_CLAIMS_PER_USER);
    // The limit is per user.
    const other = await t.makeUser();
    const theirs = await setup(other);
    expect((await claim(other, { debtor_id: theirs.debtorId })).status).toBe(
      201,
    );
  }, 60_000);
});

describe('the invoices of a claim are locked', () => {
  it('PATCH and DELETE of an invoice in a claim answer 409 INVOICE_IN_CLAIM and change nothing', async () => {
    const user = await t.makeUser();
    const { debtorId, a, b } = await setup(user);
    await claimOK(user, { debtor_id: debtorId, invoice_ids: [a.id] });

    const patch = await t.call(user, 'PATCH', `/api/invoices/${a.id}`, {
      amount_cents: 1,
    });
    const del = await t.call(user, 'DELETE', `/api/invoices/${a.id}`);

    for (const res of [patch, del]) {
      expect(res.status, res.text).toBe(409);
      expect(errorOf(res).code).toBe('INVOICE_IN_CLAIM');
    }
    const kept = invoiceOf(await t.call(user, 'GET', `/api/invoices/${a.id}`));
    expect(kept).toMatchObject({ amount_cents: 100_000, number: 'F-1' });
    // Control: the invoice that is not in a claim can still be edited.
    expect(
      (
        await t.call(user, 'PATCH', `/api/invoices/${b.id}`, {
          amount_cents: 60_000,
        })
      ).status,
    ).toBe(200);
  });
});

describe('DELETE /api/claims/:id', () => {
  it('cancels the claim with its steps, even after a step was sent, and frees its invoices for a new claim', async () => {
    const user = await t.makeUser();
    const { debtorId, a } = await setup(user);
    const first = await claimOK(user, {
      debtor_id: debtorId,
      invoice_ids: [a.id],
    });
    const event = await t.call(user, 'POST', `/api/claims/${first.id}/events`, {
      kind: 'DEMAND_SENT',
      occurred_on: '2026-10-30',
    });
    expect(event.status, event.text).toBe(201);

    const del = await t.call(user, 'DELETE', `/api/claims/${first.id}`);

    expect(del.status, del.text).toBe(204);
    expect((await t.call(user, 'GET', `/api/claims/${first.id}`)).status).toBe(
      404,
    );
    expect(await count('claims', user)).toBe(0);
    expect(await count('claim_invoices', user)).toBe(0);
    expect(await count('claim_events', user)).toBe(0);
    // The invoice can be edited and claimed again.
    const patched = await t.call(user, 'PATCH', `/api/invoices/${a.id}`, {
      amount_cents: 90_000,
    });
    expect(patched.status, patched.text).toBe(200);
    await claimOK(user, { debtor_id: debtorId, invoice_ids: [a.id] });
  });

  it('answers 404 for a missing, malformed or foreign id, and a foreign claim is untouched', async () => {
    const owner = await t.makeUser();
    const other = await t.makeUser();
    const { debtorId, a } = await setup(owner);
    const mine = await claimOK(owner, {
      debtor_id: debtorId,
      invoice_ids: [a.id],
    });

    for (const id of [
      '00000000-0000-4000-8000-000000000000',
      'not-an-id',
      mine.id,
    ]) {
      const res = await t.call(other, 'DELETE', `/api/claims/${id}`);
      expect(res.status, id).toBe(404);
    }
    expect((await t.call(owner, 'GET', `/api/claims/${mine.id}`)).status).toBe(
      200,
    );
  });
});

describe('GET /api/claims', () => {
  it('lists the claims newest date first with debtor, totals, invoice count and last event, paginated', async () => {
    const user = await t.makeUser();
    const { debtorId, a, b } = await setup(user, 'Acme S.L.');
    const c = await more(user, debtorId, { number: 'F-3' });
    const first = await claimOK(user, {
      debtor_id: debtorId,
      invoice_ids: [a.id],
      as_of: '2026-10-10',
    });
    const second = await claimOK(user, {
      debtor_id: debtorId,
      invoice_ids: [b.id, c.id],
      as_of: '2026-10-30',
    });
    await t.call(user, 'POST', `/api/claims/${second.id}/events`, {
      kind: 'REMINDER_SENT',
      occurred_on: '2026-10-30',
    });

    const res = await t.call(user, 'GET', '/api/claims');
    const body = (
      res.json as {
        data: {
          claims: ClaimListItem[];
          page: { limit: number; offset: number; total: number };
        };
      }
    ).data;

    expect(res.status).toBe(200);
    expect(body.page).toEqual({ limit: 50, offset: 0, total: 2 });
    expect(body.claims.map((x) => x.id)).toEqual([second.id, first.id]);
    expect(body.claims[0]).toMatchObject({
      debtor_id: debtorId,
      debtor_name: 'Acme S.L.',
      as_of: '2026-10-30',
      total_cents: second.total_cents,
      invoice_count: 2,
      last_event: { kind: 'REMINDER_SENT', occurred_on: '2026-10-30' },
    });
    expect(body.claims[1]).toMatchObject({
      invoice_count: 1,
      last_event: null,
    });
    expect(body.claims[0]).not.toHaveProperty('lines');
    // Only the action and the day it is suggested from: no reason and no guide in the list.
    expect(body.claims[0]?.next_action).toEqual({
      action: 'SEND_DEMAND',
      earliest_on: '2026-11-06',
    });
    expect(body.claims[1]?.next_action).toEqual({
      action: 'SEND_REMINDER',
      earliest_on: '2026-10-30',
    });

    const paged = await t.call(user, 'GET', '/api/claims?limit=1&offset=1');
    const pagedBody = (
      paged.json as {
        data: { claims: ClaimListItem[]; page: { total: number } };
      }
    ).data;
    expect(pagedBody.claims.map((x) => x.id)).toEqual([first.id]);
    expect(pagedBody.page.total).toBe(2);
  });

  it('is empty for a user without claims and refuses a bad page', async () => {
    const user = await t.makeUser();

    const res = await t.call(user, 'GET', '/api/claims');
    expect(res.json).toEqual({
      data: { claims: [], page: { limit: 50, offset: 0, total: 0 } },
    });
    for (const query of ['limit=0', 'limit=abc', 'offset=-1']) {
      const bad = await t.call(user, 'GET', `/api/claims?${query}`);
      expect(bad.status, query).toBe(400);
    }
  });
});

describe('GET /api/claims/:id', () => {
  it('shows the frozen lines with their segments and the events oldest first', async () => {
    const user = await t.makeUser();
    const { debtorId } = await setup(user);
    const created = await claimOK(user, { debtor_id: debtorId });
    t.setNow('2026-10-31T08:00:00Z'); // still inside the session
    for (const [kind, day] of [
      ['DEMAND_SENT', '2026-10-31'],
      ['REMINDER_SENT', '2026-10-30'],
      ['NOTE', '2026-10-31'],
    ] as const) {
      const res = await t.call(
        user,
        'POST',
        `/api/claims/${created.id}/events`,
        {
          kind,
          occurred_on: day,
        },
      );
      expect(res.status, res.text).toBe(201);
    }

    const res = await t.call(user, 'GET', `/api/claims/${created.id}`);

    expect(res.status).toBe(200);
    const { next_action, ...shown } = claimOf(res);
    expect({ ...shown, events: [] }).toEqual({ ...created, events: [] });
    expect(shown.lines[0]?.segments[0]).toMatchObject({
      year_days: 365,
      rate_bp: 1040,
    });
    // Same-day events keep the order in which they were recorded.
    expect(shown.events.map((e) => [e.kind, e.occurred_on])).toEqual([
      ['REMINDER_SENT', '2026-10-30'],
      ['DEMAND_SENT', '2026-10-31'],
      ['NOTE', '2026-10-31'],
    ]);
    // The demand was sent on 31 Oct and today is 31 Oct: the burofax comes next, 10 days later.
    expect(next_action).toMatchObject({
      action: 'SEND_BUROFAX',
      earliest_on: '2026-11-10',
      wait_days: 10,
    });
  });

  it('keeps the numbers of the claim when the rate table or the invoices change afterwards', async () => {
    const user = await t.makeUser();
    const { debtorId, a } = await setup(user);
    const created = await claimOK(user, { debtor_id: debtorId });

    await t.db.query(
      `update legal_interest_rates set rate_bp = 2000, ecb_mro_bp = 1200
        where semester_start = '2026-07-01'`,
    );
    await t.db.query(`update invoices set amount_cents = 999 where id = $1`, [
      a.id,
    ]);
    const { next_action, ...shown } = claimOf(
      await t.call(user, 'GET', `/api/claims/${created.id}`),
    );
    await t.db.query(
      `update legal_interest_rates set rate_bp = 1040, ecb_mro_bp = 240
        where semester_start = '2026-07-01'`,
    );

    expect(shown).toEqual(created);
    expect(next_action?.action).toBe('SEND_REMINDER');
  });

  it('answers 404 for an id that does not exist or is not an id', async () => {
    const user = await t.makeUser();

    for (const id of [MISSING_ID, 'not-a-uuid']) {
      const res = await t.call(user, 'GET', `/api/claims/${id}`);
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
    }
  });
});

describe('the next action of a claim', () => {
  // A claim dated 10 Oct 2026 for a BUSINESS debtor, so events can be recorded from that day on.
  async function newClaim(overrides: Record<string, unknown> = {}) {
    const user = await t.makeUser();
    const { debtorId } = await setup(user);
    const created = await claimOK(user, {
      debtor_id: debtorId,
      as_of: '2026-10-10',
      ...overrides,
    });
    const event = async (kind: string, occurred_on: string) => {
      const res = await t.call(
        user,
        'POST',
        `/api/claims/${created.id}/events`,
        { kind, occurred_on },
      );
      expect(res.status, res.text).toBe(201);
    };
    const next = async () => {
      const res = await t.call(user, 'GET', `/api/claims/${created.id}`);
      expect(res.status, res.text).toBe(200);
      const action = claimOf(res).next_action;
      expect(action).toBeDefined();
      return action as NextActionJson;
    };
    const nextInList = async () => {
      const res = await t.call(user, 'GET', '/api/claims');
      const claims = (res.json as { data: { claims: ClaimListItem[] } }).data
        .claims;
      return claims.find((c) => c.id === created.id)?.next_action;
    };
    return { user, debtorId, created, event, next, nextInList };
  }

  it('starts with the optional reminder, today, and the guide of that step', async () => {
    const { next, nextInList } = await newClaim();

    const action = await next();

    expect(action).toMatchObject({
      action: 'SEND_REMINDER',
      earliest_on: '2026-10-30',
      wait_days: 0,
      warnings: [],
    });
    expect(action.guide.title).toBe('Envía un recordatorio amable');
    expect(action.guide.template?.placeholders).toContain('debtor_name');
    expect(await nextInList()).toEqual({
      action: 'SEND_REMINDER',
      earliest_on: '2026-10-30',
    });
  });

  it('moves up the ladder with each event recorded through the API, in the detail and in the list', async () => {
    const { event, next, nextInList } = await newClaim();

    await event('REMINDER_SENT', '2026-10-12');
    expect(await next()).toMatchObject({
      action: 'SEND_DEMAND',
      earliest_on: '2026-10-19',
      wait_days: 7,
    });
    expect((await next()).reason).toMatch(/^Ya puedes/);

    await event('DEMAND_SENT', '2026-10-25');
    expect(await next()).toMatchObject({
      action: 'SEND_BUROFAX',
      earliest_on: '2026-11-04',
      wait_days: 10,
    });
    expect((await next()).reason).toMatch(/^Aún es pronto/);
    expect(await nextInList()).toEqual({
      action: 'SEND_BUROFAX',
      earliest_on: '2026-11-04',
    });

    await event('BUROFAX_SENT', '2026-10-30');
    const burofax = await next();
    expect(burofax).toMatchObject({
      action: 'FILE_MONITORIO',
      earliest_on: '2026-11-09',
    });
    expect(burofax.guide.template).toBeNull();
    expect(burofax.guide.notes.join(' ')).toContain(
      'Valora consultar a un abogado',
    );

    await event('MONITORIO_FILED', '2026-10-30');
    expect(await next()).toMatchObject({ action: 'DONE', earliest_on: null });
    expect(await nextInList()).toEqual({ action: 'DONE', earliest_on: null });
  });

  it('lets a step be skipped, and a NOTE changes nothing', async () => {
    const { event, next } = await newClaim();

    await event('DEMAND_SENT', '2026-10-20');
    await event('NOTE', '2026-10-29');

    expect(await next()).toMatchObject({
      action: 'SEND_BUROFAX',
      earliest_on: '2026-10-30',
    });
  });

  it('a PAID event closes it', async () => {
    const { event, next, nextInList } = await newClaim();

    await event('REMINDER_SENT', '2026-10-12');
    await event('PAID', '2026-10-28');

    const action = await next();
    expect(action).toMatchObject({ action: 'DONE', earliest_on: null });
    expect(action.reason).toContain('pagada');
    expect(action.guide.title).toBe('No quedan pasos pendientes');
    expect(await nextInList()).toEqual({ action: 'DONE', earliest_on: null });
  });

  it('is BLOCKED when the debtor kind is changed to one that is not a business, and back again', async () => {
    const { user, debtorId, event, next, nextInList } = await newClaim();
    await event('REMINDER_SENT', '2026-10-12');

    for (const kind of ['CONSUMER', 'PUBLIC_ADMIN', 'UNKNOWN']) {
      await setKind(user, debtorId, kind);
      const action = await next();
      expect(action, kind).toMatchObject({
        action: 'BLOCKED',
        earliest_on: null,
        wait_days: 0,
      });
      expect(action.guide.title).toBe(
        'Antes de seguir, revisa el tipo de deudor',
      );
      expect(await nextInList(), kind).toEqual({
        action: 'BLOCKED',
        earliest_on: null,
      });
    }

    await setKind(user, debtorId, 'BUSINESS');
    expect((await next()).action).toBe('SEND_DEMAND');
  });

  it('warns about a possible limitation when the oldest invoice is more than four and a half years old', async () => {
    const user = await t.makeUser();
    const old = await create(user, {
      number: 'OLD',
      issue_date: '2021-02-01',
      due_date: '2021-03-01',
    });
    await setKind(user, old.debtor_id, 'BUSINESS');
    const created = await claimOK(user, { debtor_id: old.debtor_id });

    const res = await t.call(user, 'GET', `/api/claims/${created.id}`);
    const list = await t.call(user, 'GET', '/api/claims');

    const warnings = claimOf(res).next_action?.warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]?.code).toBe('POSSIBLE_LIMITATION');
    expect(warnings?.[0]?.message).toContain('01/03/2021');
    // The list does not carry warnings.
    expect(JSON.stringify(list.json)).not.toContain('POSSIBLE_LIMITATION');
  });

  it('shows each user only the next action of their own claims', async () => {
    const mine = await newClaim();
    const other = await newClaim();
    await other.event('PAID', '2026-10-28');

    const own = await mine.nextInList();
    const theirs = await t.call(
      mine.user,
      'GET',
      `/api/claims/${other.created.id}`,
    );

    expect(own?.action).toBe('SEND_REMINDER');
    expect(theirs.status).toBe(404);
    const list = await t.call(mine.user, 'GET', '/api/claims');
    expect(
      (list.json as { data: { claims: unknown[] } }).data.claims,
    ).toHaveLength(1);
  });

  it('the list works for an empty page and keeps its pagination', async () => {
    const { user } = await newClaim();

    const res = await t.call(user, 'GET', '/api/claims?limit=1&offset=5');

    expect(res.json).toEqual({
      data: { claims: [], page: { limit: 1, offset: 5, total: 1 } },
    });
  });
});

describe('POST /api/claims/:id/events', () => {
  async function newClaim(asOf?: string) {
    const user = await t.makeUser();
    const { debtorId, a } = await setup(user);
    const created = await claimOK(user, {
      debtor_id: debtorId,
      ...(asOf === undefined ? {} : { as_of: asOf }),
    });
    const post = (body: unknown, id = created.id) =>
      t.call(user, 'POST', `/api/claims/${id}/events`, body);
    return { user, created, invoice: a, post };
  }

  it.each([
    'REMINDER_SENT',
    'DEMAND_SENT',
    'BUROFAX_SENT',
    'MONITORIO_FILED',
    'PAID',
    'NOTE',
  ])('records a %s event and shows it in the claim', async (kind) => {
    const { user, created, post } = await newClaim();

    const res = await post({
      kind,
      occurred_on: '2026-10-30',
      note: '  Spoke to the owner  ',
    });

    expect(res.status, res.text).toBe(201);
    expect(eventOf(res)).toEqual({
      id: expect.any(String) as string,
      kind,
      occurred_on: '2026-10-30',
      note: 'Spoke to the owner',
    });
    const shown = claimOf(
      await t.call(user, 'GET', `/api/claims/${created.id}`),
    );
    expect(shown.events).toEqual([eventOf(res)]);
  });

  it('refuses the event after the limit with EVENT_LIMIT_REACHED, creating nothing, and only for that claim', async () => {
    const { user, created, post } = await newClaim();
    const other = await newClaim();
    // Everything but one place is taken (written straight to the database).
    await t.db.query(
      `insert into claim_events (user_id, claim_id, kind, occurred_on)
       select $1::uuid, $2::uuid, 'NOTE', '2026-10-30' from generate_series(1, $3::int)`,
      [user.id, created.id, MAX_EVENTS_PER_CLAIM - 1],
    );
    const event = { kind: 'NOTE', occurred_on: '2026-10-30' };

    const last = await post(event);
    const over = await post(event);

    expect(last.status, last.text).toBe(201);
    expect(over.status, over.text).toBe(422);
    expect(errorOf(over)).toMatchObject({
      code: 'EVENT_LIMIT_REACHED',
      details: { limit: MAX_EVENTS_PER_CLAIM },
    });
    const { rows } = await t.db.query(
      'select count(*)::int as n from claim_events where claim_id = $1',
      [created.id],
    );
    expect(rows).toEqual([{ n: MAX_EVENTS_PER_CLAIM }]);
    // Another claim of another user is not affected.
    expect((await other.post(event)).status).toBe(201);
  });

  it('keeps the note optional: it is stored as null', async () => {
    const { post } = await newClaim();

    const res = await post({ kind: 'BUROFAX_SENT', occurred_on: '2026-10-30' });

    expect(eventOf(res).note).toBeNull();
  });

  it('only records the event: the invoices and the claim do not change, not even for PAID', async () => {
    const { user, created, invoice, post } = await newClaim();
    const before = invoiceOf(
      await t.call(user, 'GET', `/api/invoices/${invoice.id}`),
    );

    const res = await post({ kind: 'PAID', occurred_on: '2026-10-30' });

    expect(res.status).toBe(201);
    const after = invoiceOf(
      await t.call(user, 'GET', `/api/invoices/${invoice.id}`),
    );
    expect(after).toEqual(before);
    expect(after.status).toBe('OPEN');
    const { next_action, ...shown } = claimOf(
      await t.call(user, 'GET', `/api/claims/${created.id}`),
    );
    expect({ ...shown, events: [] }).toEqual({ ...created, events: [] });
    expect(next_action?.action).toBe('DONE'); // the claim is closed, the invoice is not
  });

  it('cannot be in the future', async () => {
    const { post } = await newClaim();

    const res = await post({ kind: 'NOTE', occurred_on: '2026-10-31' });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('EVENT_IN_FUTURE');
  });

  it('cannot be before the date of the claim, but can be on it', async () => {
    const { user, created, post } = await newClaim('2026-10-15');

    const before = await post({ kind: 'NOTE', occurred_on: '2026-10-14' });
    const on = await post({ kind: 'NOTE', occurred_on: '2026-10-15' });

    expect(before.status).toBe(422);
    expect(errorOf(before).code).toBe('EVENT_BEFORE_CLAIM');
    expect(on.status).toBe(201);
    const shown = claimOf(
      await t.call(user, 'GET', `/api/claims/${created.id}`),
    );
    expect(shown.events).toHaveLength(1);
  });

  it('is validated: kind, date and note', async () => {
    const { user, created, post } = await newClaim();
    const ok = { kind: 'NOTE', occurred_on: '2026-10-30' };
    const bad: unknown[] = [
      {},
      { occurred_on: '2026-10-30' },
      { kind: 'NOTE' },
      { ...ok, kind: 'EMAIL_SENT' },
      { ...ok, kind: 'note' },
      { ...ok, occurred_on: '2026-02-30' },
      { ...ok, occurred_on: '30/10/2026' },
      { ...ok, note: 'x'.repeat(1001) },
      { ...ok, note: '   ' },
      { ...ok, note: 42 },
      { ...ok, note: 'line\nbreak' },
      { ...ok, note: 'nul\u0000byte' },
      { ...ok, note: 'zero​width' },
      { ...ok, note: 'evil‮txt.exe' },
      { ...ok, note: 'isolate⁦x⁩' },
    ];

    for (const body of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    // Control: the longest note is accepted, and nothing above was stored.
    expect((await post({ ...ok, note: 'x'.repeat(1000) })).status).toBe(201);
    const shown = claimOf(
      await t.call(user, 'GET', `/api/claims/${created.id}`),
    );
    expect(shown.events).toHaveLength(1);
  });

  it('answers 404 for a claim that does not exist or an id that is not an id', async () => {
    const { post } = await newClaim();

    for (const id of [MISSING_ID, 'not-a-uuid']) {
      const res = await post({ kind: 'NOTE', occurred_on: '2026-10-30' }, id);
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('NOT_FOUND');
    }
  });
});

describe('the rate limit and the session', () => {
  it('counts the claim and event routes in the write limit of the user, and not the reads', async () => {
    const user = await t.makeUser();
    const { debtorId } = await setup(user);
    const created = await claimOK(user, { debtor_id: debtorId });
    // The counter of the current hour is filled up to the limit (120 writes).
    const hour = 60 * 60 * 1000;
    const windowStart = Math.floor(Date.parse(NOW) / hour) * hour;
    await t.db.query(
      `insert into rate_limits (key, window_start, hits) values ($1, $2, 120)
       on conflict (key, window_start) do update set hits = 120`,
      [`write:${hashKeyPart(user.id)}`, new Date(windowStart).toISOString()],
    );

    const blocked = [
      await claim(user, { debtor_id: debtorId }),
      await t.call(user, 'POST', `/api/claims/${created.id}/events`, {
        kind: 'NOTE',
        occurred_on: '2026-10-30',
      }),
    ];

    expect(blocked.map((res) => res.status)).toEqual([429, 429]);
    expect(errorOf(blocked[0] as Answer).code).toBe('RATE_LIMITED');
    expect(await count('claim_events', user)).toBe(0);
    expect((await t.call(user, 'GET', '/api/claims')).status).toBe(200);
    expect(
      (await t.call(user, 'GET', `/api/claims/${created.id}`)).status,
    ).toBe(200);
  });

  it('answers 401 without a session', async () => {
    const answers = [
      await t.call(null, 'GET', '/api/claims'),
      await t.call(null, 'POST', '/api/claims', { debtor_id: MISSING_ID }),
      await t.call(null, 'GET', `/api/claims/${MISSING_ID}`),
      await t.call(null, 'POST', `/api/claims/${MISSING_ID}/events`, {
        kind: 'NOTE',
        occurred_on: '2026-10-30',
      }),
    ];

    expect(answers.map((res) => res.status)).toEqual([401, 401, 401, 401]);
  });
});
