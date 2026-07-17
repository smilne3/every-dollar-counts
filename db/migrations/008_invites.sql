-- Invite allowlist: only these emails may join a household (enforced at login).
-- Replaces the old "pre-create the user" invite flow; works for Google SSO + magic link.
create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  household_id uuid not null references households(id) on delete cascade,
  created_at timestamptz default now()
);

alter table invites enable row level security;
drop policy if exists "manage your invites" on invites;
create policy "manage your invites" on invites
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

-- The first invite is created by scripts/seed-household.mjs, not here.
