-- Postgres indexes the referenced side of a foreign key but not the referencing side. These are
-- the columns the app filters or deletes by, and that were left without an index:
-- - payments: summed per invoice in every invoice list and inside the overpayment trigger, and
--   scanned when an invoice is deleted;
-- - claim_events: read per claim, and scanned when a claim is deleted;
-- - sessions: scanned when a user is deleted (account erasure and the demo purge);
-- - rate_limits: old windows are deleted by window_start each time a new counter appears.
create index payments_invoice_idx on payments (user_id, invoice_id);
create index claim_events_claim_idx on claim_events (user_id, claim_id);
create index sessions_user_idx on sessions (user_id);
create index rate_limits_window_start_idx on rate_limits (window_start);
