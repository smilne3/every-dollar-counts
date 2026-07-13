-- RLS policies. Source of truth across phases.

-- ---- Phase 1: households + memberships ----
alter table households  enable row level security;
alter table memberships enable row level security;

drop policy if exists "see your own membership rows" on memberships;
create policy "see your own membership rows" on memberships
  for select to authenticated
  using ( (select auth.uid()) = user_id );

drop policy if exists "read your households" on households;
create policy "read your households" on households
  for select to authenticated
  using ( id in (select private.household_ids()) );

-- ---- Phase 2: plaid_items, accounts, transactions ----
-- plaid_items holds the encrypted access token: RLS enabled with NO client policy,
-- so it is unreachable from the browser. All access is server-side via service_role.
alter table plaid_items  enable row level security;
alter table accounts     enable row level security;
alter table transactions enable row level security;

drop policy if exists "read your accounts" on accounts;
create policy "read your accounts" on accounts
  for select to authenticated
  using ( household_id in (select private.household_ids()) );

drop policy if exists "read your txns" on transactions;
create policy "read your txns" on transactions
  for select to authenticated
  using ( household_id in (select private.household_ids()) );

drop policy if exists "update your txns" on transactions;
create policy "update your txns" on transactions
  for update to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

-- ---- Phase 3: budgets ----
alter table budgets enable row level security;
drop policy if exists "manage your budgets" on budgets;
create policy "manage your budgets" on budgets
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );
