-- Phase 4: savings goals (household-scoped).
create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  target_amount numeric not null,
  saved_amount numeric not null default 0,
  created_at timestamptz default now()
);

alter table goals enable row level security;
drop policy if exists "manage your goals" on goals;
create policy "manage your goals" on goals
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );
