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

-- Seed from the linked banks, so this configures itself correctly wherever it runs: a database
-- holding real banks says 'production', a fresh dev database with no banks says 'sandbox'.
-- Nothing is hardcoded, so re-running the migrations on a new project cannot mislabel it.
insert into app_env (id, plaid_env)
values (
  true,
  -- ANY PRODUCTION BANK WINS, rather than simply the most recent link. The scenario this table
  -- exists to close is a sandbox bank landing in the production database (#23) -- and in exactly
  -- that state the newest row is the sandbox one, so a most-recent-wins seed would let the
  -- contamination declare the production database to be 'sandbox' and lock the real app out of
  -- every guarded write. This ordering fails in the safe direction: it can only ever refuse
  -- sandbox writes, never real ones. Wrong is worse than stopped.
  -- nulls last: plaid_items.created_at is nullable (002) and Postgres sorts NULLS FIRST on DESC,
  -- so a single null-timestamped row would otherwise outrank every real bank. id desc breaks
  -- exact-timestamp ties, so the seed is deterministic.
  coalesce(
    (
      select plaid_env from plaid_items
      order by (plaid_env = 'production') desc, created_at desc nulls last, id desc
      limit 1
    ),
    'sandbox'
  )
)
on conflict (id) do nothing;

-- IF THIS ROW IS WRONG, EVERY GUARDED WRITE STOPS. The guard fails closed by design, so a
-- mis-seeded value is not a degraded mode: linking a bank and saving the home value both answer
-- 409, and Refresh writes nothing at all -- lib/ingest.ts throws per item, and the sync loop
-- catches that and marks every bank 'config_error' with status_detail 'ENV_MISMATCH', which does
-- name the real cause. (A missing or unreadable row is a plain Error rather than an
-- EnvMismatchError, so it still classifies as 'temporarily_unavailable' and does NOT name it.)
-- The remedy is one statement:
--
--   update app_env set plaid_env = 'production', updated_at = now();   -- or 'sandbox'
--
-- Then REDEPLOY. lib/app-env.ts memoises the value for the life of a process, so instances that
-- already read the wrong value keep using it until they are replaced. Fixing the row alone does
-- not bring a running deployment back.

-- Server-only, like plaid_items (006): RLS on, no policy for authenticated, so the browser
-- cannot read it. All access is via the service_role client.
alter table app_env enable row level security;
