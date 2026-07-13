-- RLS policies. This file grows as later phases add tables. Phase 1: households + memberships.

alter table households  enable row level security;
alter table memberships enable row level security;

-- memberships: reference auth.uid() DIRECTLY (never self-select) to avoid recursion.
drop policy if exists "see your own membership rows" on memberships;
create policy "see your own membership rows" on memberships
  for select to authenticated
  using ( (select auth.uid()) = user_id );

drop policy if exists "read your households" on households;
create policy "read your households" on households
  for select to authenticated
  using ( id in (select private.household_ids()) );
