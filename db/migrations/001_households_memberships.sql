-- Phase 1: households + memberships + the RLS helper every later policy uses.

create schema if not exists private;

create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text,
  created_at timestamptz default now()
);

create table if not exists memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  primary key (user_id, household_id)
);

-- SECURITY DEFINER: runs as owner, bypasses memberships RLS -> no policy recursion.
create or replace function private.household_ids()
returns setof uuid
language sql
security definer
set search_path = ''
stable
as $$
  select household_id from public.memberships where user_id = auth.uid();
$$;

grant execute on function private.household_ids() to authenticated;
