-- Phase 8: pin the claims a household reimburses against constantly (work dinners), so a recurring
-- reimbursable is one tap on the transaction row instead of a five-field form.
--
-- Pinning lives on the CLAIM, not on a member: both partners tag each other's expenses, so whose
-- expense it is is a property of the transaction, not of whoever happens to be signed in. A per-user
-- default would silently file one partner's lunch under the other's employer.
alter table reimbursement_claims
  add column if not exists pinned boolean not null default false;

-- Partial index: reserved for a future SQL-side `.eq('pinned', true)` filter, which would only ever
-- want pinned claims and there will be very few. Not used by any current query — the fast path today
-- selects all open claims and filters `pinned` in JavaScript (app/(app)/transactions/page.tsx), which
-- carries no `pinned` predicate for a partial index to serve.
create index if not exists reimbursement_claims_pinned_idx
  on reimbursement_claims (household_id) where pinned;
