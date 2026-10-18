-- The events of a claim are shown oldest first, but several can happen on the same day (a
-- reminder and a demand, a demand and the payment) and `occurred_on` is a date, so it cannot
-- order them. This column is the tie-breaker: the real moment the row was written. Existing
-- rows (if any) get the moment of this migration, which only matters for ties.
alter table claim_events add column created_at timestamptz not null default clock_timestamp();
