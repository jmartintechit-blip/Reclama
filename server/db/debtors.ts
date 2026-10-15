import type { Db } from './client.ts';
import { buildSet, normalizePage, type Page } from './query-helpers.ts';

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

// Tax ids are compared without spaces or dashes and in upper case: "b-12 345 678" is B12345678.
function normalizeTaxId(taxId: string): string {
  return taxId.toUpperCase().replace(/[\s-]/g, '');
}

// How the same debtor is recognised again (for example in a CSV import). The name is compared
// without accents (NFD, then marks removed), in lower case, with runs of spaces collapsed and
// trimmed. When a tax id is given it is part of the identity: the same name with another tax id
// is another debtor. A JSON array keeps the two parts apart whatever characters they hold.
export function debtorMatchKey(name: string, taxId?: string | null): string {
  const normalizedName = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return JSON.stringify([normalizeTaxId(taxId ?? ''), normalizedName]);
}

// ONE statement: insert, or return the row that already has this match_key. The no-op update
// exists only so that `returning` also gives the existing row; the unique constraint decides
// when two requests race. An existing debtor keeps its stored data (nothing is overwritten).
export async function findOrCreateDebtor(
  db: Db,
  userId: string,
  { name, tax_id }: { name: string; tax_id?: string | null },
): Promise<Debtor> {
  const taxId = normalizeTaxId(tax_id ?? '');
  const { rows } = await db.query(
    `insert into debtors (user_id, name, tax_id, match_key) values ($1, $2, $3, $4)
     on conflict (user_id, match_key) do update set match_key = excluded.match_key
     returning ${COLUMNS}`,
    [
      userId,
      name.trim(),
      taxId === '' ? null : taxId,
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
