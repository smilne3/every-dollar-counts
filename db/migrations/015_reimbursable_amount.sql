-- Phase 9: reimbursable becomes an AMOUNT on the transaction (spec 2026-08-31).
--
-- Replaces claims/splits/write-offs entirely. A transaction carries how much of itself is coming
-- back; direction is read from the transaction's own sign, so this is always a positive magnitude.

-- The spec assumes a fresh start: the previous feature shipped but was never used. That assumption
-- is cheap to hold and expensive to get wrong, so verify it rather than trust it. If this fires,
-- there is real money data here and the conversion in the spec's earlier draft is the starting point.
do $$
begin
  if exists (select 1 from reimbursement_splits limit 1)
     or exists (select 1 from reimbursement_write_offs limit 1) then
    raise exception
      'reimbursement data exists — this migration assumes a fresh start, see spec section 4.1';
  end if;
end $$;

alter table transactions
  add column if not exists reimbursable_amount numeric,
  add column if not exists reimbursable_note text;

-- You cannot mark more as coming back than the transaction is worth. This lives in the DATABASE
-- rather than in application code on purpose: the equivalent rule today is a cross-row sum check in
-- lib/split-validation.ts, which is correct but bypassable by any future writer that forgets to call
-- it. As a CHECK it cannot be bypassed at all.
alter table transactions
  drop constraint if exists reimbursable_amount_within_transaction;
alter table transactions
  add constraint reimbursable_amount_within_transaction
  check (
    reimbursable_amount is null
    or (reimbursable_amount > 0 and reimbursable_amount <= abs(amount))
  );

-- Partial: only marked rows are ever scanned, and most rows are never marked.
create index if not exists transactions_reimbursable_idx
  on transactions (household_id) where reimbursable_amount is not null;
