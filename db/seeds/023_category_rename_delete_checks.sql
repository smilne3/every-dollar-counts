-- Checks for 023_category_rename_delete.sql (#100). Read-only: it changes nothing, and can be run
-- before or after 023, as often as you like. One query, so the SQL editor shows one table.
--
-- Expect "Success. No rows returned". Each row is something to look at:
-- - "name the app now refuses": a category the categories route would no longer let anyone add or
--   rename to (lib/category-names.ts). It still works, but collides with what the app means by that
--   name, so rename it in Settings → Categories.
-- - "picks under a name no category has": hand picks stranded by a rename or delete that failed
--   partway, before 023. They count as spending under that name, and no rename reaches them.
-- - "budget under a name no category has": stranded the same way. Budgets doesn't show it, but the
--   Dashboard's "budgeted" total still counts it.

select 'name the app now refuses' as problem, c.name as what, null::bigint as transactions
from public.categories c
where lower(c.name) in ('uncategorized', 'other', 'none')
   or c.name in ('constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty', '__lookupGetter__',
                 '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'valueOf',
                 '__proto__', 'toLocaleString')
union all
select 'picks under a name no category has', t.user_category, count(*)
from public.transactions t
where t.user_category is not null
  and coalesce(t.removed, false) = false
  and not exists (select 1 from public.categories c
                  where c.household_id = t.household_id and c.name = t.user_category)
group by t.user_category
union all
select 'budget under a name no category has', b.category, null
from public.budgets b
where not exists (select 1 from public.categories c
                  where c.household_id = b.household_id and c.name = b.category);
