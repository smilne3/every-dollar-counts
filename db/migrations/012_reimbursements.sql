-- Phase 7: reimbursable transactions (#27).
-- A split says "this much of this transaction is owed back to me, under this claim, by this person".
-- The UNSPLIT remainder of a transaction is the user's own spending — there is deliberately no
-- "my portion" column, so it can never disagree with the splits.

create table if not exists reimbursement_claims (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  -- null = open, set = written off. There is deliberately no `status` column: "settled" is DERIVED
  -- from the totals (outstanding <= 0), so it cannot drift from the splits it summarises.
  written_off_on date,
  created_at timestamptz default now(),
  unique (household_id, name)
);

create table if not exists reimbursement_splits (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  claim_id uuid not null references reimbursement_claims(id) on delete cascade,
  owed_by text,                       -- nullable; the person axis. Free text.
  amount numeric not null check (amount > 0),
  created_at timestamptz default now()
);
create index if not exists reimbursement_splits_txn_idx on reimbursement_splits (transaction_id);
create index if not exists reimbursement_splits_claim_idx on reimbursement_splits (claim_id);

-- A write-off is FROZEN at the moment the user gives up on a claim: the unreturned amount, allocated
-- pro-rata across the categories it came from, dated the write-off day. Frozen rather than derived so
-- that later editing a split cannot rewrite a month that has already closed.
create table if not exists reimbursement_write_offs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  claim_id uuid not null references reimbursement_claims(id) on delete cascade,
  category text not null,             -- effective-category NAME, as budgets store it
  amount numeric not null,
  date date not null                  -- the write-off date, NOT the original expense date
);
create index if not exists reimbursement_write_offs_date_idx on reimbursement_write_offs (date);

alter table reimbursement_claims enable row level security;
drop policy if exists "manage your claims" on reimbursement_claims;
create policy "manage your claims" on reimbursement_claims
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

alter table reimbursement_splits enable row level security;
drop policy if exists "manage your splits" on reimbursement_splits;
create policy "manage your splits" on reimbursement_splits
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

alter table reimbursement_write_offs enable row level security;
drop policy if exists "manage your write-offs" on reimbursement_write_offs;
create policy "manage your write-offs" on reimbursement_write_offs
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );
