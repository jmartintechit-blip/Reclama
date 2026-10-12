-- Initial schema (plan section 3). Money is bigint cents, rates are basis points (1040 = 10.40 %),
-- calendar dates are `date` (no time zone) and ids are uuid.
--
-- Why composite foreign keys: every user-owned table carries user_id, and a child row points to
-- its parent with (user_id, parent_id) instead of parent_id alone. Each parent therefore has
-- unique(user_id, id). This way the database itself refuses a row that points to another user's
-- data, even if a bug in the code forgets a `where user_id = ...`. Every table also has
-- user_id -> users ON DELETE CASCADE, so deleting a user leaves no rows behind (right to erasure).

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique check (email = lower(email)),
  password_hash text,
  is_demo       boolean not null default false,
  expires_at    timestamptz,
  -- Demo users have no password; real users do.
  check (is_demo = (password_hash is null)),
  -- Demo users have no email, but a real user must have one.
  check (is_demo or email is not null),
  -- Demo users expire (24 h) so they can be cleaned up; real users never do.
  check (is_demo = (expires_at is not null))
);

create table sessions (
  -- Only the SHA-256 of the token is stored, so a leaked table cannot be used to log in.
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  user_id    uuid not null references users (id) on delete cascade,
  expires_at timestamptz not null
);

create table profiles (
  user_id              uuid primary key references users (id) on delete cascade,
  -- Filled in later from the profile screen, so they start as null.
  business_name        text,
  tax_id               text,
  address              text,
  iban                 text,
  default_compensation text not null default 'PER_CLAIM'
    check (default_compensation in ('NONE', 'PER_INVOICE', 'PER_CLAIM'))
);

-- Reference data shared by all users (no user_id).
create table legal_interest_rates (
  semester_start date primary key
    check (extract(day from semester_start) = 1 and extract(month from semester_start) in (1, 7)),
  -- The last day of the six-month semester, e.g. 2026-07-01 -> 2026-12-31.
  semester_end   date not null,
  rate_bp        int  not null check (rate_bp >= 0),
  ecb_mro_bp     int  not null,
  spread_bp      int  not null default 800,
  boe_ref        text check (boe_ref ~ '^BOE-A-\d{4}-\d+$'),
  published_on   date,
  status         text not null default 'PENDING' check (status in ('VERIFIED', 'PENDING')),
  check (semester_end = (semester_start + interval '6 months' - interval '1 day')::date),
  check (rate_bp = ecb_mro_bp + spread_bp),
  -- A PENDING row may not have its BOE resolution yet; a VERIFIED one always does.
  check (status = 'PENDING' or (boe_ref is not null and published_on is not null))
);

create table debtors (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references users (id) on delete cascade,
  name      text not null,
  tax_id    text,
  email     text,
  kind      text not null default 'UNKNOWN'
    check (kind in ('BUSINESS', 'PUBLIC_ADMIN', 'CONSUMER', 'UNKNOWN')),
  -- Normalised key used to recognise the same debtor again (for example in a CSV import).
  match_key text not null,
  unique (user_id, id),
  unique (user_id, match_key)
);

create table invoices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  debtor_id     uuid not null,
  number        text not null,
  issue_date    date not null,
  -- null means "issue date + 30 days", an estimate.
  due_date      date,
  amount_cents  bigint not null check (amount_cents > 0),
  agreed_rate_bp int check (agreed_rate_bp >= 0),
  status        text not null default 'OPEN' check (status in ('OPEN', 'PAID', 'DISPUTED')),
  check (due_date is null or due_date >= issue_date),
  -- No ON DELETE action: a debtor with invoices cannot be deleted on its own.
  foreign key (user_id, debtor_id) references debtors (user_id, id),
  unique (user_id, id),
  unique (user_id, debtor_id, number)
);

create table payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  invoice_id   uuid not null,
  paid_on      date not null,
  amount_cents bigint not null check (amount_cents > 0),
  foreign key (user_id, invoice_id) references invoices (user_id, id) on delete cascade
);

create table claims (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  debtor_id          uuid not null,
  as_of              date not null,
  compensation_mode  text not null check (compensation_mode in ('NONE', 'PER_INVOICE', 'PER_CLAIM')),
  principal_cents    bigint not null check (principal_cents > 0),
  interest_cents     bigint not null check (interest_cents >= 0),
  compensation_cents bigint not null check (compensation_cents >= 0),
  total_cents        bigint not null,
  calc_version       text not null,
  check (total_cents = principal_cents + interest_cents + compensation_cents),
  check (compensation_mode <> 'NONE' or compensation_cents = 0),
  foreign key (user_id, debtor_id) references debtors (user_id, id),
  unique (user_id, id)
);

-- The frozen calculation of each invoice inside a claim: it never changes after the PDF is made.
create table claim_invoices (
  claim_id        uuid not null,
  invoice_id      uuid not null,
  user_id         uuid not null references users (id) on delete cascade,
  principal_cents bigint not null check (principal_cents > 0),
  interest_cents  bigint not null check (interest_cents >= 0),
  -- One entry per semester: dates, days, rate and amount.
  segments        jsonb not null check (jsonb_typeof(segments) = 'array'),
  primary key (claim_id, invoice_id),
  foreign key (user_id, claim_id) references claims (user_id, id) on delete cascade,
  -- No ON DELETE action: an invoice that is part of a claim cannot be deleted (API answers 409).
  foreign key (user_id, invoice_id) references invoices (user_id, id)
);

create table claim_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  claim_id    uuid not null,
  kind        text not null check (kind in (
    'REMINDER_SENT', 'DEMAND_SENT', 'BUROFAX_SENT', 'MONITORIO_FILED', 'PAID', 'NOTE')),
  occurred_on date not null,
  note        text,
  foreign key (user_id, claim_id) references claims (user_id, id) on delete cascade
);

-- One row per email sent. The Idempotency-Key sent to Resend is unique per user, and
-- created_at is what the daily email limits (3 per user, 20 global) are counted on.
create table email_log (
  user_id         uuid not null references users (id) on delete cascade,
  idempotency_key text not null check (idempotency_key <> ''),
  created_at      timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);

-- Fixed-window counters for the rate limits kept in the database. Not tied to a user: keys are
-- built from the IP address (and email) before anyone is logged in.
create table rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         int not null default 1 check (hits > 0),
  primary key (key, window_start)
);
