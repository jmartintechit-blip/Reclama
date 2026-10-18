import type {
  ClaimResult,
  CompensationMode,
  DebtorKind,
} from '../domain/claim.ts';
import type { ISODate } from '../domain/dates.ts';
import type { InterestSegment } from '../domain/interest.ts';
import type { Cents } from '../domain/money.ts';
import type { Db } from './client.ts';
import {
  CLAIM_DEBTOR_FK,
  CLAIM_INVOICE_FK,
  DebtorNotFoundError,
  FOREIGN_KEY_VIOLATION,
  InvoiceInClaimError,
  InvoiceNotFoundError,
  violates,
} from './errors.ts';
import { normalizePage, type Page } from './query-helpers.ts';

// Every function takes `userId` first and puts `user_id` in its SQL: an id alone is never
// trusted. A claim of another user behaves exactly like one that does not exist.

// The most claims one user can have. It bounds what one account can store.
export const MAX_CLAIMS_PER_USER = 500;

export const EVENT_KINDS = [
  'REMINDER_SENT',
  'DEMAND_SENT',
  'BUROFAX_SENT',
  'MONITORIO_FILED',
  'PAID',
  'NOTE',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface Claim {
  id: string;
  debtor_id: string;
  debtor_name: string;
  as_of: ISODate;
  compensation_mode: CompensationMode;
  principal_cents: Cents;
  interest_cents: Cents;
  compensation_cents: Cents;
  total_cents: Cents;
  calc_version: string;
}

export interface ClaimSummary extends Claim {
  invoice_count: number;
  last_event: { kind: EventKind; occurred_on: ISODate } | null;
}

// One invoice of a claim as it was frozen: `segments` is the interest engine's own output.
export interface FrozenLine {
  invoice_id: string;
  number: string;
  principal_cents: Cents;
  interest_cents: Cents;
  segments: InterestSegment[];
}

export interface ClaimEvent {
  id: string;
  kind: EventKind;
  occurred_on: ISODate;
  note: string | null;
}

export interface ClaimDetail extends Claim {
  lines: FrozenLine[];
  events: ClaimEvent[]; // oldest first
}

export interface NewClaim {
  debtor_id: string;
  as_of: ISODate;
  result: ClaimResult; // what computeClaim returned: stored as it is
}

// Stores a claim and its frozen lines in ONE statement (Db has no transactions): either every
// row exists or none does, so a half-created claim can never be seen. The claim row is only
// inserted when none of the invoices is in a claim yet; the lines come from the same statement
// and point to the invoices through the composite foreign key, which also refuses an invoice
// that is missing or belongs to another user. Returns the id of the new claim.
//
// Throws InvoiceInClaimError when an invoice is already in a claim, DebtorNotFoundError when the
// debtor is missing or not the user's and InvoiceNotFoundError for a missing or foreign invoice.
// The "already in a claim" check works on the snapshot of the statement, so two claims created at
// the very same instant for the same invoice can both pass it (the write rate limit keeps that
// rare).
export async function createClaim(
  db: Db,
  userId: string,
  { debtor_id, as_of, result }: NewClaim,
): Promise<string> {
  const lines = result.lines.map((line) => ({
    invoice_id: line.id,
    principal_cents: line.principal,
    interest_cents: line.interest,
    segments: line.segments,
  }));
  try {
    const { rows } = await db.query(
      `with new_claim as (
         insert into claims (user_id, debtor_id, as_of, compensation_mode, principal_cents,
                             interest_cents, compensation_cents, total_cents, calc_version)
         select $1::uuid, $2::uuid, $3::date, $4::text, $5::bigint, $6::bigint, $7::bigint,
                $8::bigint, $9::text
          where not exists (
            select 1 from claim_invoices ci
             where ci.user_id = $1::uuid and ci.invoice_id = any($10::uuid[]))
         returning id
       ), new_lines as (
         insert into claim_invoices (claim_id, invoice_id, user_id, principal_cents,
                                     interest_cents, segments)
         select n.id, l.invoice_id, $1::uuid, l.principal_cents, l.interest_cents, l.segments
           from new_claim n,
                jsonb_to_recordset($11::jsonb) as l(invoice_id uuid, principal_cents bigint,
                                                    interest_cents bigint, segments jsonb)
         returning claim_id
       )
       select id from new_claim`,
      [
        userId,
        debtor_id,
        as_of,
        result.compensationMode,
        result.principal,
        result.interest,
        result.compensation,
        result.total,
        result.calcVersion,
        lines.map((line) => line.invoice_id),
        JSON.stringify(lines),
      ],
    );
    if (rows[0]) return (rows[0] as { id: string }).id;
  } catch (error) {
    if (violates(error, FOREIGN_KEY_VIOLATION, CLAIM_DEBTOR_FK)) {
      throw new DebtorNotFoundError();
    }
    if (violates(error, FOREIGN_KEY_VIOLATION, CLAIM_INVOICE_FK)) {
      throw new InvoiceNotFoundError();
    }
    throw error;
  }
  throw new InvoiceInClaimError();
}

const CLAIM_COLUMNS = `c.id, c.debtor_id, d.name as debtor_name, c.as_of, c.compensation_mode,
  c.principal_cents, c.interest_cents, c.compensation_cents, c.total_cents, c.calc_version`;
const CLAIM_FROM = `from claims c join debtors d on d.user_id = c.user_id and d.id = c.debtor_id`;

export async function countClaims(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query(
    'select count(*)::int as n from claims where user_id = $1',
    [userId],
  );
  return (rows[0] as { n: number }).n;
}

// Newest claim date first. The page size is always bounded (see normalizePage).
export async function listClaims(
  db: Db,
  userId: string,
  page?: Page,
): Promise<ClaimSummary[]> {
  const { limit, offset } = normalizePage(page);
  const { rows } = await db.query(
    `select ${CLAIM_COLUMNS},
            (select count(*) from claim_invoices ci
              where ci.user_id = c.user_id and ci.claim_id = c.id)::int as invoice_count,
            le.kind as last_event_kind, le.occurred_on as last_event_on
       ${CLAIM_FROM}
       left join lateral (
         select e.kind, e.occurred_on from claim_events e
          where e.user_id = c.user_id and e.claim_id = c.id
          order by e.occurred_on desc, e.created_at desc, e.id desc limit 1
       ) le on true
      where c.user_id = $1
      order by c.as_of desc, c.id limit $2 offset $3`,
    [userId, limit, offset],
  );
  return (
    rows as (Omit<ClaimSummary, 'last_event'> & {
      last_event_kind: EventKind | null;
      last_event_on: ISODate | null;
    })[]
  ).map(({ last_event_kind, last_event_on, ...claim }) => ({
    ...claim,
    last_event:
      last_event_kind === null || last_event_on === null
        ? null
        : { kind: last_event_kind, occurred_on: last_event_on },
  }));
}

// The claim without its lines and events (cheap): null when it is missing or not the user's.
export async function getClaimHeader(
  db: Db,
  userId: string,
  claimId: string,
): Promise<Claim | null> {
  const { rows } = await db.query(
    `select ${CLAIM_COLUMNS} ${CLAIM_FROM} where c.user_id = $1 and c.id = $2`,
    [userId, claimId],
  );
  return (rows[0] as Claim | undefined) ?? null;
}

// The claim with its frozen lines and its events, oldest event first (ties on the same day keep
// the order they were recorded in).
export async function getClaim(
  db: Db,
  userId: string,
  claimId: string,
): Promise<ClaimDetail | null> {
  const claim = await getClaimHeader(db, userId, claimId);
  if (claim === null) return null;
  const lines = await db.query(
    `select ci.invoice_id, i.number, ci.principal_cents, ci.interest_cents, ci.segments
       from claim_invoices ci
       join invoices i on i.user_id = ci.user_id and i.id = ci.invoice_id
      where ci.user_id = $1 and ci.claim_id = $2
      order by i.number, ci.invoice_id`,
    [userId, claimId],
  );
  const events = await db.query(
    `select id, kind, occurred_on, note from claim_events
      where user_id = $1 and claim_id = $2
      order by occurred_on, created_at, id`,
    [userId, claimId],
  );
  return {
    ...claim,
    lines: lines.rows as FrozenLine[],
    events: events.rows as ClaimEvent[],
  };
}

// What the next-action engine reads for each of `claimIds` (the user's own; others are left out):
// the kind of the debtor and the events, oldest first with ties in recording order, as in getClaim.
export async function listEscalationInputs(
  db: Db,
  userId: string,
  claimIds: readonly string[],
): Promise<
  Map<
    string,
    {
      debtor_kind: DebtorKind;
      events: { kind: EventKind; occurred_on: ISODate }[];
    }
  >
> {
  const { rows } = await db.query(
    `select c.id, d.kind as debtor_kind,
            coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'occurred_on', e.occurred_on)
                               order by e.occurred_on, e.created_at, e.id)
                     filter (where e.id is not null), '[]'::jsonb) as events
       ${CLAIM_FROM}
       left join claim_events e on e.user_id = c.user_id and e.claim_id = c.id
      where c.user_id = $1 and c.id = any($2::uuid[])
      group by c.id, d.kind`,
    [userId, claimIds],
  );
  return new Map(
    (
      rows as {
        id: string;
        debtor_kind: DebtorKind;
        events: { kind: EventKind; occurred_on: ISODate }[];
      }[]
    ).map(({ id, ...inputs }) => [id, inputs]),
  );
}

// Which of `invoiceIds` are already in a claim of the user.
export async function listClaimedInvoiceIds(
  db: Db,
  userId: string,
  invoiceIds: readonly string[],
): Promise<Set<string>> {
  const { rows } = await db.query(
    `select invoice_id from claim_invoices
      where user_id = $1 and invoice_id = any($2::uuid[])`,
    [userId, invoiceIds],
  );
  return new Set(
    (rows as { invoice_id: string }[]).map((row) => row.invoice_id),
  );
}

// Records an event of the claim and nothing else (the invoices are not touched). Returns null
// when the claim does not exist or is not the user's.
export async function addEvent(
  db: Db,
  userId: string,
  claimId: string,
  event: { kind: EventKind; occurred_on: ISODate; note?: string },
): Promise<ClaimEvent | null> {
  const { rows } = await db.query(
    `insert into claim_events (user_id, claim_id, kind, occurred_on, note)
     select c.user_id, c.id, $3::text, $4::date, $5::text from claims c where c.user_id = $1 and c.id = $2
     returning id, kind, occurred_on, note`,
    [userId, claimId, event.kind, event.occurred_on, event.note ?? null],
  );
  return (rows[0] as ClaimEvent | undefined) ?? null;
}
