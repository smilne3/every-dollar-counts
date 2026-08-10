-- Phase 8: bound the frozen write-off ledger the same way splits are bounded.
--
-- A reimbursement_write_offs row IS spending: all five money surfaces read it unfiltered, via
-- writeOffsAsTxns, in whatever category and on whatever date the row says. 012 gave
-- reimbursement_splits `check (amount > 0)` but left this table's amount unbounded.
--
-- That matters because the publishable Supabase key ships in the browser, so RLS is the only real
-- boundary here — the API route's rules are advisory and apply only to callers who go through the
-- route. Within their own household a user (or anything holding their session) can PostgREST
-- straight at this table, and today a row of ANY sign is accepted: a negative amount is synthetic
-- income that no bank statement backs, and a zero amount renders as a junk "Write-off · $0.00" line
-- in the transactions drill-down. Neither can be undone, because a written-off claim is frozen.
--
-- Same constraint as splits, for the same reason: money that moves is money greater than zero.
--
-- Postgres has no `add constraint if not exists`, so the add is wrapped and the duplicate swallowed,
-- keeping this file re-runnable like every other migration here.
do $$
begin
  alter table reimbursement_write_offs
    add constraint reimbursement_write_offs_amount_positive check (amount > 0);
exception
  when duplicate_object then null;
end $$;
