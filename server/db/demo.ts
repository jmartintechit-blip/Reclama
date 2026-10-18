import { debtorMatchKey } from '../domain/debtor.ts';
import type { DemoData } from '../domain/demo-data.ts';
import type { Db } from './client.ts';

// The demo user and everything it starts with are written by ONE statement (a chain of CTEs).
// Db has no transactions, so this is what makes the seeding all-or-nothing: if any row is
// refused, Postgres undoes the whole statement and no half-seeded demo can exist. Every column
// travels as a text[] parameter and is cast in SQL, so no value is ever part of the SQL text.
// The foreign keys are checked when the statement ends, so the rows may refer to each other.
export async function createDemoUser(
  db: Db,
  expiresAt: Date,
  { profile, debtors, invoices, payments }: DemoData,
): Promise<{ id: string }> {
  const matchKeys = debtors.map((debtor) =>
    debtorMatchKey(debtor.name, debtor.taxId),
  );
  const { rows } = await db.query(
    `with new_user as (
       insert into users (is_demo, expires_at) values (true, $1) returning id
     ), new_profile as (
       insert into profiles (user_id, business_name, tax_id, address, iban, default_compensation)
       select id, $2, $3, $4, $5, $6 from new_user
     ), new_debtors as (
       insert into debtors (user_id, name, tax_id, email, kind, match_key)
       select u.id, d.name, d.tax_id, d.email, d.kind, d.match_key
         from new_user u
         cross join unnest($7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
              as d(name, tax_id, email, kind, match_key)
       returning id, match_key
     ), new_invoices as (
       insert into invoices (user_id, debtor_id, number, issue_date, due_date, amount_cents)
       select u.id, d.id, i.number, i.issue_date::date, i.due_date::date, i.amount_cents::bigint
         from new_user u
         cross join unnest($12::text[], $13::text[], $14::text[], $15::text[], $16::text[])
              as i(match_key, number, issue_date, due_date, amount_cents)
         join new_debtors d on d.match_key = i.match_key
       returning id, number
     ), new_payments as (
       insert into payments (user_id, invoice_id, paid_on, amount_cents)
       select u.id, n.id, p.paid_on::date, p.amount_cents::bigint
         from new_user u
         cross join unnest($17::text[], $18::text[], $19::text[])
              as p(number, paid_on, amount_cents)
         join new_invoices n on n.number = p.number
     )
     select id from new_user`,
    [
      expiresAt.toISOString(),
      profile.business_name,
      profile.tax_id,
      profile.address,
      profile.iban,
      profile.default_compensation,
      debtors.map((debtor) => debtor.name),
      debtors.map((debtor) => debtor.taxId),
      debtors.map((debtor) => debtor.email),
      debtors.map((debtor) => debtor.kind),
      matchKeys,
      invoices.map((invoice) => matchKeys[invoice.debtor]),
      invoices.map((invoice) => invoice.number),
      invoices.map((invoice) => invoice.issueDate),
      invoices.map((invoice) => invoice.dueDate),
      invoices.map((invoice) => String(invoice.amountCents)),
      payments.map((payment) => invoices[payment.invoice]?.number),
      payments.map((payment) => payment.paidOn),
      payments.map((payment) => String(payment.amountCents)),
    ],
  );
  return rows[0] as { id: string };
}

// Demo users that have not expired yet. A user that expires exactly at `now` counts as expired
// (the same rule as for sessions). `now` comes from the injected clock.
export async function countActiveDemoUsers(db: Db, now: Date): Promise<number> {
  const { rows } = await db.query(
    'select count(*)::int as n from users where is_demo and expires_at > $1',
    [now.toISOString()],
  );
  return (rows[0] as { n: number }).n;
}

// Deletes at most `limit` expired demo users, the oldest first, so one request never has to
// delete an unbounded amount. The cascade removes their sessions and all their data.
export async function purgeExpiredDemoUsers(
  db: Db,
  now: Date,
  limit: number,
): Promise<void> {
  await db.query(
    `delete from users where id in (
       select id from users where is_demo and expires_at <= $1
        order by expires_at limit $2
     )`,
    [now.toISOString(), limit],
  );
}
