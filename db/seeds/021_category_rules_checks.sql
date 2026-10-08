-- Launch checks for category rules (#28 spec §10.2). Every query here is read-only.

-- 3a. ASCII: the seed's key matches lib/category-rules.ts merchantKey only on ASCII. Expect 0.
select count(distinct merchant_name) from public.transactions where merchant_name ~ '[^ -~]';

-- 3b. Defaults. Expect no rows. Then review any INCOME / TRANSFER_* primary in the second query
--     with the owner: those rows take no rule (spec §5.2).
select p from unnest(array['INCOME','TRANSFER_IN','TRANSFER_OUT']) p
where not exists (select 1 from public.categories c where c.pfc_primary = p);

select t.pfc_primary, count(*) from public.transactions t
where t.removed = false
  and not exists (select 1 from public.categories c
                  where c.household_id = t.household_id and c.pfc_primary = t.pfc_primary)
group by 1 order by 2 desc;

-- 3c. Budgets. If any exist, those bars and the dashboard footnote move at deploy, by design.
select category from public.budgets;

-- 3d. Card payments carrying a pick or a mark. Expect 0 rows.
select id, merchant_name, date, user_category, reimbursable_amount from public.transactions
where removed = false and pfc_detailed = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
  and (user_category is not null or reimbursable_amount is not null);

-- 3e. Seed diff, after running the seed. Both sides must return 0 rows.
--     `expected` is 021_category_rules_dry_run.sql's query, copied: keep the two in step.
with expected as (
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
  select household_id, merchant_key, mode() within group (order by merchant_label) as merchant_label,
         (array_agg(category_id))[1] as category_id, 'seeded' as origin
  from eligible
  group by household_id, merchant_key
  having count(distinct category_id) = 1                                                 -- picks agree
), actual as (
  select household_id, merchant_key, merchant_label, category_id, origin from public.category_rules
)
select 'expected but missing' as side, * from (select * from expected except select * from actual) a
union all
select 'present but not expected', * from (select * from actual except select * from expected) b;

-- 3f. Per-rule verification (spec §9). No environment filter, because pages have none.
with cats as (
  select household_id, id, name, pfc_primary, sort_order,
         case when pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT') then 'transfer'
              when pfc_primary = 'INCOME' then 'income' else 'spending' end as kind
  from public.categories
), txns as (
  select t.household_id,
         nullif(lower(regexp_replace(t.merchant_name, '^\s+|\s+$', '', 'g')), '') as merchant_key,
         coalesce(t.user_category, '') <> ''                                    as picked,
         coalesce(t.pfc_detailed = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', false)  as card_payment,
         coalesce(bank.name, 'Uncategorized')                                   as bank_name,
         coalesce(bank.kind,
                  case when t.pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT') then 'transfer'
                       when t.pfc_primary = 'INCOME' then 'income' else 'spending' end) as bank_kind,
         coalesce(bank.kind,
                  (select u.kind from cats u
                   where u.household_id = t.household_id and u.name = 'Uncategorized' limit 1),
                  'spending')                                                   as shown_kind
  from public.transactions t
  left join lateral (
    select b.name, b.kind from cats b
    where b.household_id = t.household_id and b.pfc_primary = t.pfc_primary
    order by b.sort_order desc limit 1
  ) bank on true
  where t.removed = false
)
select r.merchant_label, c.name as rule_category, x.bank_name,
       count(*) filter (where not x.picked and not x.card_payment
                          and c.kind = x.bank_kind and c.kind = x.shown_kind)                        as labelled,
       count(*) filter (where not x.picked and not x.card_payment
                          and c.kind = x.bank_kind and c.kind = x.shown_kind and c.name <> x.bank_name) as changed,
       count(*) filter (where x.picked)                                                               as picked_by_hand
from public.category_rules r
join cats c on c.id = r.category_id
left join txns x on x.household_id = r.household_id and x.merchant_key = r.merchant_key
group by 1, 2, 3
order by 1, 3;

-- 3g. Fingerprint of the rows the totals read (spec §10.2 step 3). Replace the date.
select count(*), md5(string_agg(id::text || ':' || amount || ':' || coalesce(user_category,'') || ':' ||
       coalesce(pfc_primary,'') || ':' || coalesce(pfc_detailed,'') || ':' || coalesce(merchant_name,'') || ':' ||
       coalesce(reimbursable_amount::text,''), ',' order by id))
from public.transactions where removed = false and date >= '<six-month window start>';
