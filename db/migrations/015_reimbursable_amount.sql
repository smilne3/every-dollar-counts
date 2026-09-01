-- Phase 9: reimbursable becomes an AMOUNT on the transaction (spec 2026-08-31).
--
-- Replaces claims/splits/write-offs entirely. A transaction carries how much of itself is coming
-- back; direction is read from the transaction's own sign, so this is always a positive magnitude.

-- The spec assumes a fresh start: the previous feature shipped but was never used. That assumption
-- is cheap to hold and expensive to get wrong, so verify it rather than trust it. If this fires,
-- there is real money data here and the conversion in the spec's earlier draft is the starting point.
--
-- Migration 016 drops these same three tables, so re-running this file after 016 must not blow up
-- with "relation does not exist" — a guard that cannot be re-run is not the idempotent style the
-- rest of this file uses. Each check is therefore gated on `to_regclass(...) is not null` AND run
-- through EXECUTE: a plain `to_regclass(...) is not null and exists (select 1 from t ...)` would
-- still fail, because Postgres resolves every table named in a query during parse/analyze, before
-- any AND short-circuits at runtime — only dynamic SQL (EXECUTE) defers that resolution until the
-- branch actually runs. When the tables DO exist, the refusal is unchanged.
do $$
declare
  has_data boolean;
begin
  if to_regclass('public.reimbursement_splits') is not null then
    execute 'select exists (select 1 from reimbursement_splits limit 1)' into has_data;
    if has_data then
      raise exception
        'reimbursement data exists — this migration assumes a fresh start, see spec section 4.1';
    end if;
  end if;

  if to_regclass('public.reimbursement_write_offs') is not null then
    execute 'select exists (select 1 from reimbursement_write_offs limit 1)' into has_data;
    if has_data then
      raise exception
        'reimbursement data exists — this migration assumes a fresh start, see spec section 4.1';
    end if;
  end if;

  if to_regclass('public.reimbursement_claims') is not null then
    execute 'select exists (select 1 from reimbursement_claims limit 1)' into has_data;
    if has_data then
      raise exception
        'reimbursement data exists — this migration assumes a fresh start, see spec section 4.1';
    end if;
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
