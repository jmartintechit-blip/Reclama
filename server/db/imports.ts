import { debtorMatchKey } from '../domain/debtor.ts';
import type { ParsedInvoiceRow } from '../domain/csv-import.ts';
import type { Db } from './client.ts';

// Set-based writes for the CSV import: a fixed number of statements whatever the number of rows
// (500 at most), never one query per row. Every column travels as a text[] parameter and is cast
// in SQL, so values (names, numbers) are never part of the SQL text. Like the other repositories,
// every statement filters by `user_id`, which always comes from the session.

export interface ImportCounts {
  debtorsCreated: number;
  invoicesCreated: number;
  invoicesAlreadyImported: number;
}

// The debtor of a row is recognised by the same key the parser uses to find duplicates.
const matchKeyOf = (row: ParsedInvoiceRow): string =>
  debtorMatchKey(row.debtorName, row.taxId);

// What a real import would do, WITHOUT writing: one read statement. `alreadyImported[i]` says
// whether the invoice of `rows[i]` exists (same user, same debtor key, same number).
export async function previewImport(
  db: Db,
  userId: string,
  rows: readonly ParsedInvoiceRow[],
): Promise<ImportCounts & { alreadyImported: boolean[] }> {
  const { rows: found } = await db.query(
    `select d.id is not null as debtor_exists, i.id is not null as invoice_exists
       from unnest($2::text[], $3::text[]) with ordinality as r(match_key, number, ord)
       left join debtors d on d.user_id = $1 and d.match_key = r.match_key
       left join invoices i on i.user_id = $1 and i.debtor_id = d.id and i.number = r.number
      order by r.ord`,
    [userId, rows.map(matchKeyOf), rows.map((row) => row.number)],
  );
  const flags = found as { debtor_exists: boolean; invoice_exists: boolean }[];

  const newDebtors = new Set<string>();
  flags.forEach(({ debtor_exists }, index) => {
    const row = rows[index];
    if (row && !debtor_exists) newDebtors.add(matchKeyOf(row));
  });
  const alreadyImported = flags.map(({ invoice_exists }) => invoice_exists);
  const existing = alreadyImported.filter(Boolean).length;
  return {
    debtorsCreated: newDebtors.size,
    invoicesCreated: rows.length - existing,
    invoicesAlreadyImported: existing,
    alreadyImported,
  };
}

// Creates the missing debtors and the missing invoices of `rows` in TWO statements.
//
// It is idempotent: both inserts are `on conflict do nothing`, so importing the same rows again
// creates nothing. `Db` has no transactions, so if the second statement fails after the first
// one succeeded, the new debtors stay without invoices. That is harmless (a debtor without
// invoices is just an empty entry) and running the same import again completes the work.
//
// An existing debtor keeps its stored data; a new one takes the name, tax id and e-mail from the
// first rows of the file that mention it.
export async function importInvoices(
  db: Db,
  userId: string,
  rows: readonly ParsedInvoiceRow[],
): Promise<ImportCounts> {
  const debtors = new Map<
    string,
    { name: string; taxId: string | null; email: string | null }
  >();
  for (const row of rows) {
    const key = matchKeyOf(row);
    const known = debtors.get(key);
    if (known) known.email ??= row.email;
    else {
      debtors.set(key, {
        name: row.debtorName,
        taxId: row.taxId,
        email: row.email,
      });
    }
  }
  const debtorList = [...debtors.entries()];

  const { rows: newDebtors } = await db.query(
    `insert into debtors (user_id, name, tax_id, email, match_key)
     select $1, d.name, d.tax_id, d.email, d.match_key
       from unnest($2::text[], $3::text[], $4::text[], $5::text[])
            as d(name, tax_id, email, match_key)
     on conflict (user_id, match_key) do nothing
     returning id`,
    [
      userId,
      debtorList.map(([, debtor]) => debtor.name),
      debtorList.map(([, debtor]) => debtor.taxId),
      debtorList.map(([, debtor]) => debtor.email),
      debtorList.map(([key]) => key),
    ],
  );

  // The join takes every debtor id from the database, so a row can only point to one of this
  // user's own debtors (the composite foreign key would refuse anything else anyway).
  const { rows: newInvoices } = await db.query(
    `insert into invoices (user_id, debtor_id, number, issue_date, due_date, amount_cents)
     select $1, d.id, r.number, r.issue_date::date, r.due_date::date, r.amount_cents::bigint
       from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
            as r(match_key, number, issue_date, due_date, amount_cents)
       join debtors d on d.user_id = $1 and d.match_key = r.match_key
     on conflict (user_id, debtor_id, number) do nothing
     returning id`,
    [
      userId,
      rows.map(matchKeyOf),
      rows.map((row) => row.number),
      rows.map((row) => row.issueDate),
      rows.map((row) => row.dueDate),
      rows.map((row) => String(row.amount)),
    ],
  );

  return {
    debtorsCreated: newDebtors.length,
    invoicesCreated: newInvoices.length,
    invoicesAlreadyImported: rows.length - newInvoices.length,
  };
}
