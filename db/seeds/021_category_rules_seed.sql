-- Seeds category_rules from the household's existing hand picks (#28 spec §9). A merchant gets a
-- rule when every eligible pick on it names the same category. A pick is eligible when its row is
-- from the live environment, not removed, not a card payment, and has a merchant_name; its category
-- still exists; it doesn't cross between spending, transfers and income (the same two-kind gate as
-- lib/category-rules.ts resolveCategory); and it isn't the row's bank category.
--
-- Run order, immediately before PR 2 deploys (spec §10.2 step 3): back up hand picks, run
-- 021_category_rules_checks.sql's pre-seed checks, run 021_category_rules_dry_run.sql, run this,
-- then the checks file's diff and verification queries.
--
-- Reset, ONLY before PR 2 deploys: delete from public.category_rules where origin = 'seeded';
-- then run this again. After PR 2 deploys there is no reset; changes go through Settings.
--
-- NOT PART OF SETUP. Run once on production, immediately before the category-rules deploy (PR 2).
-- Never run it again after PR 2 is live: Remove deletes rules, so a re-run brings back every rule
-- the household removed. Never drop, truncate or delete from category_rules: local, Preview and
-- production share this database.
do $$ begin
  if exists (select 1 from public.category_rules) then
    raise exception 'category_rules is not empty: this seed runs once, before PR 2 deploys (spec §9)';
  end if;

  insert into public.category_rules (household_id, merchant_key, merchant_label, category_id, origin)
  with cats as (
    select household_id, id, name, pfc_primary, sort_order,
           case when pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT') then 'transfer'
                when pfc_primary = 'INCOME' then 'income'
                else 'spending' end as kind
    from public.categories
  ), picks as (
    select t.household_id,
           nullif(lower(regexp_replace(t.merchant_name, '^\s+|\s+$', '', 'g')), '') as merchant_key,
           regexp_replace(t.merchant_name, '^\s+|\s+$', '', 'g')                  as merchant_label,
           p.id as category_id, p.name as pick_name, p.kind as pick_kind,
           bank.name as bank_name,
           -- Plaid's kind for the row (§5.2 bankCategory.kind)
           coalesce(bank.kind,
                    case when t.pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT') then 'transfer'
                         when t.pfc_primary = 'INCOME' then 'income'
                         else 'spending' end) as bank_kind,
           -- the kind of the name the totals count the row under (§5.2 kindOf(bankCategory.name))
           coalesce(bank.kind,
                    (select u.kind from cats u
                     where u.household_id = t.household_id and u.name = 'Uncategorized' limit 1),
                    'spending') as shown_kind
    from public.transactions t
    join cats p on p.household_id = t.household_id and p.name = t.user_category        -- stale names never seed
    join public.accounts a on a.account_id = t.account_id
    join public.plaid_items i on i.id = a.plaid_item_id
    left join lateral (
      select b.name, b.kind from cats b
      where b.household_id = t.household_id and b.pfc_primary = t.pfc_primary
      order by b.sort_order desc limit 1                                                 -- pfcToName is last-wins
    ) bank on true
    where t.removed = false
      and t.pfc_detailed is distinct from 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'           -- null-safe
      and i.plaid_env = (select plaid_env from public.app_env)                           -- owner environment only
  ), eligible as (
    select * from picks
    where merchant_key is not null
      and pick_kind = bank_kind                                                          -- the two-kind gate
      and pick_kind = shown_kind
      and pick_name <> coalesce(bank_name, 'Uncategorized')                              -- not a no-op
  )
  select household_id, merchant_key, mode() within group (order by merchant_label),
         (array_agg(category_id))[1], 'seeded'
  from eligible
  group by household_id, merchant_key
  having count(distinct category_id) = 1                                                 -- picks agree
  on conflict (household_id, merchant_key) do nothing;
end $$;
