import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ISODate } from '../domain/dates.ts';
import { buildDemoData } from '../domain/demo-data.ts';
import type { Db } from './client.ts';
import {
  countActiveDemoUsers,
  createDemoUser,
  purgeExpiredDemoUsers,
} from './demo.ts';
import { createTestDb, type TestDb } from './test-db.ts';

const TODAY = '2026-10-18' as ISODate;
const NOW = new Date('2026-10-18T10:00:00Z');
const HOUR = 60 * 60 * 1000;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);
afterAll(async () => {
  await db.close();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return (rows[0] as { n: number }).n;
}

// Plain demo users with nothing in them, to test the count and the purge.
async function insertDemoUsers(n: number, expiresAt: Date): Promise<void> {
  await db.query(
    'insert into users (is_demo, expires_at) select true, $2 from generate_series(1, $1::int)',
    [n, expiresAt.toISOString()],
  );
}

describe('createDemoUser', () => {
  it('writes the user and all its data with ONE statement', async () => {
    const statements: string[] = [];
    const spy: Db = {
      query: (sql, params) => {
        statements.push(sql);
        return db.query(sql, params);
      },
    };
    const data = buildDemoData(TODAY);

    const { id } = await createDemoUser(
      spy,
      new Date(NOW.getTime() + 24 * HOUR),
      data,
    );

    expect(statements).toHaveLength(1);
    const owned = (table: string) =>
      count(`select count(*)::int as n from ${table} where user_id = $1`, [id]);
    expect(await owned('profiles')).toBe(1);
    expect(await owned('debtors')).toBe(6);
    expect(await owned('invoices')).toBe(14);
    expect(await owned('payments')).toBe(1);
    const { rows } = await db.query(
      'select is_demo, email, password_hash, expires_at from users where id = $1',
      [id],
    );
    expect(rows).toEqual([
      {
        is_demo: true,
        email: null,
        password_hash: null,
        expires_at: new Date(NOW.getTime() + 24 * HOUR),
      },
    ]);
  });

  it('stores the profile, the debtors and the invoices as the builder made them', async () => {
    const data = buildDemoData(TODAY);
    const { id } = await createDemoUser(db, NOW, data);

    const profile = await db.query(
      'select business_name, tax_id, address, iban, default_compensation from profiles where user_id = $1',
      [id],
    );
    expect(profile.rows).toEqual([{ ...data.profile }]);
    const kinds = await db.query(
      'select kind, count(*)::int as n from debtors where user_id = $1 group by kind order by kind',
      [id],
    );
    expect(kinds.rows).toEqual([
      { kind: 'BUSINESS', n: 3 },
      { kind: 'CONSUMER', n: 1 },
      { kind: 'PUBLIC_ADMIN', n: 1 },
      { kind: 'UNKNOWN', n: 1 },
    ]);
    const invoices = await db.query(
      `select i.number, i.issue_date, i.due_date, i.amount_cents, d.name
         from invoices i join debtors d on d.user_id = i.user_id and d.id = i.debtor_id
        where i.user_id = $1 order by i.number`,
      [id],
    );
    expect(invoices.rows).toEqual(
      data.invoices
        .map((invoice) => ({
          number: invoice.number,
          issue_date: invoice.issueDate,
          due_date: invoice.dueDate,
          amount_cents: invoice.amountCents,
          name: data.debtors[invoice.debtor]?.name,
        }))
        .sort((a, b) => (a.number < b.number ? -1 : 1)),
    );
    const payment = await db.query(
      `select i.number, p.paid_on, p.amount_cents
         from payments p join invoices i on i.user_id = p.user_id and i.id = p.invoice_id
        where p.user_id = $1`,
      [id],
    );
    const [seeded] = data.payments;
    expect(payment.rows).toEqual([
      {
        number: data.invoices[seeded?.invoice ?? -1]?.number,
        paid_on: seeded?.paidOn,
        amount_cents: seeded?.amountCents,
      },
    ]);
  });

  it('leaves nothing behind when any row is refused (two invoices with the same number)', async () => {
    const data = buildDemoData(TODAY);
    const [first, second, ...rest] = data.invoices;
    if (!first || !second) throw new Error('not enough invoices');
    const broken = {
      ...data,
      invoices: [
        first,
        { ...second, debtor: first.debtor, number: first.number },
        ...rest,
      ],
    };
    const usersBefore = await count('select count(*)::int as n from users');
    const rowsBefore = await count(
      'select (select count(*) from debtors) + (select count(*) from invoices) + (select count(*) from profiles) as n',
    );

    await expect(createDemoUser(db, NOW, broken)).rejects.toThrow();

    expect(await count('select count(*)::int as n from users')).toBe(
      usersBefore,
    );
    expect(
      await count(
        'select ((select count(*) from debtors) + (select count(*) from invoices) + (select count(*) from profiles))::int as n',
      ),
    ).toBe(rowsBefore);
  });
});

describe('countActiveDemoUsers and purgeExpiredDemoUsers', () => {
  it('counts only demo users that have not expired, and a user expiring exactly now is expired', async () => {
    const base = await countActiveDemoUsers(db, NOW);
    await insertDemoUsers(3, new Date(NOW.getTime() + HOUR));
    await insertDemoUsers(2, NOW);
    await insertDemoUsers(1, new Date(NOW.getTime() - HOUR));
    await db.query(
      "insert into users (email, password_hash) values ('real-count@example.com', 'hash')",
    );

    expect(await countActiveDemoUsers(db, NOW)).toBe(base + 3);
  });

  it('deletes the expired demo users with their data, and nothing else', async () => {
    const expired = await createDemoUser(
      db,
      new Date(NOW.getTime() - HOUR),
      buildDemoData(TODAY),
    );
    const alive = await createDemoUser(
      db,
      new Date(NOW.getTime() + HOUR),
      buildDemoData(TODAY),
    );
    await db.query(
      "insert into users (email, password_hash) values ('real-purge@example.com', 'hash')",
    );
    await db.query(
      'insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)',
      [
        Buffer.alloc(32, 7),
        expired.id,
        new Date(NOW.getTime() + HOUR).toISOString(),
      ],
    );

    // Large enough to take every expired user that exists at this point.
    await purgeExpiredDemoUsers(db, NOW, 1000);

    const left = (table: string, userId: string) =>
      count(`select count(*)::int as n from ${table} where user_id = $1`, [
        userId,
      ]);
    for (const table of [
      'profiles',
      'debtors',
      'invoices',
      'payments',
      'sessions',
    ]) {
      expect(await left(table, expired.id), table).toBe(0);
    }
    expect(
      await count('select count(*)::int as n from users where id = $1', [
        expired.id,
      ]),
    ).toBe(0);
    expect(await left('invoices', alive.id)).toBe(14);
    expect(
      await count(
        "select count(*)::int as n from users where email = 'real-purge@example.com'",
      ),
    ).toBe(1);
    expect(
      await count(
        'select count(*)::int as n from users where is_demo and expires_at <= $1',
        [NOW.toISOString()],
      ),
    ).toBe(0);
  });

  it('deletes at most `limit` per call, the oldest first', async () => {
    await purgeExpiredDemoUsers(db, NOW, 1000);
    await insertDemoUsers(5, new Date(NOW.getTime() - 5 * HOUR));
    await insertDemoUsers(5, new Date(NOW.getTime() - HOUR));

    await purgeExpiredDemoUsers(db, NOW, 7);

    const { rows } = await db.query(
      'select expires_at from users where is_demo and expires_at <= $1 order by expires_at',
      [NOW.toISOString()],
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (row) =>
          (row as { expires_at: Date }).expires_at.getTime() ===
          NOW.getTime() - HOUR,
      ),
    ).toBe(true);
  });
});
