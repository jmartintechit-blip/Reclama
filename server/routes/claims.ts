import type { Response } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import {
  addEvent,
  countClaims,
  countEvents,
  createClaim,
  EVENT_KINDS,
  getClaim,
  getClaimHeader,
  listClaimedInvoiceIds,
  listClaims,
  listEscalationInputs,
  MAX_CLAIMS_PER_USER,
  MAX_EVENTS_PER_CLAIM,
  MAX_INVOICES_PER_CLAIM,
  type ClaimDetail,
} from '../db/claims.ts';
import { getDebtor } from '../db/debtors.ts';
import {
  DebtorNotFoundError,
  InvoiceInClaimError,
  InvoiceNotFoundError,
} from '../db/errors.ts';
import {
  listInvoicesByIds,
  listInvoicesUpTo,
  MAX_INVOICES_PER_USER,
} from '../db/invoices.ts';
import { listPaymentsForInvoices, type Payment } from '../db/payments.ts';
import { getProfile } from '../db/profile.ts';
import { listVerifiedRates } from '../db/rates.ts';
import {
  ClaimError,
  computeClaim,
  type ClaimInvoiceInput,
  type ClaimResult,
} from '../domain/claim.ts';
import { todayMadrid, type Clock } from '../domain/dates.ts';
import { nextAction } from '../domain/escalation.ts';
import { ESCALATION_GUIDE } from '../domain/escalation-guide.ts';
import { RateWindowError, type InterestSegment } from '../domain/interest.ts';
import { WRITE_RATE_LIMIT, type DefineRoute } from '../http/routes.ts';
import { idParam, isoDate, pageQuery, text, uuid } from '../http/schemas.ts';
import { sendError, sendNotFound } from '../middleware/errors.ts';

// Keys that are not listed are dropped by Zod, so a client can never send its own numbers or
// user_id: everything in a claim is calculated on the server. The ids are de-duplicated.
const createSchema = z.object({
  debtor_id: uuid,
  invoice_ids: z
    .array(uuid)
    .min(1)
    .max(MAX_INVOICES_PER_USER)
    .transform((ids) => [...new Set(ids)])
    .optional(),
  as_of: isoDate.optional(),
  compensation_mode: z.enum(['NONE', 'PER_INVOICE', 'PER_CLAIM']).optional(),
});

// Plain text on one line: besides the control characters that `text` refuses, the invisible
// formatting characters (zero width, right-to-left overrides) are refused because they can make
// a note read differently from what it says, in the app and in the letter.
const note = text(1000).refine((value) => !/\p{Cf}/u.test(value), {
  message: 'Must not contain invisible formatting characters',
});

const eventSchema = z.object({
  kind: z.enum(EVENT_KINDS),
  occurred_on: isoDate,
  note: note.optional(),
});

const listQuery = z.object(pageQuery);

const sumOf = (payments: readonly Payment[]): number =>
  payments.reduce((sum, p) => sum + p.amount_cents, 0);

// The frozen segments are stored as the interest engine produced them; the API shows them with
// the same names as GET /api/invoices/:id/interest.
const segmentJson = (s: InterestSegment) => ({
  start: s.start,
  end: s.end,
  days: s.days,
  year_days: s.yearDays,
  rate_bp: s.rateBp,
  balance_cents: s.balance,
  interest_cents: s.interest,
});

const claimJson = (claim: ClaimDetail) => ({
  ...claim,
  lines: claim.lines.map((line) => ({
    ...line,
    segments: line.segments.map(segmentJson),
  })),
});

// The business-rule errors of the repository, as HTTP answers. Returns false for anything else,
// which the caller rethrows (it ends as a 500 without details).
function sendRepoError(res: Response, error: unknown): boolean {
  if (error instanceof DebtorNotFoundError) {
    sendError(res, 404, 'DEBTOR_NOT_FOUND', 'Debtor not found');
  } else if (error instanceof InvoiceNotFoundError) {
    sendError(res, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
  } else if (error instanceof InvoiceInClaimError) {
    sendError(
      res,
      409,
      'INVOICE_IN_CLAIM',
      'An invoice is already part of a claim',
    );
  } else {
    return false;
  }
  return true;
}

function sendClaimTooLarge(res: Response): void {
  sendError(
    res,
    422,
    'CLAIM_TOO_LARGE',
    `A claim can hold at most ${String(MAX_INVOICES_PER_CLAIM)} invoices: choose some with invoice_ids and claim the rest in a second claim`,
    { limit: MAX_INVOICES_PER_CLAIM },
  );
}

export function registerClaimRoutes(
  defineRoute: DefineRoute,
  { db, clock }: { db: Db; clock: Clock },
) {
  defineRoute({
    method: 'GET',
    path: '/api/claims',
    schema: { query: listQuery },
    handler: async ({ res, query, session }) => {
      const userId = session.user.id;
      const total = await countClaims(db, userId);
      const claims = await listClaims(db, userId, query);
      const inputs = await listEscalationInputs(
        db,
        userId,
        claims.map((claim) => claim.id),
      );
      const today = todayMadrid(clock);
      res.json({
        data: {
          // Only the action and the day from which it is suggested: the guide would make the list
          // heavy, and the limitation warning needs the lines, which the list does not load.
          claims: claims.map((claim) => {
            const { action, earliest_on } = nextAction({
              today,
              claim: { lines: [] },
              events: inputs.get(claim.id)?.events ?? [],
              debtorKind: inputs.get(claim.id)?.debtor_kind ?? 'UNKNOWN',
            });
            return { ...claim, next_action: { action, earliest_on } };
          }),
          page: { limit: query.limit, offset: query.offset, total },
        },
      });
    },
  });

  defineRoute({
    method: 'POST',
    path: '/api/claims',
    schema: { body: createSchema },
    rateLimit: WRITE_RATE_LIMIT,
    handler: async ({ res, body, session }) => {
      const userId = session.user.id;
      const debtor = await getDebtor(db, userId, body.debtor_id);
      if (debtor === null) {
        // The debtor is missing OR belongs to someone else: one answer for both.
        sendError(res, 404, 'DEBTOR_NOT_FOUND', 'Debtor not found');
        return;
      }
      if (debtor.kind === 'UNKNOWN') {
        sendError(
          res,
          422,
          'DEBTOR_KIND_UNKNOWN',
          'Set the debtor kind to BUSINESS first with PATCH /api/debtors/:id',
        );
        return;
      }
      const today = todayMadrid(clock);
      const asOf = body.as_of ?? today;
      if (asOf > today) {
        sendError(
          res,
          422,
          'AS_OF_IN_FUTURE',
          'The claim date is in the future',
        );
        return;
      }
      // Counted before anything is written. Requests that run at the same instant can pass the
      // count together and overshoot by a few; the write rate limit keeps that small.
      if ((await countClaims(db, userId)) >= MAX_CLAIMS_PER_USER) {
        sendError(
          res,
          422,
          'CLAIM_LIMIT_REACHED',
          'The limit of claims per account has been reached',
          { limit: MAX_CLAIMS_PER_USER },
        );
        return;
      }

      // Without invoice_ids: every open invoice of the debtor that is not in a claim yet. With
      // them: exactly those, and any that cannot be claimed makes the request fail.
      const requested = body.invoice_ids;
      const explicit = requested !== undefined;
      if (explicit && requested.length > MAX_INVOICES_PER_CLAIM) {
        sendClaimTooLarge(res);
        return;
      }
      const invoices = explicit
        ? await listInvoicesByIds(db, userId, requested)
        : await listInvoicesUpTo(
            db,
            userId,
            { debtor_id: debtor.id, status: 'OPEN' },
            MAX_INVOICES_PER_USER,
          );
      if (explicit) {
        if (invoices.length !== requested.length) {
          sendError(res, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
          return;
        }
        if (invoices.some((invoice) => invoice.debtor_id !== debtor.id)) {
          sendError(
            res,
            422,
            'INVOICE_OTHER_DEBTOR',
            'All the invoices of a claim must belong to the same debtor',
          );
          return;
        }
      }
      const invoiceIds = invoices.map((invoice) => invoice.id);
      const claimed = await listClaimedInvoiceIds(db, userId, invoiceIds);
      if (explicit && claimed.size > 0) {
        sendError(
          res,
          409,
          'INVOICE_IN_CLAIM',
          'An invoice is already part of a claim',
        );
        return;
      }

      const paymentsByInvoice = new Map<string, Payment[]>();
      for (const payment of await listPaymentsForInvoices(
        db,
        userId,
        invoiceIds,
      )) {
        const list = paymentsByInvoice.get(payment.invoice_id) ?? [];
        list.push(payment);
        paymentsByInvoice.set(payment.invoice_id, list);
      }
      const inputs: ClaimInvoiceInput[] = [];
      for (const invoice of invoices) {
        if (claimed.has(invoice.id)) continue;
        const payments = paymentsByInvoice.get(invoice.id) ?? [];
        if (
          invoice.status !== 'OPEN' ||
          invoice.amount_cents - sumOf(payments) <= 0
        ) {
          if (explicit) {
            sendError(
              res,
              422,
              'INVOICE_NOT_OPEN',
              'Only open invoices with an unpaid balance can be claimed',
            );
            return;
          }
          continue;
        }
        inputs.push({
          id: invoice.id,
          principal: invoice.amount_cents,
          issueDate: invoice.issue_date,
          dueDate: invoice.due_date,
          agreedRateBp: invoice.agreed_rate_bp,
          payments: payments.map((p) => ({
            paidOn: p.paid_on,
            amount: p.amount_cents,
          })),
        });
      }

      // The same cap for the default selection: the user then claims the rest in a second claim.
      if (inputs.length > MAX_INVOICES_PER_CLAIM) {
        sendClaimTooLarge(res);
        return;
      }

      const compensationMode =
        body.compensation_mode ??
        (await getProfile(db, userId))?.default_compensation ??
        'PER_CLAIM';
      let result: ClaimResult;
      try {
        // The numbers are always calculated here, from the stored invoices and payments.
        result = computeClaim({
          asOf,
          debtorKind: debtor.kind,
          b2bConfirmed: false,
          compensationMode,
          rates: await listVerifiedRates(db),
          invoices: inputs,
        });
      } catch (error) {
        if (error instanceof ClaimError) {
          sendError(res, 422, error.code, error.message);
        } else if (error instanceof RateWindowError) {
          sendError(
            res,
            422,
            'RATE_WINDOW',
            'No verified legal rate for part of the period',
            { missing_semesters: error.missingSemesters },
          );
        } else if (error instanceof RangeError) {
          sendError(
            res,
            422,
            'CALCULATION_FAILED',
            'The interest cannot be calculated for these invoices',
          );
        } else {
          throw error;
        }
        return;
      }

      try {
        const id = await createClaim(db, userId, {
          debtor_id: debtor.id,
          as_of: asOf,
          result,
        });
        const claim = await getClaim(db, userId, id);
        if (claim === null) {
          sendNotFound(res);
          return;
        }
        res.status(201).json({ data: { claim: claimJson(claim) } });
      } catch (error) {
        if (!sendRepoError(res, error)) throw error;
      }
    },
  });

  defineRoute({
    method: 'GET',
    path: '/api/claims/:id',
    handler: async ({ req, res, session }) => {
      const id = idParam(req.params.id);
      const claim =
        id === null ? null : await getClaim(db, session.user.id, id);
      if (claim === null) {
        sendNotFound(res);
        return;
      }
      const debtor = await getDebtor(db, session.user.id, claim.debtor_id);
      const next = nextAction({
        today: todayMadrid(clock),
        claim,
        events: claim.events,
        debtorKind: debtor?.kind ?? 'UNKNOWN',
      });
      res.json({
        data: {
          claim: {
            ...claimJson(claim),
            // The engine's answer with the matching guide: `next` is computed on every read from
            // the events, nothing about it is stored.
            next_action: { ...next, guide: ESCALATION_GUIDE[next.action] },
          },
        },
      });
    },
  });

  defineRoute({
    method: 'POST',
    path: '/api/claims/:id/events',
    schema: { body: eventSchema },
    rateLimit: WRITE_RATE_LIMIT,
    handler: async ({ req, res, body, session }) => {
      const userId = session.user.id;
      const id = idParam(req.params.id);
      const claim = id === null ? null : await getClaimHeader(db, userId, id);
      // The claim comes first: someone else's claim answers 404 whatever the body says.
      if (claim === null) {
        sendNotFound(res);
        return;
      }
      if (body.occurred_on > todayMadrid(clock)) {
        sendError(
          res,
          422,
          'EVENT_IN_FUTURE',
          'The event date is in the future',
        );
        return;
      }
      if (body.occurred_on < claim.as_of) {
        sendError(
          res,
          422,
          'EVENT_BEFORE_CLAIM',
          'The event date is before the claim date',
        );
        return;
      }
      // Counted before anything is written. Requests that run at the same instant can pass the
      // count together and overshoot by a few; the write rate limit keeps that small.
      if ((await countEvents(db, userId, claim.id)) >= MAX_EVENTS_PER_CLAIM) {
        sendError(
          res,
          422,
          'EVENT_LIMIT_REACHED',
          'The limit of events per claim has been reached',
          { limit: MAX_EVENTS_PER_CLAIM },
        );
        return;
      }
      const event = await addEvent(db, userId, claim.id, body);
      if (event === null) {
        sendNotFound(res); // deleted while this request was running
        return;
      }
      res.status(201).json({ data: { event } });
    },
  });
}
