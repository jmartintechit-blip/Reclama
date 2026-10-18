-- An invoice belongs to at most one claim of its user. The check inside the statement that
-- creates a claim works on the snapshot taken when it starts, so two claims created at the same
-- instant for the same invoice could both pass it; this index makes the database refuse the
-- second one. (claim_invoices already has primary key (claim_id, invoice_id), which only stops
-- the same invoice from appearing twice in one claim.)
create unique index claim_invoices_one_claim_per_invoice
  on claim_invoices (user_id, invoice_id);

-- Expired sessions are deleted by "expires_at <= now" at login, over the whole table.
create index sessions_expires_at_idx on sessions (expires_at);
