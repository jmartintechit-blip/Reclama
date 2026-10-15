import type { ISODate } from '../domain/dates.ts';
import type { Db } from './client.ts';
import { createUserWithProfile } from './users.ts';

// Shared by the repository tests. `date` only labels a literal as an ISODate.
export const date = (text: string): ISODate => text as ISODate;

let counter = 0;

// A real user (with its empty profile), with an e-mail that no other call returns.
export async function newUser(db: Db): Promise<string> {
  counter += 1;
  const user = await createUserWithProfile(
    db,
    `fixture${String(counter)}@example.com`,
    'fake-hash',
  );
  if (!user) throw new Error('fixture e-mail already taken');
  return user.id;
}

// Puts an invoice inside a claim, like the claim endpoint will: one claim and one frozen line.
export async function putInClaim(
  db: Db,
  userId: string,
  debtorId: string,
  invoiceId: string,
): Promise<void> {
  const { rows } = await db.query(
    `insert into claims (user_id, debtor_id, as_of, compensation_mode, principal_cents,
                         interest_cents, compensation_cents, total_cents, calc_version)
     values ($1, $2, '2026-10-01', 'NONE', 100000, 500, 0, 100500, 'test')
     returning id`,
    [userId, debtorId],
  );
  const { id } = rows[0] as { id: string };
  await db.query(
    `insert into claim_invoices (claim_id, invoice_id, user_id, principal_cents, interest_cents, segments)
     values ($1, $2, $3, 100000, 500, '[]')`,
    [id, invoiceId, userId],
  );
}
