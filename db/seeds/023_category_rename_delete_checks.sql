-- Checks for 023_category_rename_delete.sql (#100). Read-only: it changes nothing, and can be run
-- before or after 023, as often as you like. One query, so the SQL editor shows one table.
--
-- Expect "Success. No rows returned". Each row is something to look at:
-- - "name the app now refuses": a category the categories route no longer lets anyone add or
--   rename to (lib/category-names.ts says why). It breaks something until it's renamed: "None"
--   stops every Jev run, and a name such as "constructor" has its spending summed as text or lost.
--   Rename it in Settings → Categories. Only the new name is checked, so renaming away from it works.
-- - "picks under a name no category has": hand picks left by a rename or delete that failed
--   partway before 023, or by #254. They count as spending under that name. Renaming a category to
--   that name takes them over. To clear them instead, add a category of that name in Settings →
--   Categories, then delete it.
-- - "budget under a name no category has": left the same ways, and fixed the same ways. Budgets
--   doesn't show it, but the Dashboard's "budgeted" total still counts it.
--
-- Names are compared as the app compares them: picks and budgets exactly, refused names trimmed and
-- in any case. Rows the bank removed, and empty picks, count for nothing in the app, so they're
-- left out.

select 'name the app now refuses' as problem, c.name as what, null::bigint as transactions
from public.categories c
where lower(btrim(c.name)) in ('uncategorized', 'other', 'none')
   or c.name in ('constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty', '__lookupGetter__',
                 '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'valueOf',
                 '__proto__', 'toLocaleString')
union all
select 'picks under a name no category has', t.user_category, count(*)
from public.transactions t
where t.user_category <> ''
  and t.removed = false
  and not exists (select 1 from public.categories c
                  where c.household_id = t.household_id and c.name = t.user_category)
group by t.user_category
union all
select 'budget under a name no category has', b.category, null
from public.budgets b
where not exists (select 1 from public.categories c
                  where c.household_id = b.household_id and c.name = b.category);
