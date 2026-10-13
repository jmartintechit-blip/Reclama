import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.ts';

// The schema is the last line of defence for the money and for the isolation between users, so
// it is tested against a real Postgres. Every case is a PAIR: a valid "control" row that must
// be accepted and a bad row, almost identical, that must be rejected with the expected error
// code. The control proves that the rejection comes from the rule under test and not from
// something else (a typo, a missing parent row).
//
// One database is shared by the whole file. Two users (1 and 2) are inserted once and never
// change; each test runs inside BEGIN ... ROLLBACK so it leaves nothing behind.
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await db.query(seedUser(1) + seedUser(2));
}, 30_000);
afterAll(async () => {
  await db.close();
});

const uuid = (n: number): string =>
  `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;

// The ids of the rows seedUser(n) creates.
function ids(n: number) {
  return {
    user: uuid(n),
    debtor: uuid(1_000 + n),
    invoice: uuid(2_000 + n),
    claim: uuid(3_000 + n),
  };
}

// One user with one row in EVERY user-owned table.
function seedUser(n: number): string {
  const { user, debtor, invoice, claim } = ids(n);
  const k = String(n);
  return `
    insert into users (id, email, password_hash) values ('${user}', 'user${k}@example.com', 'hash');
    insert into profiles (user_id, business_name) values ('${user}', 'Business ${k}');
    insert into sessions (token_hash, user_id, expires_at)
      values (sha256('session-${k}'::bytea), '${user}', now() + interval '2 hours');
    insert into debtors (id, user_id, name, match_key) values ('${debtor}', '${user}', 'Debtor ${k}', 'debtor-${k}');
    insert into invoices (id, user_id, debtor_id, number, issue_date, due_date, amount_cents)
      values ('${invoice}', '${user}', '${debtor}', 'F1', '2026-01-01', '2026-01-31', 100000);
    insert into payments (user_id, invoice_id, paid_on, amount_cents) values ('${user}', '${invoice}', '2026-02-01', 5000);
    insert into claims (id, user_id, debtor_id, as_of, compensation_mode, principal_cents, interest_cents, compensation_cents, total_cents, calc_version)
      values ('${claim}', '${user}', '${debtor}', '2026-10-01', 'PER_CLAIM', 100000, 855, 4000, 104855, 'v1');
    insert into claim_invoices (claim_id, invoice_id, user_id, principal_cents, interest_cents, segments)
      values ('${claim}', '${invoice}', '${user}', 100000, 855, '[]');
    insert into claim_events (user_id, claim_id, kind, occurred_on) values ('${user}', '${claim}', 'NOTE', '2026-10-02');
    insert into email_log (user_id, idempotency_key) values ('${user}', 'key-1');
  `;
}

async function inRollback(fn: () => Promise<void>): Promise<void> {
  await db.query('begin');
  try {
    await fn();
  } finally {
    await db.query('rollback');
  }
}

const A = ids(1);
const B = ids(2);

const insertRate = (
  start: string,
  end: string,
  rate: number,
  ecb: number,
  ref: string,
): string => `insert into legal_interest_rates
  (semester_start, semester_end, rate_bp, ecb_mro_bp, boe_ref, published_on, status)
  values ('${start}', '${end}', ${String(rate)}, ${String(ecb)}, '${ref}', '2026-06-30', 'VERIFIED')`;

const insertInvoice = (userId: string, debtorId: string, cents: number) =>
  `insert into invoices (user_id, debtor_id, number, issue_date, amount_cents)
   values ('${userId}', '${debtorId}', 'F2', '2026-01-01', ${String(cents)})`;

const insertPayment = (userId: string, invoiceId: string, cents: number) =>
  `insert into payments (user_id, invoice_id, paid_on, amount_cents)
   values ('${userId}', '${invoiceId}', '2026-02-01', ${String(cents)})`;

const insertClaim = (
  userId: string,
  debtorId: string,
  principal: number,
  interest: number,
  compensation: number,
  total: number,
) => `insert into claims (user_id, debtor_id, as_of, compensation_mode, principal_cents,
    interest_cents, compensation_cents, total_cents, calc_version)
  values ('${userId}', '${debtorId}', '2026-10-01', 'PER_CLAIM', ${String(principal)}, ${String(interest)},
    ${String(compensation)}, ${String(total)}, 'v1')`;

// A claim_invoice needs its own claim and invoice, so the controls use a second claim of A.
const insertClaimInvoice = (
  userId: string,
  claimId: string,
  invoiceId: string,
) => `insert into claim_invoices (claim_id, invoice_id, user_id, principal_cents, interest_cents, segments)
  values ('${claimId}', '${invoiceId}', '${userId}', 100, 0, '[]')`;

const validRate = insertRate(
  '2026-07-01',
  '2026-12-31',
  1040,
  240,
  'BOE-A-2026-14327',
);

describe('constraints on users and reference data', () => {
  const cases: [string, string, string, string][] = [
    [
      'an email in uppercase',
      `insert into users (email, password_hash) values ('new@example.com', 'h')`,
      `insert into users (email, password_hash) values ('New@Example.com', 'h')`,
      CHECK_VIOLATION,
    ],
    [
      'a duplicate email',
      `insert into users (email, password_hash) values ('new@example.com', 'h')`,
      `insert into users (email, password_hash) values ('user1@example.com', 'h')`,
      UNIQUE_VIOLATION,
    ],
    [
      'a demo user with a password',
      `insert into users (is_demo, expires_at) values (true, now())`,
      `insert into users (is_demo, password_hash, expires_at) values (true, 'h', now())`,
      CHECK_VIOLATION,
    ],
    [
      'a real user without a password',
      `insert into users (email, password_hash) values ('new@example.com', 'h')`,
      `insert into users (email) values ('new@example.com')`,
      CHECK_VIOLATION,
    ],
    [
      'a semester that does not start on 1 January or 1 July',
      validRate,
      insertRate('2026-08-01', '2027-01-31', 1040, 240, 'BOE-A-2026-14327'),
      CHECK_VIOLATION,
    ],
    [
      'a semester that starts on day 2',
      validRate,
      insertRate('2026-07-02', '2027-01-01', 1040, 240, 'BOE-A-2026-14327'),
      CHECK_VIOLATION,
    ],
    [
      'a rate that is not the ECB rate plus the spread',
      validRate,
      insertRate('2026-07-01', '2026-12-31', 1041, 240, 'BOE-A-2026-14327'),
      CHECK_VIOLATION,
    ],
    [
      'a BOE reference with the wrong format',
      validRate,
      insertRate('2026-07-01', '2026-12-31', 1040, 240, 'BOE-2026-14327'),
      CHECK_VIOLATION,
    ],
    [
      'a semester_end that is not the last day of the semester',
      validRate,
      insertRate('2026-07-01', '2026-12-30', 1040, 240, 'BOE-A-2026-14327'),
      CHECK_VIOLATION,
    ],
  ];

  it.each(cases)('%s', async (_name, good, bad, code) => {
    await inRollback(async () => {
      await expect(db.query(good)).resolves.toBeDefined();
    });
    await inRollback(async () => {
      await expect(db.query(bad)).rejects.toMatchObject({ code });
    });
  });
});

describe('constraints on money', () => {
  const cases: [string, string, string, string][] = [
    [
      'an invoice of 0 cents',
      insertInvoice(A.user, A.debtor, 1),
      insertInvoice(A.user, A.debtor, 0),
      CHECK_VIOLATION,
    ],
    [
      'an invoice of negative cents',
      insertInvoice(A.user, A.debtor, 1),
      insertInvoice(A.user, A.debtor, -5),
      CHECK_VIOLATION,
    ],
    [
      'a payment of 0 cents',
      insertPayment(A.user, A.invoice, 1),
      insertPayment(A.user, A.invoice, 0),
      CHECK_VIOLATION,
    ],
    [
      'a claim with principal 0',
      insertClaim(A.user, A.debtor, 100, 0, 0, 100),
      insertClaim(A.user, A.debtor, 0, 0, 0, 0),
      CHECK_VIOLATION,
    ],
    [
      'a claim whose total is not principal + interest + compensation',
      insertClaim(A.user, A.debtor, 100000, 855, 4000, 104855),
      insertClaim(A.user, A.debtor, 100000, 855, 4000, 104856),
      CHECK_VIOLATION,
    ],
  ];

  it.each(cases)('%s', async (_name, good, bad, code) => {
    await inRollback(async () => {
      await expect(db.query(good)).resolves.toBeDefined();
    });
    await inRollback(async () => {
      await expect(db.query(bad)).rejects.toMatchObject({ code });
    });
  });
});

describe('isolation between users', () => {
  // The controls point to a parent of the SAME user; the bad rows point to a parent of another.
  const otherClaim = uuid(3_999);
  const claimOfA = `insert into claims (id, user_id, debtor_id, as_of, compensation_mode, principal_cents,
      interest_cents, compensation_cents, total_cents, calc_version)
    values ('${otherClaim}', '${A.user}', '${A.debtor}', '2026-10-01', 'NONE', 100, 0, 0, 100, 'v1');`;
  const cases: [string, string, string][] = [
    [
      'an invoice of A for a debtor of B',
      insertInvoice(A.user, A.debtor, 100),
      insertInvoice(A.user, B.debtor, 100),
    ],
    [
      'a payment of A for an invoice of B',
      insertPayment(A.user, A.invoice, 100),
      insertPayment(A.user, B.invoice, 100),
    ],
    [
      'a claim of A for a debtor of B',
      insertClaim(A.user, A.debtor, 100, 0, 0, 100),
      insertClaim(A.user, B.debtor, 100, 0, 0, 100),
    ],
    [
      'a claim_invoice of A for an invoice of B',
      claimOfA + insertClaimInvoice(A.user, otherClaim, A.invoice),
      claimOfA + insertClaimInvoice(A.user, otherClaim, B.invoice),
    ],
    [
      'a claim_invoice of A for a claim of B',
      claimOfA + insertClaimInvoice(A.user, otherClaim, A.invoice),
      insertClaimInvoice(A.user, B.claim, A.invoice),
    ],
    [
      'a claim_event of A for a claim of B',
      `insert into claim_events (user_id, claim_id, kind, occurred_on) values ('${A.user}', '${A.claim}', 'NOTE', '2026-10-02')`,
      `insert into claim_events (user_id, claim_id, kind, occurred_on) values ('${A.user}', '${B.claim}', 'NOTE', '2026-10-02')`,
    ],
  ];

  it.each(cases)('rejects %s', async (_name, good, bad) => {
    await inRollback(async () => {
      await expect(db.query(good)).resolves.toBeDefined();
    });
    await inRollback(async () => {
      await expect(db.query(bad)).rejects.toMatchObject({
        code: FOREIGN_KEY_VIOLATION,
      });
    });
  });
});

describe('right to erasure', () => {
  it('deleting a user leaves no rows of theirs in any table and does not touch another user', async () => {
    // Every table with a user_id column, read from the catalog: a table added later is
    // checked automatically (and fails loudly here until seedUser fills it).
    const owned = await db.query(
      `select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'user_id' and table_name <> 'users'
       order by table_name`,
    );
    const tables = owned.rows.map((row) => String(row.table_name));
    expect(tables).toHaveLength(9);

    const column = (table: string) => (table === 'users' ? 'id' : 'user_id');
    const countRows = async (
      userId: string,
    ): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {};
      for (const table of ['users', ...tables]) {
        const { rows } = await db.query(
          `select count(*) as n from ${table} where ${column(table)} = $1`,
          [userId],
        );
        counts[table] = Number(rows[0]?.n);
      }
      return counts;
    };

    await inRollback(async () => {
      await db.query(seedUser(3) + seedUser(4));
      const before = await countRows(uuid(3));
      const otherBefore = await countRows(uuid(4));
      // Control: before the delete the user has rows in every table (so "zero" means something).
      expect(Object.values(before).every((n) => n >= 1)).toBe(true);

      await db.query('delete from users where id = $1', [uuid(3)]);

      expect(
        Object.values(await countRows(uuid(3))).every((n) => n === 0),
      ).toBe(true);
      expect(await countRows(uuid(4))).toEqual(otherBefore);
    });
  });
});
