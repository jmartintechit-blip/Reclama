import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CALC_VERSION,
  computeClaim,
  type CompensationMode,
} from '../domain/claim.ts';
import { toCents } from '../domain/money.ts';
import { parseRates } from '../domain/rates.ts';
import {
  addEvent,
  countClaims,
  createClaim,
  getClaim,
  getClaimHeader,
  listClaimedInvoiceIds,
  listClaims,
} from './claims.ts';
import { findOrCreateDebtor } from './debtors.ts';
import { createInvoice } from './invoices.ts';
import { seedRates } from './rates-seed.ts';
import { createTestDb, type TestDb } from './test-db.ts';
import { date, newUser } from './test-fixtures.ts';

const RATES_FILE = new URL(
  '../../data/legal-interest-rates.json',
  import.meta.url,
);
const rates = parseRates(JSON.parse(readFileSync(RATES_FILE, 'utf8')));
const AS_OF = date('2026-10-30');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seedRates(db, rates);
}, 30_000);
afterAll(async () => {
  await db.close();
});

async function addInvoice(
  userId: string,
  debtorId: string,
  number: string,
  amount: number,
) {
  return createInvoice(db, userId, {
    debtor_id: debtorId,
    number,
    issue_date: date('2026-08-31'),
    due_date: date('2026-09-30'),
    amount_cents: toCents(amount),
  });
}

// A user with a debtor and two invoices, 1,000 EUR and 500 EUR, due
// 30 September 2026, so 30 days late on 30 October (interest 855 + 427).
async function setup() {
  const userId = await newUser(db);
  const debtor = await findOrCreateDebtor(db, userId, { name: 'Acme' });
  const a = await addInvoice(userId, debtor.id, 'F-1', 100_000);
  const b = await addInvoice(userId, debtor.id, 'F-2', 50_000);
  return { userId, debtor, a, b };
}

// What the claim endpoint does before it stores: the domain calculation over the given invoices.
function calculate(
  invoices: { id: string; amount_cents: number }[],
  compensationMode: CompensationMode = 'PER_INVOICE',
) {
  return computeClaim({
    asOf: AS_OF,
    debtorKind: 'BUSINESS',
    b2bConfirmed: false,
    compensationMode,
    rates,
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      principal: toCents(invoice.amount_cents),
      issueDate: date('2026-08-31'),
      dueDate: date('2026-09-30'),
      agreedRateBp: null,
      payments: [],
    })),
  });
}

const count = async (table: string, userId: string): Promise<number> => {
  const { rows } = await db.query(
    `select count(*)::int as n from ${table} where user_id = $1`,
    [userId],
  );
  return (rows[0] as { n: number }).n;
};

describe('createClaim and getClaim', () => {
  it.each<[CompensationMode, number, number]>([
    ['PER_INVOICE', 8000, 159_282],
    ['PER_CLAIM', 4000, 155_282],
    ['NONE', 0, 151_282],
  ])(
    'stores exactly what computeClaim returned (%s: compensation %i, total %i)',
    async (mode, compensation, total) => {
      const { userId, debtor, a, b } = await setup();
      const result = calculate([a, b], mode);

      const id = await createClaim(db, userId, {
        debtor_id: debtor.id,
        as_of: AS_OF,
        result,
      });
      const claim = await getClaim(db, userId, id);

      expect(claim).toMatchObject({
        id,
        debtor_id: debtor.id,
        debtor_name: 'Acme',
        as_of: '2026-10-30',
        compensation_mode: mode,
        principal_cents: 150_000,
        interest_cents: 1282,
        compensation_cents: compensation,
        total_cents: total,
        calc_version: CALC_VERSION,
        events: [],
      });
      expect(
        claim?.lines.map((l) => [
          l.invoice_id,
          l.number,
          l.principal_cents,
          l.interest_cents,
        ]),
      ).toEqual([
        [a.id, 'F-1', 100_000, 855],
        [b.id, 'F-2', 50_000, 427],
      ]);
      // The segments are the engine's own output, one entry per semester.
      expect(claim?.lines.map((l) => l.segments)).toEqual(
        result.lines.map((l) => l.segments),
      );
      expect(claim?.lines[0]?.segments).toHaveLength(1);
    },
  );

  it('keeps the numbers frozen when a rate or an invoice changes afterwards', async () => {
    const { userId, debtor, a, b } = await setup();
    const id = await createClaim(db, userId, {
      debtor_id: debtor.id,
      as_of: AS_OF,
      result: calculate([a, b]),
    });
    const before = await getClaim(db, userId, id);

    // Rate of the semester and the invoices, changed straight in the database (the API would
    // refuse to edit an invoice that is in a claim).
    await db.query(
      `update legal_interest_rates set rate_bp = 2000, ecb_mro_bp = 1200
        where semester_start = '2026-07-01'`,
    );
    await db.query(
      `update invoices set amount_cents = 999, agreed_rate_bp = 5000, due_date = '2026-10-01'
        where user_id = $1`,
      [userId],
    );
    const after = await getClaim(db, userId, id);

    expect(after?.principal_cents).toBe(150_000);
    expect(after?.interest_cents).toBe(1282);
    expect(after?.total_cents).toBe(159_282);
    expect(
      after?.lines.map((l) => [l.number, l.principal_cents, l.interest_cents]),
    ).toEqual([
      ['F-1', 100_000, 855],
      ['F-2', 50_000, 427],
    ]);
    expect(after?.lines.map((l) => l.segments)).toEqual(
      before?.lines.map((l) => l.segments),
    );
  });

  it('answers null for a claim that does not exist or is not the user’s', async () => {
    const { userId, debtor, a } = await setup();
    const id = await createClaim(db, userId, {
      debtor_id: debtor.id,
      as_of: AS_OF,
      result: calculate([a]),
    });
    const other = await newUser(db);

    expect(await getClaim(db, other, id)).toBeNull();
    expect(await getClaimHeader(db, other, id)).toBeNull();
    expect(
      await getClaim(db, userId, '00000000-0000-4000-8000-000000000000'),
    ).toBeNull();
    expect(await getClaim(db, userId, id)).not.toBeNull(); // control: the owner sees it
  });
});

describe('createClaim refuses without leaving anything behind', () => {
  it('an invoice that is already in a claim: no new claim and no new line, not even for the free invoice', async () => {
    const { userId, debtor, a, b } = await setup();
    await createClaim(db, userId, {
      debtor_id: debtor.id,
      as_of: AS_OF,
      result: calculate([a]),
    });

    await expect(
      createClaim(db, userId, {
        debtor_id: debtor.id,
        as_of: AS_OF,
        result: calculate([b, a]),
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_IN_CLAIM' });

    expect(await count('claims', userId)).toBe(1);
    expect(await count('claim_invoices', userId)).toBe(1);
    expect([
      ...(await listClaimedInvoiceIds(db, userId, [a.id, b.id])),
    ]).toEqual([a.id]);
  });

  it('an invoice of another user: no claim row survives the failed line', async () => {
    const { userId, debtor, a } = await setup();
    const other = await setup();

    await expect(
      createClaim(db, userId, {
        debtor_id: debtor.id,
        as_of: AS_OF,
        result: calculate([a, other.a]),
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });

    expect(await count('claims', userId)).toBe(0);
    expect(await count('claim_invoices', userId)).toBe(0);
    expect(await count('claim_invoices', other.userId)).toBe(0);
  });

  it('a debtor of another user: nothing is written', async () => {
    const { userId, a } = await setup();
    const other = await setup();

    await expect(
      createClaim(db, userId, {
        debtor_id: other.debtor.id,
        as_of: AS_OF,
        result: calculate([a]),
      }),
    ).rejects.toMatchObject({ code: 'DEBTOR_NOT_FOUND' });

    expect(await count('claims', userId)).toBe(0);
    expect(await count('claim_invoices', userId)).toBe(0);
    expect(await count('claims', other.userId)).toBe(0);
  });
});

describe('listClaims and countClaims', () => {
  it('shows the debtor name, the number of invoices and the last event', async () => {
    const { userId, debtor, a, b } = await setup();
    const id = await createClaim(db, userId, {
      debtor_id: debtor.id,
      as_of: AS_OF,
      result: calculate([a, b]),
    });

    const [first] = await listClaims(db, userId);
    expect(first).toMatchObject({
      id,
      debtor_name: 'Acme',
      as_of: '2026-10-30',
      total_cents: 159_282,
      invoice_count: 2,
      last_event: null,
    });

    await addEvent(db, userId, id, {
      kind: 'REMINDER_SENT',
      occurred_on: date('2026-10-31'),
    });
    await addEvent(db, userId, id, {
      kind: 'NOTE',
      occurred_on: date('2026-10-30'),
    });
    // Same day as the reminder, written later: it is the last one.
    await addEvent(db, userId, id, {
      kind: 'DEMAND_SENT',
      occurred_on: date('2026-10-31'),
    });
    const [again] = await listClaims(db, userId);
    expect(again?.last_event).toEqual({
      kind: 'DEMAND_SENT',
      occurred_on: '2026-10-31',
    });
  });

  it('pages the newest claim date first, counts only the user’s claims and shows nothing of another user', async () => {
    const { userId, debtor } = await setup();
    const asOfs = ['2026-10-10', '2026-10-30', '2026-10-20'];
    const ids: string[] = [];
    for (const [index, asOf] of asOfs.entries()) {
      const invoice = await addInvoice(
        userId,
        debtor.id,
        `P-${String(index)}`,
        1000,
      );
      ids.push(
        await createClaim(db, userId, {
          debtor_id: debtor.id,
          as_of: date(asOf),
          result: calculate([invoice]),
        }),
      );
    }
    const other = await newUser(db);

    expect(await countClaims(db, userId)).toBe(3);
    expect((await listClaims(db, userId)).map((c) => c.as_of)).toEqual([
      '2026-10-30',
      '2026-10-20',
      '2026-10-10',
    ]);
    expect(
      (await listClaims(db, userId, { limit: 1, offset: 1 })).map((c) => c.id),
    ).toEqual([ids[2]]);
    expect(await countClaims(db, other)).toBe(0);
    expect(await listClaims(db, other)).toEqual([]);
  });
});

describe('addEvent', () => {
  it('records the event and lists the events oldest first, same-day events in the order they were recorded', async () => {
    const { userId, debtor, a } = await setup();
    const id = await createClaim(db, userId, {
      debtor_id: debtor.id,
      as_of: AS_OF,
      result: calculate([a]),
    });

    const note = await addEvent(db, userId, id, {
      kind: 'NOTE',
      occurred_on: date('2026-11-05'),
      note: 'Called the accountant',
    });
    await addEvent(db, userId, id, {
      kind: 'REMINDER_SENT',
      occurred_on: date('2026-11-02'),
    });
    await addEvent(db, userId, id, {
      kind: 'PAID',
      occurred_on: date('2026-11-05'),
    });

    expect(note).toEqual({
      id: expect.any(String) as string,
      kind: 'NOTE',
      occurred_on: '2026-11-05',
      note: 'Called the accountant',
    });
    const claim = await getClaim(db, userId, id);
    expect(claim?.events.map((e) => [e.kind, e.occurred_on, e.note])).toEqual([
      ['REMINDER_SENT', '2026-11-02', null],
      ['NOTE', '2026-11-05', 'Called the accountant'],
      ['PAID', '2026-11-05', null],
    ]);
  });

  it('answers null, writing nothing, for a claim of another user or one that does not exist', async () => {
    const { userId, debtor, a } = await setup();
    const id = await createClaim(db, userId, {
      debtor_id: debtor.id,
      as_of: AS_OF,
      result: calculate([a]),
    });
    const other = await newUser(db);
    const event = { kind: 'NOTE', occurred_on: date('2026-11-01') } as const;

    expect(await addEvent(db, other, id, event)).toBeNull();
    expect(
      await addEvent(db, userId, '00000000-0000-4000-8000-000000000000', event),
    ).toBeNull();

    expect(await count('claim_events', userId)).toBe(0);
    expect(await count('claim_events', other)).toBe(0);
  });
});
