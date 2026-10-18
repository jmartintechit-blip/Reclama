import type { EmailConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import { addEvent, getClaim, type ClaimDetail } from '../db/claims.ts';
import { getDebtor } from '../db/debtors.ts';
import { claimEmailKey, releaseEmailKey } from '../db/email-log.ts';
import { getProfile } from '../db/profile.ts';
import {
  hashKeyPart,
  hitRateLimit,
  refundRateLimit,
  type RateLimitRule,
} from '../db/rate-limits.ts';
import {
  addDays,
  todayMadrid,
  type Clock,
  type ISODate,
} from '../domain/dates.ts';
import { formatEUR } from '../domain/money.ts';
import {
  sendRateLimited,
  type DefineRoute,
  type ValidationDetail,
} from '../http/routes.ts';
import { idParam } from '../http/schemas.ts';
import { sendError, sendNotFound } from '../middleware/errors.ts';
import { getRequestId } from '../middleware/request-id.ts';
import {
  formatDate,
  LetterDataError,
  PAYMENT_DEADLINE_DAYS,
  renderLetter,
} from '../services/letter.ts';
import {
  MailerError,
  type Mailer,
  type MailerErrorCode,
  type SendResult,
} from '../services/mailer.ts';
import {
  buildLetterData,
  letterFilename,
  notActionableReason,
  profileProblems,
  sendNotActionable,
} from './letter.ts';

// The client picks the key (a UUID is the usual choice) and sends the same one when it retries.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

// Fixed UTC-day windows (the counter starts at 00:00 UTC), as the rate limiter works. The global
// counter is one fixed key with no user data in it: it caps what the whole service sends, which
// keeps it under the daily quota of the free plan of the provider.
const DAY_SECONDS = 24 * 60 * 60;
const GLOBAL_EMAIL_LIMIT: RateLimitRule = {
  key: 'email-global',
  limit: 20,
  windowSeconds: DAY_SECONDS,
};
const userEmailLimit = (userId: string): RateLimitRule => ({
  key: `email-user:${hashKeyPart(userId)}`,
  limit: 3,
  windowSeconds: DAY_SECONDS,
});

const FAILURE_REASONS: Record<MailerErrorCode, string> = {
  PROVIDER_UNAVAILABLE: 'unavailable',
  PROVIDER_RATE_LIMITED: 'rate_limited',
  PROVIDER_REJECTED: 'rejected',
  PROVIDER_INVALID: 'invalid',
};

// User text that goes into a subject or a greeting loses control and invisible formatting
// characters (zero width, right-to-left overrides), which can make a line read differently.
const plain = (value: string): string =>
  value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();

// "Requerimiento de pago F-1, F-2, F-3 y 2 más", or the start of the claim id when no invoice
// number is left to show.
function subjectOf(claim: ClaimDetail): string {
  const numbers = claim.lines
    .map((line) => plain(line.number).slice(0, 40))
    .filter((number) => number !== '');
  const shown = numbers.slice(0, 3).join(', ');
  const more = numbers.length - 3;
  const reference =
    numbers.length === 0
      ? `ref. ${claim.id.slice(0, 8)}`
      : more > 0
        ? `${shown} y ${String(more)} más`
        : shown;
  return `Requerimiento de pago ${reference}`;
}

// Plain text only. The numbers are the frozen ones of the claim, and the deadline is the one
// printed in the letter. `divertedFrom` is the debtor's address when the message was redirected.
function textOf({
  claim,
  senderName,
  debtorName,
  letterDate,
  divertedFrom,
}: {
  claim: ClaimDetail;
  senderName: string;
  debtorName: string;
  letterDate: ISODate;
  divertedFrom: string | null;
}): string {
  const deadline = addDays(letterDate, PAYMENT_DEADLINE_DAYS);
  return [
    ...(divertedFrom === null
      ? []
      : [
          `[PRUEBA] Este mensaje se habría enviado a ${divertedFrom}. No se ha enviado al deudor.`,
          '',
        ]),
    `A la atención de ${debtorName}:`,
    '',
    `${senderName} le remite el requerimiento formal de pago que se adjunta en PDF.`,
    '',
    `Importe reclamado a fecha ${formatDate(claim.as_of)}: ${formatEUR(claim.total_cents)}`,
    `Plazo de pago: hasta el ${formatDate(deadline)} (inclusive)`,
    '',
    'El desglose de las facturas, los intereses y la compensación figura en el documento adjunto.',
    '',
    senderName,
    '',
    '--',
    'Mensaje generado con Reclama, una herramienta informativa que no constituye asesoramiento jurídico.',
  ].join('\n');
}

export function registerEmailRoute(
  defineRoute: DefineRoute,
  {
    db,
    clock,
    mailer,
    emailConfig,
  }: {
    db: Db;
    clock: Clock;
    mailer: Mailer | undefined;
    emailConfig: EmailConfig;
  },
) {
  // The order of the steps is part of the contract: what the caller got wrong first (the header),
  // then what does not exist, then what the server lacks, then what the data lacks (including a
  // claim that can no longer be demanded), then the key is claimed, then the limits are counted,
  // and only then the email is sent. The key comes before the limits so that a replay (409) never
  // uses up quota; if a limit refuses, or the letter or the provider fails, the key is given back
  // and the hits this request counted are refunded, because nothing was sent. The limits are
  // checked here and not by defineRoute, which would count them before the 404 and 422 answers.
  defineRoute({
    method: 'POST',
    path: '/api/claims/:id/email',
    handler: async ({ req, res, session }) => {
      const userId = session.user.id;

      const clientKey = req.get('Idempotency-Key');
      if (clientKey === undefined || !IDEMPOTENCY_KEY.test(clientKey)) {
        const details: ValidationDetail[] = [
          {
            path: 'Idempotency-Key',
            message:
              'Required: 8 to 128 characters, only letters, digits, "_" and "-"',
          },
        ];
        sendError(
          res,
          400,
          'VALIDATION_ERROR',
          'Request validation failed',
          details,
        );
        return;
      }

      const id = idParam(req.params.id);
      const claim = id === null ? null : await getClaim(db, userId, id);
      if (claim === null) {
        sendNotFound(res); // missing, malformed or somebody else's: one answer
        return;
      }

      if (mailer === undefined) {
        sendError(
          res,
          503,
          'EMAIL_NOT_CONFIGURED',
          'Email sending is not configured',
        );
        return;
      }

      const debtor = await getDebtor(db, userId, claim.debtor_id);
      const debtorEmail = debtor?.email ?? null;
      if (debtor === null || debtorEmail === null) {
        sendError(
          res,
          422,
          'DEBTOR_EMAIL_MISSING',
          'The debtor has no email address',
        );
        return;
      }

      const profile = await getProfile(db, userId);
      const problems = profileProblems(profile);
      if (profile === null || problems.length > 0) {
        sendError(
          res,
          422,
          'PROFILE_INCOMPLETE',
          'Complete your business profile to send the letter',
          problems,
        );
        return;
      }

      const reason = await notActionableReason(db, userId, claim, debtor);
      if (reason !== null) {
        sendNotActionable(res, reason);
        return;
      }

      // Without a verified sending domain Resend delivers only to the account owner, and an open
      // "send this letter to any address" endpoint would be a spam vector. So unless the server
      // is explicitly in live mode, the message goes to the test recipient and not to the debtor.
      // Demo accounts (anyone can open one, with no email check) never leave the sandbox, whatever
      // the mode is.
      const sandbox = emailConfig.mode === 'sandbox' || session.user.is_demo;
      const to = sandbox ? emailConfig.testRecipient : debtorEmail;

      // The same string is the row in email_log and the Idempotency-Key sent to the provider.
      // Scoped by claim, so a client key reused on another claim is a different send.
      const sendKey = `${claim.id}:${clientKey}`;
      if (!(await claimEmailKey(db, userId, sendKey))) {
        sendError(
          res,
          409,
          'EMAIL_ALREADY_SENT',
          'An email with this Idempotency-Key was already sent',
        );
        return;
      }

      // Everything this request took (the key and the hits) is given back when nothing is sent.
      // When the outcome is unknown (the provider timed out or failed on its side, so it may have
      // accepted the email) the key is still released, so the client can retry with the same key
      // and the provider's own idempotency stops a second email, but the hits stay used.
      const counted: RateLimitRule[] = [];
      const giveBack = async (refundHits = true) => {
        await releaseEmailKey(db, userId, sendKey);
        if (refundHits) {
          for (const rule of counted) await refundRateLimit(db, clock, rule);
        }
      };

      let retryAfterSeconds: number | null = null;
      try {
        for (const rule of [userEmailLimit(userId), GLOBAL_EMAIL_LIMIT]) {
          const result = await hitRateLimit(db, clock, rule);
          if (!result.allowed) {
            retryAfterSeconds = result.retryAfterSeconds;
            break; // the refused hit stays counted, as in every other limit
          }
          counted.push(rule);
        }
      } catch (error) {
        await giveBack(); // a failing limiter fails closed (500), and the key is not left claimed
        throw error;
      }
      if (retryAfterSeconds !== null) {
        await giveBack();
        sendRateLimited(res, retryAfterSeconds);
        return;
      }

      const letterDate = todayMadrid(clock);
      let sent: SendResult;
      try {
        const pdf = await renderLetter(
          await buildLetterData(db, userId, claim, profile, letterDate, debtor),
        );
        sent = await mailer.send({
          from: emailConfig.from,
          to,
          subject: `${sandbox ? '[PRUEBA] ' : ''}${subjectOf(claim)}`,
          text: textOf({
            claim,
            senderName: plain(profile.business_name ?? ''),
            debtorName: plain(debtor.name),
            letterDate,
            divertedFrom: sandbox ? debtorEmail : null,
          }),
          attachments: [
            {
              filename: letterFilename(claim),
              content: pdf,
              contentType: 'application/pdf',
            },
          ],
          idempotencyKey: sendKey,
        });
      } catch (error) {
        // Nothing was sent (or, for an unavailable provider, nobody knows): give the key back so
        // the client can retry with the same one.
        await giveBack(
          !(
            error instanceof MailerError &&
            error.code === 'PROVIDER_UNAVAILABLE'
          ),
        );
        if (error instanceof LetterDataError) {
          sendError(
            res,
            422,
            'LETTER_NOT_AVAILABLE',
            'The letter cannot be generated for this claim',
          );
          return;
        }
        if (error instanceof MailerError) {
          const reason = FAILURE_REASONS[error.code];
          // Only the request id, the error name and the reason (one of four fixed words): the
          // recipient, the text and the key never reach a log.
          console.error(
            JSON.stringify({
              level: 'error',
              request_id: getRequestId(res),
              error_name: error.name,
              reason,
            }),
          );
          sendError(
            res,
            502,
            'EMAIL_PROVIDER_ERROR',
            'The email could not be sent, try again later',
            { reason },
          );
          return;
        }
        throw error;
      }

      // The key stays claimed from here on: the email is out, so a failure below must not
      // let the client send it again. In the sandbox the debtor was NOT notified, so nothing is
      // recorded: the escalation guide must not move on because of a test message.
      let eventRecorded = false;
      if (!sandbox) {
        try {
          eventRecorded =
            (await addEvent(db, userId, claim.id, {
              kind: 'DEMAND_SENT',
              occurred_on: letterDate,
              note: 'Sent by email',
            })) !== null;
        } catch (error) {
          console.error(
            JSON.stringify({
              level: 'error',
              request_id: getRequestId(res),
              error_name: error instanceof Error ? error.name : 'NonError',
            }),
          );
        }
      }

      res.status(200).json({
        data: {
          sent: true,
          mode: sandbox ? 'sandbox' : 'live',
          // The test recipient is configuration, not the caller's business: in the sandbox it is
          // not echoed back. In live mode the caller already knows the debtor's address.
          delivered_to: sandbox ? 'sandbox' : debtorEmail,
          would_have_gone_to: sandbox ? debtorEmail : null,
          event_recorded: eventRecorded,
          provider_id: sent.id,
        },
      });
    },
  });
}
