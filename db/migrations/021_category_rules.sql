-- Category rules (#28): one rule per merchant per household, learned from a hand pick or seeded
-- once from the household's existing picks. A rule's effect exists only at READ time
-- (lib/category-rules.ts resolveCategory): nothing on transactions is written, so changing or
-- removing a rule moves every row with it and a rollback is a code revert.
--
-- Hand-run in the SQL editor and safe to re-run. It creates NO rows: seeding is
-- db/seeds/021_category_rules_seed.sql, run once on production immediately before the PR 2 deploy.
--
-- Never drop category_rules while any deployment built from PR 2 or later is live (its pages throw
-- without it). Emptying it is allowed only through the seed file's pre-deploy reset. Production
-- and Preview both count: one database serves local, Preview and production (017_app_env.sql), and
-- five money pages and Settings read this table on every load.

-- 1) FK target: (household_id, id) on categories. id is already the primary key (007), so this
--    cannot fail.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'categories_household_id_id_key') then
    alter table public.categories
      add constraint categories_household_id_id_key unique (household_id, id);
  end if;
end $$;

-- 2) Table and its security in ONE statement, so the table never exists without RLS.
--    The category is referenced by id, not by name (unlike 007's convention): renames need no
--    cascade, deleting a category deletes its rules in the same statement, a re-added category
--    can't inherit a rule, and the composite FK stops a rule pointing into another household
--    (Postgres runs FK checks outside RLS). No FK to transactions, accounts or plaid_items:
--    rules must survive a bank being disconnected and relinked.
do $$ begin
  if to_regclass('public.category_rules') is null then
    create table public.category_rules (
      id uuid primary key default gen_random_uuid(),
      household_id uuid not null references public.households(id) on delete cascade,
      merchant_key text not null check (merchant_key <> ''),   -- merchantKey(merchant_name): whitespace-trimmed, lowercased
      merchant_label text not null,                            -- display spelling
      category_id uuid not null,
      origin text not null check (origin in ('seeded', 'learned')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint category_rules_one_per_merchant unique (household_id, merchant_key),
      constraint category_rules_category_fk foreign key (household_id, category_id)
        references public.categories (household_id, id) on delete cascade
    );
    alter table public.category_rules enable row level security;
    create policy "manage your category rules" on public.category_rules
      for all to authenticated
      using ( household_id in (select private.household_ids()) )
      with check ( household_id in (select private.household_ids()) );
  end if;
end $$;

-- 3) Idempotent re-asserts for a re-run (the 007 pattern).
alter table public.category_rules enable row level security;
drop policy if exists "manage your category rules" on public.category_rules;
create policy "manage your category rules" on public.category_rules
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

-- 4) Explicit grants. No anon grant. Supabase is ending its default of granting new public tables
--    to the API roles; without these the app gets 42501 permission denied although RLS and the
--    policy look correct, while the seed (run as postgres) still succeeds.
grant select, insert, update, delete on table public.category_rules to authenticated;
grant select, insert, update, delete on table public.category_rules to service_role;

-- Check after running (each must be true):
--   select has_table_privilege('authenticated', 'public.category_rules', 'SELECT'),
--          has_table_privilege('authenticated', 'public.category_rules', 'INSERT'),
--          has_table_privilege('authenticated', 'public.category_rules', 'UPDATE'),
--          has_table_privilege('authenticated', 'public.category_rules', 'DELETE');
--
-- Rollback, only once no deployment built from PR 2 is live: drop category_rules first, then the
-- categories_household_id_id_key constraint its FK depends on.
