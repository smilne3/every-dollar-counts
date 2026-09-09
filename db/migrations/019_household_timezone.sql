-- The household's own clock (#73).
--
-- Every date in the app came from `new Date()` on the server, which is UTC on Vercel while this
-- household is in US Eastern. The dashboard said "Good morning / Thursday, September 3" at 8:10pm
-- on Wednesday 2 September, and — the half that actually matters — for four hours at the end of
-- every month the money tiles reported the wrong month: "Spent in September" showing a fresh ~$0
-- month while August was still running.
--
-- Defaulted rather than backfilled: the default is correct for the only household that exists, and
-- every existing row keeps working with no data migration.
--
-- No check constraint on the value. Postgres cannot validate an IANA name without consulting
-- pg_timezone_names, which a column check cannot reliably do; validation lives at the write
-- boundary in app/api/household/timezone/route.ts, where Intl can answer authoritatively.
alter table households
  add column if not exists timezone text not null default 'America/New_York';

-- households had exactly ONE policy before this — "read your households", for select (006). With
-- no update policy, an UPDATE through the RLS-scoped client matches zero rows and returns NO
-- ERROR: Supabase reports success. Saving a timezone that way would appear to work, refresh, and
-- show the old value forever, with nothing in the logs. That is #46's silent-read failure wearing
-- a write's clothes.
--
-- This also makes households.name writable, which is harmless: there is no name editor today, and
-- if one is ever added this is the policy it would need.
drop policy if exists "update your household" on households;
create policy "update your household" on households
  for update to authenticated
  using ( id in (select private.household_ids()) )
  with check ( id in (select private.household_ids()) );
