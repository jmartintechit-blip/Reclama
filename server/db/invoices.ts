import type { ISODate } from '../domain/dates.ts';
import type { Cents } from '../domain/money.ts';
import type { Db } from './client.ts';
import {
  CHECK_VIOLATION,
  CLAIM_INVOICE_FK,
  DebtorNotFoundError,
  FOREIGN_KEY_VIOLATION,
  INVOICE_DATES_CHECK,
  INVOICE_DEBTOR_FK,
  INVOICE_NUMBER_UNIQUE,
  InvoiceDatesError,
  InvoiceDuplicateError,
  InvoiceInClaimError,
  UNIQUE_VIOLATION,
  violates,
} from './errors.ts';
import { buildSet, normalizePage, type Page } from './query-helpers.ts';

// Every function takes `userId` first and puts `user_id` in its SQL: an id alone is never
// trusted. An invoice of another user behaves exactly like one that does not exist.

export type InvoiceStatus = 'OPEN' | 'PAID' | 'DISPUTED';

export interface Invoice {
  id: string;
  debtor_id: string;
  number: string;
  issue_date: ISODate;
  due_date: ISODate | null; // null means "issue date + 30 days", an estimate
  amount_cents: Cents;
  agreed_rate_bp: number | null;
  status: InvoiceStatus;
}

export interface NewInvoice {
  debtor_id: string;
  number: string;
  issue_date: ISODate;
  due_date?: ISODate | null;
  amount_cents: Cents;
  agreed_rate_bp?: number | null;
}

// The debtor of an invoice cannot change.
export interface InvoicePatch {
  number?: string;
  issue_date?: ISODate;
  due_date?: ISODate | null;
  amount_cents?: Cents;
  agreed_rate_bp?: number | null;
}

const COLUMNS =
  'id, debtor_id, number, issue_date, due_date, amount_cents, agreed_rate_bp, status';

// An invoice is "in a claim" when a frozen claim line points at it. The claim lines belong to
// the same user, so the check filters by user_id too. It is used inside the write itself, so
// the check and the write are one statement.
const NOT_IN_CLAIM = `not exists (
  select 1 from claim_invoices ci where ci.user_id = $1 and ci.invoice_id = $2
)`;

// Throws DebtorNotFoundError when the debtor does not exist OR belongs to another user: the
// composite foreign key (user_id, debtor_id) makes the database refuse it, and both cases look
// the same to the caller. Throws InvoiceDuplicateError when the debtor already has this number.
export async function createInvoice(
  db: Db,
  userId: string,
  invoice: NewInvoice,
): Promise<Invoice> {
  try {
    const { rows } = await db.query(
      `insert into invoices
         (user_id, debtor_id, number, issue_date, due_date, amount_cents, agreed_rate_bp)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${COLUMNS}`,
      [
        userId,
        invoice.debtor_id,
        invoice.number,
        invoice.issue_date,
        invoice.due_date ?? null,
        invoice.amount_cents,
        invoice.agreed_rate_bp ?? null,
      ],
    );
    return rows[0] as Invoice;
  } catch (error) {
    if (violates(error, FOREIGN_KEY_VIOLATION, INVOICE_DEBTOR_FK)) {
      throw new DebtorNotFoundError();
    }
    if (violates(error, UNIQUE_VIOLATION, INVOICE_NUMBER_UNIQUE)) {
      throw new InvoiceDuplicateError();
    }
    if (violates(error, CHECK_VIOLATION, INVOICE_DATES_CHECK)) {
      throw new InvoiceDatesError();
    }
    throw error;
  }
}

export interface InvoiceFilter {
  status?: InvoiceStatus;
  debtor_id?: string;
}

// A filter that is left out matches everything of the user. `debtor_id` of another user simply
// matches nothing: the user_id condition is always there.
const FILTER_WHERE = `user_id = $1 and ($2::text is null or status = $2)
  and ($3::uuid is null or debtor_id = $3)`;
const filterParams = (userId: string, filter: InvoiceFilter) => [
  userId,
  filter.status ?? null,
  filter.debtor_id ?? null,
];
const LIST_ORDER = 'order by issue_date desc, number desc, id';

// Newest issue date first. The page size is always bounded (see normalizePage).
export async function listInvoices(
  db: Db,
  userId: string,
  filter: InvoiceFilter & Page = {},
): Promise<Invoice[]> {
  const { limit, offset } = normalizePage(filter);
  const { rows } = await db.query(
    `select ${COLUMNS} from invoices where ${FILTER_WHERE}
      ${LIST_ORDER} limit $4 offset $5`,
    [...filterParams(userId, filter), limit, offset],
  );
  return rows as Invoice[];
}

export async function countInvoices(
  db: Db,
  userId: string,
  filter: InvoiceFilter = {},
): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as n from invoices where ${FILTER_WHERE}`,
    filterParams(userId, filter),
  );
  return (rows[0] as { n: number }).n;
}

// The first `max` matching invoices, same order as listInvoices, for the totals of a list. The
// caller chooses the cap (it is a number written in the code, never user input).
export async function listInvoicesUpTo(
  db: Db,
  userId: string,
  filter: InvoiceFilter,
  max: number,
): Promise<Invoice[]> {
  const { rows } = await db.query(
    `select ${COLUMNS} from invoices where ${FILTER_WHERE} ${LIST_ORDER} limit $4`,
    [...filterParams(userId, filter), max],
  );
  return rows as Invoice[];
}

export async function getInvoice(
  db: Db,
  userId: string,
  invoiceId: string,
): Promise<Invoice | null> {
  const { rows } = await db.query(
    `select ${COLUMNS} from invoices where user_id = $1 and id = $2`,
    [userId, invoiceId],
  );
  return (rows[0] as Invoice | undefined) ?? null;
}

// Returns null when the invoice does not exist or is not the user's. Throws InvoiceInClaimError
// when it is part of a claim (its numbers are frozen there) and InvoiceDuplicateError when the
// new number is taken. The claim check is inside the UPDATE, but a claim created at the very
// same moment by another request may still slip past it: an edit does not block the claim's
// own insert (only a delete does, through the foreign key). The claim keeps its own frozen copy.
export async function updateInvoice(
  db: Db,
  userId: string,
  invoiceId: string,
  patch: InvoicePatch,
): Promise<Invoice | null> {
  const { sets, params } = buildSet(
    patch,
    ['number', 'issue_date', 'due_date', 'amount_cents', 'agreed_rate_bp'],
    3,
  );
  if (sets === '') return getInvoice(db, userId, invoiceId);
  try {
    const { rows } = await db.query(
      `update invoices set ${sets}
        where user_id = $1 and id = $2 and ${NOT_IN_CLAIM}
        returning ${COLUMNS}`,
      [userId, invoiceId, ...params],
    );
    if (rows[0]) return rows[0] as Invoice;
  } catch (error) {
    if (violates(error, UNIQUE_VIOLATION, INVOICE_NUMBER_UNIQUE)) {
      throw new InvoiceDuplicateError();
    }
    if (violates(error, CHECK_VIOLATION, INVOICE_DATES_CHECK)) {
      throw new InvoiceDatesError();
    }
    throw error;
  }
  // No row changed: either there is no such invoice for this user, or it is in a claim.
  if ((await getInvoice(db, userId, invoiceId)) === null) return null;
  throw new InvoiceInClaimError();
}

// The status can still change when the invoice is in a claim (the debtor may pay afterwards).
export async function setInvoiceStatus(
  db: Db,
  userId: string,
  invoiceId: string,
  status: InvoiceStatus,
): Promise<Invoice | null> {
  const { rows } = await db.query(
    `update invoices set status = $3 where user_id = $1 and id = $2 returning ${COLUMNS}`,
    [userId, invoiceId, status],
  );
  return (rows[0] as Invoice | undefined) ?? null;
}

// true when deleted, false when there is no such invoice for this user. Its payments go with it
// (cascade). Throws InvoiceInClaimError when it is part of a claim; the foreign key from the
// claim lines is the last line of defence if a claim appears while the delete runs.
export async function deleteInvoice(
  db: Db,
  userId: string,
  invoiceId: string,
): Promise<boolean> {
  try {
    const { rows } = await db.query(
      `delete from invoices where user_id = $1 and id = $2 and ${NOT_IN_CLAIM} returning id`,
      [userId, invoiceId],
    );
    if (rows.length > 0) return true;
  } catch (error) {
    if (violates(error, FOREIGN_KEY_VIOLATION, CLAIM_INVOICE_FK)) {
      throw new InvoiceInClaimError();
    }
    throw error;
  }
  if ((await getInvoice(db, userId, invoiceId)) === null) return false;
  throw new InvoiceInClaimError();
}
