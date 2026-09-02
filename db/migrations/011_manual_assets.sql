-- Phase 6: manually-entered assets that aren't bank accounts (the home, for now).
-- Counted on the asset side of net worth; the mortgage stays a live Plaid liability, so the home's
-- net contribution is automatically (home value - mortgage balance).
create table if not exists manual_assets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  value numeric not null default 0,
  -- Which environment LAST WROTE this row: app/api/manual-assets/route.ts stamps it on every
  -- save, and there is one 'Home' row per household (the unique constraint below), so it records
  -- the last writer rather than the creator. NOT filtered on when reading, and never will be:
  -- the write is guarded instead (#23, migration 017), so a wrong-environment row cannot be
  -- written at all.
  plaid_env text not null default 'sandbox',
  updated_at timestamptz not null default now(),
  created_at timestamptz default now(),
  unique (household_id, name)
);

alter table manual_assets enable row level security;
drop policy if exists "manage your manual assets" on manual_assets;
create policy "manage your manual assets" on manual_assets
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );
