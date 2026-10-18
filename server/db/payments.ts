import type { ISODate } from '../domain/dates.ts';
import { toCents, type Cents } from '../domain/money.ts';
import type { Db } from './client.ts';
import {
  CHECK_VIOLATION,
  PAYMENT_TOTAL_CHECK,
  PaymentExceedsBalanceError,
  violates,
} from './errors.ts';

// Every function takes `userId` first and puts `user_id` in its SQL: an id alone is never
// trusted. A payment or invoice of another user behaves exactly like one that does not exist.

export interface Payment {
  id: string;
  invoice_id: string;
  paid_on: ISODate;
  amount_cents: Cents;
}

export interface NewPayment {
  paid_on: ISODate;
  amount_cents: Cents;
}

const COLUMNS = 'id, invoice_id, paid_on, amount_cents';

// What is still owed on invoice `i`: its amount minus the payments recorded so far.
const REMAINING = `i.amount_cents - coalesce(
  (select sum(p.amount_cents) from payments p where p.user_id = i.user_id and p.invoice_id = i.id),
  0)`;

// Records a payment and refuses one above the remaining balance. The check and the insert are
// ONE statement (insert ... select ... where remaining >= amount), so there is no gap between
// "read the balance" and "write the payment" inside this code.
//
// What that does and does not guarantee: Db has no transactions, and a statement works on the
// snapshot taken when it starts, so two payments that run at the same instant both pass this
// check. The database closes that gap: a trigger on payments (migration 0002) locks the invoice
// and re-reads the payments before accepting the row, and refuses it with a check violation.
// That refusal is handled below exactly like "nothing was inserted".
//
// A payment that brings the balance to zero also sets the invoice to PAID, in the SAME statement
// (the second CTE sees the balance as it was before the insert, hence "= the amount").
//
// Returns null when the invoice does not exist or is not the user's; throws
// PaymentExceedsBalanceError (with the balance left) when the amount is too high.
export async function addPayment(
  db: Db,
  userId: string,
  invoiceId: string,
  { paid_on, amount_cents }: NewPayment,
): Promise<Payment | null> {
  const { rows } = await db
    .query(
      `with inserted as (
       insert into payments (user_id, invoice_id, paid_on, amount_cents)
       select i.user_id, i.id, $3::date, $4::bigint
         from invoices i
        where i.user_id = $1 and i.id = $2 and ${REMAINING} >= $4::bigint
       returning ${COLUMNS}
     ), settled as (
       update invoices i set status = 'PAID'
        where i.user_id = $1 and i.id = $2 and exists (select 1 from inserted)
          and ${REMAINING} = $4::bigint
       returning i.id
     )
     select ${COLUMNS} from inserted`,
      [userId, invoiceId, paid_on, amount_cents],
    )
    .catch((error: unknown) => {
      // The trigger refused a payment that raced with another one: same outcome as no row.
      if (violates(error, CHECK_VIOLATION, PAYMENT_TOTAL_CHECK)) {
        return { rows: [] };
      }
      throw error;
    });
  if (rows[0]) return rows[0] as Payment;

  // Nothing was inserted: the invoice is missing (or not the user's), or the amount is too high.
  const { rows: balance } = await db.query(
    `select (${REMAINING})::bigint as remaining_cents
       from invoices i where i.user_id = $1 and i.id = $2`,
    [userId, invoiceId],
  );
  const found = balance[0] as { remaining_cents: number } | undefined;
  if (!found) return null;
  throw new PaymentExceedsBalanceError(toCents(found.remaining_cents));
}

// Oldest first. An empty list means "no payments" or "not the user's invoice": the caller
// checks the invoice first (getInvoice) when it has to tell the two apart.
export async function listPayments(
  db: Db,
  userId: string,
  invoiceId: string,
): Promise<Payment[]> {
  const { rows } = await db.query(
    `select ${COLUMNS} from payments
      where user_id = $1 and invoice_id = $2
      order by paid_on, id`,
    [userId, invoiceId],
  );
  return rows as Payment[];
}

// The payments of many invoices in ONE query, for lists. Another user's invoice id in the array
// matches nothing (user_id is in the condition). Same order as listPayments.
export async function listPaymentsForInvoices(
  db: Db,
  userId: string,
  invoiceIds: readonly string[],
): Promise<Payment[]> {
  const { rows } = await db.query(
    `select ${COLUMNS} from payments
      where user_id = $1 and invoice_id = any($2::uuid[])
      order by paid_on, id`,
    [userId, invoiceIds],
  );
  return rows as Payment[];
}
