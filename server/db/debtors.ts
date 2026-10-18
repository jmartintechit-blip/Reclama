import { debtorMatchKey, normalizeTaxId } from '../domain/debtor.ts';
import type { Db } from './client.ts';
import { buildSet, normalizePage, type Page } from './query-helpers.ts';

// The pure function lives in the domain (the CSV parser needs it); callers keep importing it here.
export { debtorMatchKey };

// Every function takes `userId` first and puts `user_id` in its SQL: an id alone is never
// trusted. A debtor of another user behaves exactly like one that does not exist.

export type DebtorKind = 'BUSINESS' | 'PUBLIC_ADMIN' | 'CONSUMER' | 'UNKNOWN';

export interface Debtor {
  id: string;
  name: string;
  tax_id: string | null;
  email: string | null;
  kind: DebtorKind;
}

export interface DebtorPatch {
  kind?: DebtorKind;
  email?: string | null;
}

const COLUMNS = 'id, name, tax_id, email, kind';

// ONE statement: insert, or return the row that already has this match_key. The no-op update
// exists only so that `returning` also gives the existing row; the unique constraint decides
// when two requests race. An existing debtor keeps its stored data (nothing is overwritten,
// the e-mail included).
export async function findOrCreateDebtor(
  db: Db,
  userId: string,
  {
    name,
    tax_id,
    email,
  }: { name: string; tax_id?: string | null; email?: string | null },
): Promise<Debtor> {
  const taxId = normalizeTaxId(tax_id ?? '');
  const { rows } = await db.query(
    `insert into debtors (user_id, name, tax_id, email, match_key) values ($1, $2, $3, $4, $5)
     on conflict (user_id, match_key) do update set match_key = excluded.match_key
     returning ${COLUMNS}`,
    [
      userId,
      name.trim(),
      taxId === '' ? null : taxId,
      email ?? null,
      debtorMatchKey(name, tax_id),
    ],
  );
  return rows[0] as Debtor;
}

export async function listDebtors(
  db: Db,
  userId: string,
  page?: Page,
): Promise<Debtor[]> {
  const { limit, offset } = normalizePage(page);
  const { rows } = await db.query(
    `select ${COLUMNS} from debtors where user_id = $1
     order by name, id limit $2 offset $3`,
    [userId, limit, offset],
  );
  return rows as Debtor[];
}

export interface DebtorWithStats extends Debtor {
  invoice_count: number;
  open_invoice_count: number; // invoices that are not PAID
  outstanding_cents: number; // amount minus payments, summed over the invoices that are not PAID
}

// The debtor columns plus three figures computed by the database in the same statement (no
// query per debtor). Invoices and payments are joined on user_id as well, like everywhere else.
const WITH_STATS = `select d.id, d.name, d.tax_id, d.email, d.kind,
       count(x.id)::int as invoice_count,
       (count(x.id) filter (where x.status <> 'PAID'))::int as open_invoice_count,
       (coalesce(sum(x.balance) filter (where x.status <> 'PAID'), 0))::bigint as outstanding_cents
  from debtors d
  left join lateral (
    select i.id, i.status, i.amount_cents - coalesce(
      (select sum(p.amount_cents) from payments p
        where p.user_id = i.user_id and p.invoice_id = i.id), 0) as balance
      from invoices i where i.user_id = d.user_id and i.debtor_id = d.id
  ) x on true
 where d.user_id = $1`;

export async function listDebtorsWithStats(
  db: Db,
  userId: string,
  page?: Page,
): Promise<DebtorWithStats[]> {
  const { limit, offset } = normalizePage(page);
  const { rows } = await db.query(
    `${WITH_STATS} group by d.id order by d.name, d.id limit $2 offset $3`,
    [userId, limit, offset],
  );
  return rows as DebtorWithStats[];
}

export async function getDebtorWithStats(
  db: Db,
  userId: string,
  debtorId: string,
): Promise<DebtorWithStats | null> {
  const { rows } = await db.query(`${WITH_STATS} and d.id = $2 group by d.id`, [
    userId,
    debtorId,
  ]);
  return (rows[0] as DebtorWithStats | undefined) ?? null;
}

export async function countDebtors(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query(
    'select count(*)::int as n from debtors where user_id = $1',
    [userId],
  );
  return (rows[0] as { n: number }).n;
}

export async function getDebtor(
  db: Db,
  userId: string,
  debtorId: string,
): Promise<Debtor | null> {
  const { rows } = await db.query(
    `select ${COLUMNS} from debtors where user_id = $1 and id = $2`,
    [userId, debtorId],
  );
  return (rows[0] as Debtor | undefined) ?? null;
}

// Only `kind` and `email` can change: the name and tax id define who the debtor is (match_key).
// Returns null when the debtor does not exist or belongs to someone else.
export async function updateDebtor(
  db: Db,
  userId: string,
  debtorId: string,
  patch: DebtorPatch,
): Promise<Debtor | null> {
  const { sets, params } = buildSet(patch, ['kind', 'email'], 3);
  if (sets === '') return getDebtor(db, userId, debtorId);
  const { rows } = await db.query(
    `update debtors set ${sets} where user_id = $1 and id = $2 returning ${COLUMNS}`,
    [userId, debtorId, ...params],
  );
  return (rows[0] as Debtor | undefined) ?? null;
}
