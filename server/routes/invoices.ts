import type { Response } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { findOrCreateDebtor } from '../db/debtors.ts';
import {
  DebtorNotFoundError,
  InvoiceAmountBelowPaidError,
  InvoiceDatesError,
  InvoiceDuplicateError,
  InvoiceInClaimError,
  PaymentExceedsBalanceError,
} from '../db/errors.ts';
import {
  countInvoices,
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  listInvoicesUpTo,
  MAX_INVOICES_PER_USER,
  setInvoiceStatus,
  updateInvoice,
  type Invoice,
} from '../db/invoices.ts';
import {
  addPayment,
  listPayments,
  listPaymentsForInvoices,
  type Payment,
} from '../db/payments.ts';
import { listVerifiedRates } from '../db/rates.ts';
import { todayMadrid, type Clock } from '../domain/dates.ts';
import { WRITE_RATE_LIMIT, type DefineRoute } from '../http/routes.ts';
import {
  amountCents,
  idParam,
  isoDate,
  pageQuery,
  rateBp,
  text,
  uuid,
} from '../http/schemas.ts';
import { sendError, sendNotFound } from '../middleware/errors.ts';
import {
  buildInvoiceView,
  calculateInvoiceInterest,
  summarizeInvoices,
  type InvoiceView,
} from '../services/invoice-view.ts';
import { email } from './auth.ts';

// The totals of a list are computed over at most this many invoices (the first ones, in the
// order of the list). It keeps one request from loading and calculating an unbounded table; when
// more invoices match, `totals.truncated` is true.
export const TOTALS_ROW_CAP = MAX_INVOICES_PER_USER;

const STATUS = z.enum(['OPEN', 'PAID', 'DISPUTED']);

// Keys that are not listed are dropped by Zod, so user_id and the like can never be written.
const createSchema = z.object({
  debtor_id: uuid.optional(),
  debtor: z
    .object({
      name: text(200),
      tax_id: text(30).nullable().optional(),
      email: email.nullable().optional(),
    })
    .optional(),
  number: text(200),
  issue_date: isoDate,
  due_date: isoDate.nullable().optional(),
  amount_cents: amountCents,
  agreed_rate_bp: rateBp.nullable().optional(),
});

// The debtor of an invoice cannot change. A key left out keeps the stored value; null clears
// due_date and agreed_rate_bp.
const patchSchema = z.object({
  number: text(200).optional(),
  issue_date: isoDate.optional(),
  due_date: isoDate.nullable().optional(),
  amount_cents: amountCents.optional(),
  agreed_rate_bp: rateBp.nullable().optional(),
  status: STATUS.optional(),
});

const paymentSchema = z.object({ paid_on: isoDate, amount_cents: amountCents });

const listQuery = z.object({
  status: STATUS.optional(),
  debtor_id: uuid.optional(),
  ...pageQuery,
});

const interestQuery = z.object({ as_of: isoDate.optional() });

type InvoiceDetail = InvoiceView & { payments: Payment[] };

const sumOf = (payments: readonly Payment[]): number =>
  payments.reduce((sum, p) => sum + p.amount_cents, 0);

// The business-rule errors of the repositories, as HTTP answers. Returns false for anything else,
// which the caller rethrows (it ends as a 500 without details).
function sendRepoError(res: Response, error: unknown): boolean {
  if (error instanceof DebtorNotFoundError) {
    // The debtor is missing OR belongs to someone else: one answer for both.
    sendError(res, 404, 'DEBTOR_NOT_FOUND', 'Debtor not found');
  } else if (error instanceof InvoiceDuplicateError) {
    sendError(res, 409, 'INVOICE_DUPLICATE', error.message);
  } else if (error instanceof InvoiceInClaimError) {
    sendError(res, 409, 'INVOICE_IN_CLAIM', error.message);
  } else if (error instanceof InvoiceDatesError) {
    sendError(res, 422, 'DUE_BEFORE_ISSUE', error.message);
  } else if (error instanceof InvoiceAmountBelowPaidError) {
    sendError(
      res,
      422,
      'AMOUNT_BELOW_PAID',
      'The amount is below what has already been paid',
      { paid_cents: error.paidCents },
    );
  } else if (error instanceof PaymentExceedsBalanceError) {
    sendError(res, 422, 'PAYMENT_EXCEEDS_BALANCE', error.message, {
      remaining_cents: error.remainingCents,
    });
  } else {
    return false;
  }
  return true;
}

export function registerInvoiceRoutes(
  defineRoute: DefineRoute,
  { db, clock }: { db: Db; clock: Clock },
) {
  // The invoice as the API shows it, with its payments. `invoice` must already be the user's.
  async function detail(
    userId: string,
    invoice: Invoice,
    payments?: readonly Payment[],
  ): Promise<InvoiceDetail> {
    const list = payments ?? (await listPayments(db, userId, invoice.id));
    const view = buildInvoiceView(
      invoice,
      list,
      await listVerifiedRates(db),
      todayMadrid(clock),
    );
    return { ...view, payments: [...list] };
  }

  defineRoute({
    method: 'GET',
    path: '/api/invoices',
    schema: { query: listQuery },
    handler: async ({ res, query, session }) => {
      const userId = session.user.id;
      const filter = { status: query.status, debtor_id: query.debtor_id };
      const today = todayMadrid(clock);

      const total = await countInvoices(db, userId, filter);
      const pageRows = await listInvoices(db, userId, { ...filter, ...query });
      const capRows = await listInvoicesUpTo(
        db,
        userId,
        filter,
        TOTALS_ROW_CAP,
      );
      const rates = await listVerifiedRates(db);

      // ONE query for the payments of the page and of the totals together, never one per invoice.
      const ids = new Set([...pageRows, ...capRows].map((row) => row.id));
      const paymentsByInvoice = new Map<string, Payment[]>();
      for (const payment of await listPaymentsForInvoices(db, userId, [
        ...ids,
      ])) {
        const list = paymentsByInvoice.get(payment.invoice_id) ?? [];
        list.push(payment);
        paymentsByInvoice.set(payment.invoice_id, list);
      }
      const viewOf = (row: Invoice) =>
        buildInvoiceView(
          row,
          paymentsByInvoice.get(row.id) ?? [],
          rates,
          today,
        );

      const capViews = new Map(capRows.map((row) => [row.id, viewOf(row)]));
      res.json({
        data: {
          invoices: pageRows.map((row) => capViews.get(row.id) ?? viewOf(row)),
          totals: {
            count: total,
            ...summarizeInvoices([...capViews.values()]),
            truncated: total > TOTALS_ROW_CAP,
          },
          page: { limit: query.limit, offset: query.offset, total },
        },
      });
    },
  });

  defineRoute({
    method: 'POST',
    path: '/api/invoices',
    schema: { body: createSchema },
    rateLimit: WRITE_RATE_LIMIT,
    handler: async ({ res, body, session }) => {
      const userId = session.user.id;
      // Checked here, before anything is written (the database CHECK is only the backstop).
      if (body.due_date != null && body.due_date < body.issue_date) {
        sendError(
          res,
          422,
          'DUE_BEFORE_ISSUE',
          'The due date is before the issue date',
        );
        return;
      }
      // Counted before anything is written. Requests that run at the same instant can pass the
      // count together and overshoot by a few; the write rate limit keeps that small.
      if ((await countInvoices(db, userId)) >= MAX_INVOICES_PER_USER) {
        sendError(
          res,
          422,
          'INVOICE_LIMIT_REACHED',
          'The limit of invoices per account has been reached',
          { limit: MAX_INVOICES_PER_USER },
        );
        return;
      }
      try {
        let debtorId: string;
        if (body.debtor !== undefined && body.debtor_id === undefined) {
          debtorId = (await findOrCreateDebtor(db, userId, body.debtor)).id;
        } else if (body.debtor_id !== undefined && body.debtor === undefined) {
          debtorId = body.debtor_id;
        } else {
          sendError(res, 400, 'VALIDATION_ERROR', 'Request validation failed', [
            { path: 'debtor_id', message: 'Send either debtor_id or debtor' },
          ]);
          return;
        }
        const invoice = await createInvoice(db, userId, {
          ...body,
          debtor_id: debtorId,
        });
        res
          .status(201)
          .json({ data: { invoice: await detail(userId, invoice, []) } });
      } catch (error) {
        if (!sendRepoError(res, error)) throw error;
      }
    },
  });

  defineRoute({
    method: 'GET',
    path: '/api/invoices/:id',
    handler: async ({ req, res, session }) => {
      const userId = session.user.id;
      const id = idParam(req.params.id);
      const invoice = id === null ? null : await getInvoice(db, userId, id);
      if (invoice === null) {
        sendNotFound(res);
        return;
      }
      res.json({ data: { invoice: await detail(userId, invoice) } });
    },
  });

  defineRoute({
    method: 'PATCH',
    path: '/api/invoices/:id',
    schema: { body: patchSchema },
    rateLimit: WRITE_RATE_LIMIT,
    handler: async ({ req, res, body, session }) => {
      const userId = session.user.id;
      const id = idParam(req.params.id);
      const current = id === null ? null : await getInvoice(db, userId, id);
      if (current === null) {
        sendNotFound(res);
        return;
      }
      const { status, ...fields } = body;

      // Dates are checked against the stored row when only one of them is sent.
      const issueDate = fields.issue_date ?? current.issue_date;
      const dueDate =
        fields.due_date === undefined ? current.due_date : fields.due_date;
      if (dueDate !== null && dueDate < issueDate) {
        sendError(
          res,
          422,
          'DUE_BEFORE_ISSUE',
          'The due date is before the issue date',
        );
        return;
      }

      // These checks read the payments and then the write happens in another statement: a
      // payment recorded in between can still slip through (Db has no transactions). For the
      // amount, a database trigger refuses it (reported as AMOUNT_BELOW_PAID below). For the
      // dates, the interest code reports such an invoice as CALCULATION_FAILED, not as a crash.
      const payments = await listPayments(db, userId, current.id);
      const paid = sumOf(payments);
      const amount = fields.amount_cents ?? current.amount_cents;
      if (paid > amount) {
        sendError(
          res,
          422,
          'AMOUNT_BELOW_PAID',
          'The amount is below what has already been paid',
          { paid_cents: paid },
        );
        return;
      }
      if (payments.some((p) => p.paid_on < issueDate)) {
        sendError(
          res,
          422,
          'PAYMENT_BEFORE_ISSUE',
          'A payment is dated before the new issue date',
        );
        return;
      }
      // Nothing left to pay: the invoice is PAID and stays PAID (a payment can not be undone here).
      const settled = paid === amount;
      if (status !== undefined && status !== 'PAID' && settled) {
        sendError(
          res,
          422,
          'INVOICE_FULLY_PAID',
          'The invoice is fully paid and cannot be reopened',
        );
        return;
      }

      try {
        let invoice = current;
        if (Object.keys(fields).length > 0) {
          const updated = await updateInvoice(db, userId, current.id, fields);
          if (updated === null) {
            sendNotFound(res); // deleted while this request was running
            return;
          }
          invoice = updated;
        }
        // Without an explicit status the invoice follows its balance: it becomes PAID when the
        // balance reaches zero, and goes back to OPEN when a raised amount makes it owe again.
        // An invoice marked PAID by hand (balance above zero all along) is left alone.
        let nextStatus = status ?? invoice.status;
        if (status === undefined) {
          if (settled) nextStatus = 'PAID';
          else if (paid === current.amount_cents && invoice.status === 'PAID') {
            nextStatus = 'OPEN';
          }
        }
        if (nextStatus !== invoice.status) {
          const changed = await setInvoiceStatus(
            db,
            userId,
            current.id,
            nextStatus,
          );
          if (changed === null) {
            sendNotFound(res);
            return;
          }
          invoice = changed;
        }
        res.json({
          data: { invoice: await detail(userId, invoice, payments) },
        });
      } catch (error) {
        if (!sendRepoError(res, error)) throw error;
      }
    },
  });

  defineRoute({
    method: 'DELETE',
    path: '/api/invoices/:id',
    rateLimit: WRITE_RATE_LIMIT,
    handler: async ({ req, res, session }) => {
      const id = idParam(req.params.id);
      try {
        const deleted =
          id === null ? false : await deleteInvoice(db, session.user.id, id);
        if (!deleted) {
          sendNotFound(res);
          return;
        }
        res.status(204).end();
      } catch (error) {
        if (!sendRepoError(res, error)) throw error;
      }
    },
  });

  defineRoute({
    method: 'POST',
    path: '/api/invoices/:id/payments',
    schema: { body: paymentSchema },
    rateLimit: WRITE_RATE_LIMIT,
    handler: async ({ req, res, body, session }) => {
      const userId = session.user.id;
      const id = idParam(req.params.id);
      const invoice = id === null ? null : await getInvoice(db, userId, id);
      // The invoice comes first: someone else's invoice answers 404 whatever the body says.
      if (invoice === null) {
        sendNotFound(res);
        return;
      }
      if (body.paid_on > todayMadrid(clock)) {
        sendError(
          res,
          422,
          'PAYMENT_IN_FUTURE',
          'The payment date is in the future',
        );
        return;
      }
      if (body.paid_on < invoice.issue_date) {
        sendError(
          res,
          422,
          'PAYMENT_BEFORE_ISSUE',
          'The payment date is before the issue date',
        );
        return;
      }
      try {
        const payment = await addPayment(db, userId, invoice.id, body);
        // Read again: a payment that settles the invoice has just set it to PAID.
        const fresh = payment && (await getInvoice(db, userId, invoice.id));
        if (!payment || !fresh) {
          sendNotFound(res); // deleted while this request was running
          return;
        }
        res
          .status(201)
          .json({ data: { payment, invoice: await detail(userId, fresh) } });
      } catch (error) {
        if (!sendRepoError(res, error)) throw error;
      }
    },
  });

  defineRoute({
    method: 'GET',
    path: '/api/invoices/:id/interest',
    schema: { query: interestQuery },
    handler: async ({ req, res, query, session }) => {
      const userId = session.user.id;
      const id = idParam(req.params.id);
      const invoice = id === null ? null : await getInvoice(db, userId, id);
      if (invoice === null) {
        sendNotFound(res);
        return;
      }
      const asOf = query.as_of ?? todayMadrid(clock);
      const payments = await listPayments(db, userId, invoice.id);
      const outcome = calculateInvoiceInterest(
        invoice,
        payments,
        await listVerifiedRates(db),
        asOf,
      );
      if (!outcome.ok) {
        if (outcome.error === 'RATE_WINDOW') {
          sendError(
            res,
            422,
            'RATE_WINDOW',
            'No verified legal rate for part of the period',
            { missing_semesters: outcome.missingSemesters },
          );
        } else {
          sendError(
            res,
            422,
            'CALCULATION_FAILED',
            'The interest cannot be calculated for this invoice',
          );
        }
        return;
      }

      const { result } = outcome;
      // Payments after as_of have not happened yet as far as this calculation is concerned.
      const paid = sumOf(payments.filter((p) => p.paid_on <= asOf));
      res.json({
        data: {
          interest: {
            invoice_id: invoice.id,
            as_of: asOf,
            principal_cents: invoice.amount_cents,
            paid_cents: paid,
            balance_cents: invoice.amount_cents - paid,
            due_date_effective: result.dueDate,
            due_date_estimated: result.dueDateEstimated,
            interest_cents: result.interest,
            warnings: result.warnings,
            segments: result.segments.map((s) => ({
              start: s.start,
              end: s.end,
              days: s.days,
              year_days: s.yearDays,
              rate_bp: s.rateBp,
              balance_cents: s.balance,
              interest_cents: s.interest,
            })),
          },
        },
      });
    },
  });
}
