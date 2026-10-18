import type { Response } from 'express';
import type { Db } from '../db/client.ts';
import { getClaim, type ClaimDetail } from '../db/claims.ts';
import { getDebtor, type Debtor } from '../db/debtors.ts';
import { listInvoicesByIds } from '../db/invoices.ts';
import { getProfile, type Profile } from '../db/profile.ts';
import { addDays, todayMadrid, type Clock } from '../domain/dates.ts';
import { parseIban } from '../domain/iban.ts';
import { sanitizeForPdf } from '../domain/pdf-text.ts';
import {
  PDF_RATE_LIMIT,
  type DefineRoute,
  type ValidationDetail,
} from '../http/routes.ts';
import { idParam } from '../http/schemas.ts';
import { sendError, sendNotFound } from '../middleware/errors.ts';
import {
  LetterDataError,
  renderLetter,
  type LetterData,
} from '../services/letter.ts';

// What the letter needs from the profile. The IBAN is optional, but a stored one must be valid.
const REQUIRED_PROFILE_FIELDS = ['business_name', 'tax_id', 'address'] as const;

// A field counts as missing when nothing printable is left after the text is made safe for the
// PDF (a name made only of zero-width characters would print as an empty line).
export function profileProblems(profile: Profile | null): ValidationDetail[] {
  const problems: ValidationDetail[] = [];
  for (const field of REQUIRED_PROFILE_FIELDS) {
    const value = profile?.[field];
    if (value == null || sanitizeForPdf(value).text.trim() === '') {
      problems.push({
        path: field,
        message: 'Required to generate the letter',
      });
    }
  }
  if (profile?.iban != null && parseIban(profile.iban) === null) {
    problems.push({ path: 'iban', message: 'Must be a valid IBAN' });
  }
  return problems;
}

// ASCII only and made of the claim, never of raw user text: lower-case letters, digits and
// hyphens from the first invoice number, or the start of the claim id when none is left.
export function letterFilename(claim: ClaimDetail): string {
  const slug = (claim.lines[0]?.number ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `requerimiento-${slug === '' ? claim.id.slice(0, 8) : slug}.pdf`;
}

export type NotActionableReason =
  'debtor_not_business' | 'marked_paid' | 'invoice_paid';

const NOT_ACTIONABLE_MESSAGES: Record<NotActionableReason, string> = {
  debtor_not_business:
    'The debtor is no longer a business, so a demand cannot be issued for this claim',
  marked_paid: 'The claim has been marked as paid',
  invoice_paid: 'An invoice of the claim has been paid since it was created',
};

// A claim is frozen, but what the letter says ("you owe this") has to be true on the day it is
// issued: the debtor may have been reclassified, or the claim paid, after the claim was created.
// Returns why the demand must not go out now, or null when it can. A missing debtor is left to
// buildLetterData, which reports it.
export async function notActionableReason(
  db: Db,
  userId: string,
  claim: ClaimDetail,
  debtor: Debtor | null,
): Promise<NotActionableReason | null> {
  if (debtor !== null && debtor.kind !== 'BUSINESS') {
    return 'debtor_not_business';
  }
  if (claim.events.some((event) => event.kind === 'PAID')) return 'marked_paid';
  const invoices = await listInvoicesByIds(
    db,
    userId,
    claim.lines.map((line) => line.invoice_id),
  );
  if (invoices.some((invoice) => invoice.status === 'PAID')) {
    return 'invoice_paid';
  }
  return null;
}

export function sendNotActionable(
  res: Response,
  reason: NotActionableReason,
): void {
  sendError(res, 422, 'CLAIM_NOT_ACTIONABLE', NOT_ACTIONABLE_MESSAGES[reason], {
    reason,
  });
}

// The frozen numbers of the claim plus the few facts that only live in the invoice and the debtor.
export async function buildLetterData(
  db: Db,
  userId: string,
  claim: ClaimDetail,
  profile: Profile,
  letterDate: LetterData['letterDate'],
): Promise<LetterData> {
  const debtor = await getDebtor(db, userId, claim.debtor_id);
  const invoices = new Map(
    (
      await listInvoicesByIds(
        db,
        userId,
        claim.lines.map((line) => line.invoice_id),
      )
    ).map((invoice) => [invoice.id, invoice]),
  );
  if (debtor === null) throw new LetterDataError('The debtor is missing');

  return {
    letterDate,
    claimId: claim.id,
    asOf: claim.as_of,
    compensationMode: claim.compensation_mode,
    principal: claim.principal_cents,
    interest: claim.interest_cents,
    compensation: claim.compensation_cents,
    total: claim.total_cents,
    sender: {
      // profileProblems has already checked these three
      name: profile.business_name ?? '',
      taxId: profile.tax_id ?? '',
      address: profile.address ?? '',
      iban: profile.iban === null ? null : parseIban(profile.iban),
    },
    debtor: { name: debtor.name, taxId: debtor.tax_id },
    invoices: claim.lines.map((line) => {
      const invoice = invoices.get(line.invoice_id);
      const first = line.segments[0];
      if (invoice === undefined || first === undefined) {
        throw new LetterDataError('An invoice of the claim cannot be shown');
      }
      return {
        number: line.number,
        issueDate: invoice.issue_date,
        // The interest starts the day after the due date, so the stored segments tell which due
        // date was used, even when the invoice had none and 30 days were added.
        dueDate: addDays(first.start, -1),
        dueDateEstimated: invoice.due_date === null,
        principal: line.principal_cents,
        interest: line.interest_cents,
        segments: line.segments,
      };
    }),
  };
}

export function registerLetterRoute(
  defineRoute: DefineRoute,
  { db, clock }: { db: Db; clock: Clock },
) {
  defineRoute({
    method: 'GET',
    path: '/api/claims/:id/letter.pdf',
    rateLimit: PDF_RATE_LIMIT,
    handler: async ({ req, res, session }) => {
      const userId = session.user.id;
      const id = idParam(req.params.id);
      const claim = id === null ? null : await getClaim(db, userId, id);
      if (claim === null) {
        // Missing, malformed or somebody else's: one answer for all three.
        sendNotFound(res);
        return;
      }

      const profile = await getProfile(db, userId);
      const problems = profileProblems(profile);
      if (profile === null || problems.length > 0) {
        sendError(
          res,
          422,
          'PROFILE_INCOMPLETE',
          'Complete your business profile to generate the letter',
          problems,
        );
        return;
      }

      const reason = await notActionableReason(
        db,
        userId,
        claim,
        await getDebtor(db, userId, claim.debtor_id),
      );
      if (reason !== null) {
        sendNotActionable(res, reason);
        return;
      }

      let pdf: Buffer;
      try {
        pdf = await renderLetter(
          await buildLetterData(db, userId, claim, profile, todayMadrid(clock)),
        );
      } catch (error) {
        if (!(error instanceof LetterDataError)) throw error;
        sendError(
          res,
          422,
          'LETTER_NOT_AVAILABLE',
          'The letter cannot be generated for this claim',
        );
        return;
      }

      // Cache-Control: no-store and X-Content-Type-Options come from the global security headers.
      res
        .status(200)
        .set({
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${letterFilename(claim)}"`,
        })
        .send(pdf);
    },
  });
}
