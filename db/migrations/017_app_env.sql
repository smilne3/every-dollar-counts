-- The database's own identity.
--
-- One Supabase project serves local dev, Vercel Preview and production, so a laptop running
-- PLAID_ENV=sandbox can write sandbox banks into the database production reads from (#23). A
-- .env file can claim anything; this row is the DATABASE saying what it is, which is the one
-- claim a laptop cannot forge. lib/app-env.ts refuses to write household financial data when
-- the app's environment and this row disagree.
--
-- Chosen over denormalising plaid_env onto accounts + transactions and filtering every money
-- read: two functions create rows, ~14 places read them, and filtering fails toward real
-- transactions vanishing from the dashboard. See the design spec, 2026-09-01.
create table if not exists app_env (
  -- Single-row table: the check pins id to true, so a second row cannot be inserted.
  id boolean primary key default true check (id),
  plaid_env text not null check (plaid_env in ('sandbox','production')),
  updated_at timestamptz not null default now()
);

-- Seed from the most recently linked bank, so this configures itself correctly wherever it runs:
-- the production database says 'production', a fresh dev database with no banks says 'sandbox'.
-- Nothing is hardcoded, so re-running the migrations on a new project cannot mislabel it.
insert into app_env (id, plaid_env)
values (
  true,
  -- nulls last: plaid_items.created_at is nullable (002) and Postgres sorts NULLS FIRST on DESC,
  -- so a single null-timestamped row would outrank every real bank and decide what this whole
  -- database claims to be. id desc breaks exact-timestamp ties, so the seed is deterministic.
  coalesce(
    (select plaid_env from plaid_items order by created_at desc nulls last, id desc limit 1),
    'sandbox'
  )
)
on conflict (id) do nothing;

-- Server-only, like plaid_items (006): RLS on, no policy for authenticated, so the browser
-- cannot read it. All access is via the service_role client.
alter table app_env enable row level security;
