import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  debtorMatchKey,
  findOrCreateDebtor,
  countDebtors,
  getDebtor,
  getDebtorWithStats,
  listDebtors,
  listDebtorsWithStats,
  updateDebtor,
} from './debtors.ts';
import { toCents } from '../domain/money.ts';
import { createInvoice, setInvoiceStatus } from './invoices.ts';
import { addPayment } from './payments.ts';
import { date, newUser } from './test-fixtures.ts';
import { createTestDb, type TestDb } from './test-db.ts';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);
afterAll(async () => {
  await db.close();
});

describe('debtorMatchKey', () => {
  it.each([
    ['Muñoz Hermanos S.L.', 'munoz hermanos s.l.'],
    ['  MUÑOZ   hermanos\tS.L.  ', 'munoz hermanos s.l.'],
    ['Muñoz Hermanos S.L.', 'Munoz  Hermanos  S.L.'], // composed ñ vs plain n
    ['Muñoz Hermanos S.L.', 'Muñoz Hermanos S.L.'], // n + combining tilde vs composed ñ
    ['José Álvarez', 'jose alvarez'],
  ])('treats %j and %j as the same name', (a, b) => {
    expect(debtorMatchKey(a)).toBe(debtorMatchKey(b));
  });

  it.each([
    ['Muñoz Hermanos S.L.', 'Munoz Hermano S.L.'],
    ['Acme S.L.', 'Acme S.A.'],
    ['Ana López', 'Anal Opez'], // spaces are collapsed, never removed
  ])('treats %j and %j as different names', (a, b) => {
    expect(debtorMatchKey(a)).not.toBe(debtorMatchKey(b));
  });

  it('compares tax ids without spaces or dashes and in upper case', () => {
    const key = debtorMatchKey('Acme', 'B12345678');

    expect(debtorMatchKey('Acme', ' b-12 345-678 ')).toBe(key);
    expect(debtorMatchKey('Acme', 'B12345679')).not.toBe(key);
  });

  it('makes the tax id part of the identity, and no tax id differs from any tax id', () => {
    expect(debtorMatchKey('Acme', 'B12345678')).not.toBe(
      debtorMatchKey('Acme'),
    );
    expect(debtorMatchKey('Acme', '')).toBe(debtorMatchKey('Acme'));
    expect(debtorMatchKey('Acme', ' - ')).toBe(debtorMatchKey('Acme', null));
  });

  it('cannot confuse the name with the tax id', () => {
    expect(debtorMatchKey('B1|acme')).not.toBe(debtorMatchKey('acme', 'B1'));
    expect(debtorMatchKey('acme', 'B1')).not.toBe(debtorMatchKey('B1', 'acme'));
  });
});

describe('findOrCreateDebtor', () => {
  it('creates a debtor with a trimmed name, a normalised tax id and the UNKNOWN kind', async () => {
    const userId = await newUser(db);

    const debtor = await findOrCreateDebtor(db, userId, {
      name: '  Muñoz Hermanos S.L. ',
      tax_id: 'b-12 345 678',
    });

    expect(debtor).toEqual({
      id: expect.any(String) as string,
      name: 'Muñoz Hermanos S.L.',
      tax_id: 'B12345678',
      email: null,
      kind: 'UNKNOWN',
    });
  });

  it('stores match_key as debtorMatchKey says', async () => {
    const userId = await newUser(db);
    const debtor = await findOrCreateDebtor(db, userId, {
      name: 'José Álvarez',
      tax_id: 'x-1',
    });

    const { rows } = await db.query(
      'select match_key from debtors where id = $1',
      [debtor.id],
    );
    expect(rows).toEqual([
      { match_key: debtorMatchKey('José Álvarez', 'x-1') },
    ]);
  });

  it('returns the same debtor for the same name written another way, and keeps its data', async () => {
    const userId = await newUser(db);
    const first = await findOrCreateDebtor(db, userId, {
      name: 'Muñoz Hermanos S.L.',
    });
    await updateDebtor(db, userId, first.id, {
      kind: 'BUSINESS',
      email: 'pagos@example.com',
    });

    const again = await findOrCreateDebtor(db, userId, {
      name: '  MUNOZ   hermanos s.l. ',
    });

    expect(again).toEqual({
      id: first.id,
      name: 'Muñoz Hermanos S.L.', // the stored name is not overwritten
      tax_id: null,
      email: 'pagos@example.com',
      kind: 'BUSINESS',
    });
    expect(await listDebtors(db, userId)).toHaveLength(1);
  });

  it('keeps the same name with another tax id as another debtor', async () => {
    const userId = await newUser(db);
    const noTaxId = await findOrCreateDebtor(db, userId, { name: 'Acme' });
    const withTaxId = await findOrCreateDebtor(db, userId, {
      name: 'Acme',
      tax_id: 'B12345678',
    });
    const sameTaxId = await findOrCreateDebtor(db, userId, {
      name: 'ACME',
      tax_id: ' b 12345678',
    });
    const otherTaxId = await findOrCreateDebtor(db, userId, {
      name: 'Acme',
      tax_id: 'B87654321',
    });

    expect(new Set([noTaxId.id, withTaxId.id, otherTaxId.id]).size).toBe(3);
    expect(sameTaxId.id).toBe(withTaxId.id);
  });

  it('gives each user their own debtor for the same name', async () => {
    const a = await newUser(db);
    const b = await newUser(db);

    const ofA = await findOrCreateDebtor(db, a, {
      name: 'Acme',
      tax_id: 'B12345678',
    });
    const ofB = await findOrCreateDebtor(db, b, {
      name: 'Acme',
      tax_id: 'B12345678',
    });

    expect(ofB.id).not.toBe(ofA.id);
    expect(await listDebtors(db, a)).toEqual([ofA]);
    expect(await listDebtors(db, b)).toEqual([ofB]);
  });
});

describe('listDebtors', () => {
  it('lists only the debtors of the user, by name', async () => {
    const a = await newUser(db);
    const b = await newUser(db);
    const zeta = await findOrCreateDebtor(db, a, { name: 'Zeta' });
    const alfa = await findOrCreateDebtor(db, a, { name: 'Alfa' });
    await findOrCreateDebtor(db, b, { name: 'Beta of B' });

    expect(await listDebtors(db, a)).toEqual([alfa, zeta]);
  });

  it('returns nothing for a user without debtors or one that does not exist', async () => {
    const a = await newUser(db);
    await findOrCreateDebtor(db, a, { name: 'Alfa' });

    expect(await listDebtors(db, await newUser(db))).toEqual([]);
    expect(await listDebtors(db, MISSING_ID)).toEqual([]);
  });

  it('pages the result and never returns more than the maximum page', async () => {
    const a = await newUser(db);
    for (const name of ['d1', 'd2', 'd3']) {
      await findOrCreateDebtor(db, a, { name });
    }

    expect(
      (await listDebtors(db, a, { limit: 2 })).map((debtor) => debtor.name),
    ).toEqual(['d1', 'd2']);
    expect(
      (await listDebtors(db, a, { limit: 2, offset: 2 })).map(
        (debtor) => debtor.name,
      ),
    ).toEqual(['d3']);
    expect(await listDebtors(db, a, { limit: 1_000_000 })).toHaveLength(3);
  });
});

describe('getDebtor', () => {
  it('returns the own debtor, and null for a debtor of another user or an unknown id', async () => {
    const a = await newUser(db);
    const b = await newUser(db);
    const debtor = await findOrCreateDebtor(db, a, { name: 'Acme' });

    expect(await getDebtor(db, a, debtor.id)).toEqual(debtor);
    expect(await getDebtor(db, b, debtor.id)).toBeNull();
    expect(await getDebtor(db, a, MISSING_ID)).toBeNull();
  });
});

describe('updateDebtor', () => {
  it('changes the kind and the e-mail, together or one at a time, and null clears the e-mail', async () => {
    const a = await newUser(db);
    const debtor = await findOrCreateDebtor(db, a, { name: 'Acme' });

    expect(await updateDebtor(db, a, debtor.id, { kind: 'BUSINESS' })).toEqual({
      ...debtor,
      kind: 'BUSINESS',
    });
    expect(
      await updateDebtor(db, a, debtor.id, { email: 'x@example.com' }),
    ).toEqual({ ...debtor, kind: 'BUSINESS', email: 'x@example.com' });
    expect(
      await updateDebtor(db, a, debtor.id, { kind: 'CONSUMER', email: null }),
    ).toEqual({ ...debtor, kind: 'CONSUMER', email: null });
  });

  it('returns the debtor unchanged for an empty patch', async () => {
    const a = await newUser(db);
    const debtor = await findOrCreateDebtor(db, a, { name: 'Acme' });

    expect(await updateDebtor(db, a, debtor.id, {})).toEqual(debtor);
  });

  it('cannot change the name or the tax id, whatever the patch holds', async () => {
    const a = await newUser(db);
    const debtor = await findOrCreateDebtor(db, a, {
      name: 'Acme',
      tax_id: 'B1',
    });

    await updateDebtor(db, a, debtor.id, {
      kind: 'BUSINESS',
      name: 'Hacked',
      tax_id: 'Z9',
    } as { kind: 'BUSINESS' });

    expect(await getDebtor(db, a, debtor.id)).toEqual({
      ...debtor,
      kind: 'BUSINESS',
    });
  });

  it('does nothing to a debtor of another user and answers null, as for a missing one', async () => {
    const a = await newUser(db);
    const b = await newUser(db);
    const debtor = await findOrCreateDebtor(db, a, { name: 'Acme' });

    expect(
      await updateDebtor(db, b, debtor.id, {
        kind: 'BUSINESS',
        email: 'b@example.com',
      }),
    ).toBeNull();
    expect(await updateDebtor(db, b, debtor.id, {})).toBeNull();
    expect(
      await updateDebtor(db, a, MISSING_ID, { kind: 'BUSINESS' }),
    ).toBeNull();
    expect(await getDebtor(db, a, debtor.id)).toEqual(debtor);
  });
});

describe('findOrCreateDebtor with an e-mail', () => {
  it('stores the e-mail of a new debtor and never overwrites the one of an existing debtor', async () => {
    const userId = await newUser(db);

    const created = await findOrCreateDebtor(db, userId, {
      name: 'Mail Co',
      email: 'first@example.com',
    });
    const again = await findOrCreateDebtor(db, userId, {
      name: 'MAIL CO',
      email: 'second@example.com',
    });

    expect(created.email).toBe('first@example.com');
    expect(again).toEqual(created);
  });
});

describe('debtors with statistics', () => {
  it('counts invoices and sums what is still owed on the invoices that are not PAID', async () => {
    const userId = await newUser(db);
    const other = await newUser(db);
    const acme = await findOrCreateDebtor(db, userId, { name: 'Acme' });
    const empty = await findOrCreateDebtor(db, userId, { name: 'Zed' });
    await findOrCreateDebtor(db, other, { name: 'Acme' });
    const make = (number: string, cents: number) =>
      createInvoice(db, userId, {
        debtor_id: acme.id,
        number,
        issue_date: date('2026-01-01'),
        amount_cents: toCents(cents),
      });
    const one = await make('F-1', 100_000);
    await make('F-2', 50_000);
    const settled = await make('F-3', 20_000);
    await addPayment(db, userId, one.id, {
      paid_on: date('2026-02-01'),
      amount_cents: toCents(30_000),
    });
    await setInvoiceStatus(db, userId, settled.id, 'PAID');

    const list = await listDebtorsWithStats(db, userId);

    expect(list).toEqual([
      {
        ...acme,
        invoice_count: 3,
        open_invoice_count: 2,
        outstanding_cents: 120_000,
      },
      {
        ...empty,
        invoice_count: 0,
        open_invoice_count: 0,
        outstanding_cents: 0,
      },
    ]);
    expect(await getDebtorWithStats(db, userId, acme.id)).toEqual(list[0]);
    expect(await getDebtorWithStats(db, other, acme.id)).toBeNull();
    expect(await countDebtors(db, userId)).toBe(2);
    expect(
      (await listDebtorsWithStats(db, userId, { limit: 1, offset: 1 })).map(
        (debtor) => debtor.name,
      ),
    ).toEqual(['Zed']);
  });
});
