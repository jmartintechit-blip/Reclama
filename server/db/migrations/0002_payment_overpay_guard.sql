-- Keeps the payments of an invoice from adding up to more than its amount, even when two
-- requests race. Application code cannot do it: a statement works on the snapshot taken when
-- it starts, so two payments running at the same instant both see the same balance and both
-- pass a "balance >= amount" check.
--
-- The trigger first locks the invoice row (the second payment waits here until the first one
-- commits) and only THEN reads the payments in a NEW statement. Inside a plpgsql function every
-- statement takes a fresh snapshot under READ COMMITTED, so that read already sees the payment
-- that was committed while this one was waiting.
--
-- The errors are check violations with a fixed constraint name, which the repositories map to
-- their own business errors.

create function payments_check_total() returns trigger
language plpgsql as $$
declare
  invoice_amount bigint;
  already_paid   bigint;
begin
  select amount_cents into invoice_amount
    from invoices
   where user_id = new.user_id and id = new.invoice_id
     for update;
  -- No such invoice: the foreign key of payments reports it.
  if not found then
    return new;
  end if;

  select coalesce(sum(amount_cents), 0) into already_paid
    from payments
   where user_id = new.user_id and invoice_id = new.invoice_id;

  if already_paid + new.amount_cents > invoice_amount then
    raise exception 'The payments would exceed the invoice amount'
      using errcode = 'check_violation', constraint = 'payments_total_within_invoice';
  end if;
  return new;
end;
$$;

create trigger payments_check_total
  before insert on payments
  for each row execute function payments_check_total();

-- The other half of the same rule: lowering the amount of an invoice below what has already
-- been paid. Same lock, then a fresh read of the payments, so a payment being recorded at the
-- same moment is either seen here or waits for this update.
create function invoices_check_amount() returns trigger
language plpgsql as $$
declare
  already_paid bigint;
begin
  perform 1 from invoices where id = new.id for update;

  select coalesce(sum(amount_cents), 0) into already_paid
    from payments
   where user_id = new.user_id and invoice_id = new.id;

  if new.amount_cents < already_paid then
    raise exception 'The invoice amount is below what has already been paid'
      using errcode = 'check_violation', constraint = 'invoices_amount_covers_payments';
  end if;
  return new;
end;
$$;

create trigger invoices_check_amount
  before update of amount_cents on invoices
  for each row execute function invoices_check_amount();
