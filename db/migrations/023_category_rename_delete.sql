-- Rename and delete a category, each in one transaction (#100).
--
-- Transactions and budgets point at a category by its NAME (007). So a rename has to move the
-- category's picks and budget onto the new name, and a delete has to clear its picks and drop its
-- budget. app/api/categories/route.ts did each as a read and then three writes: a rename checked
-- only its first write, and a delete checked none. So a failure partway could leave picks under a
-- name no category has, counted as spending whatever kind the category had been. Or it could clear
-- a category's picks and budget while the category stayed. Here the three writes commit together,
-- or none of them do.
--
-- SECURITY INVOKER: each function runs as the signed-in person, so RLS limits every statement to
-- their own household, as it did when the route made the three writes itself. Each raises
-- no_data_found (P0002) when it can see no category with that id (already deleted, or another
-- household's), which the route answers 404. Otherwise each returns nothing, so any reply without
-- an error means the change was made.
--
-- Hand-run in the SQL editor and safe to re-run. Changes no rows. Apply it before deploying the
-- code that calls these functions (the route's PATCH and DELETE), which can't rename or delete
-- anything without them. One database serves local, Preview and production (017_app_env.sql).
-- db/seeds/023_category_rename_delete_checks.sql lists picks and budgets left under a name no
-- category has, by an earlier failure or by #254.

create or replace function public.rename_category(category_id uuid, new_name text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  household uuid;
  old_name text;
begin
  -- FOR UPDATE: a second rename or a delete of this category waits for this one to commit, then
  -- reads the name it left.
  select c.household_id, c.name into household, old_name
  from public.categories c
  where c.id = rename_category.category_id
  for update;
  if not found then
    raise exception 'no category % to rename', rename_category.category_id using errcode = 'no_data_found';
  end if;
  if old_name = new_name then
    return;
  end if;

  -- Fails with 23505 when another category has new_name (unique (household_id, name), 007), which
  -- undoes the whole call.
  update public.categories set name = new_name where id = rename_category.category_id;

  -- Move this category's picks onto new_name. Picks already under new_name, left by an earlier
  -- failure, need no write: from here on they match this category by name.
  update public.transactions set user_category = new_name
  where household_id = household and user_category = old_name;

  -- A budget already under new_name belongs to no category, as the category's rename above has
  -- just shown by raising no 23505. It too was left by an earlier failure. This category's own
  -- budget replaces it. With none of its own, the category keeps that one.
  if exists (select 1 from public.budgets b where b.household_id = household and b.category = old_name) then
    delete from public.budgets where household_id = household and category = new_name;
    update public.budgets set category = new_name where household_id = household and category = old_name;
  end if;
end;
$$;

create or replace function public.delete_category(category_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  household uuid;
  old_name text;
begin
  select c.household_id, c.name into household, old_name
  from public.categories c
  where c.id = delete_category.category_id
  for update;
  if not found then
    raise exception 'no category % to delete', delete_category.category_id using errcode = 'no_data_found';
  end if;

  -- Its merchant rules and Jev's suggestions of it go with it, through their FKs (021, 022). An RLS
  -- policy that let this row be locked but not deleted would make the delete match nothing, and the
  -- picks and budget below would go while the category stayed. So that stops the whole call.
  delete from public.categories where id = delete_category.category_id;
  if not found then
    raise exception 'category % could not be deleted', delete_category.category_id using errcode = 'insufficient_privilege';
  end if;

  -- Its picks go back to automatic, and its budget is dropped.
  update public.transactions set user_category = null
  where household_id = household and user_category = old_name;
  delete from public.budgets where household_id = household and category = old_name;
end;
$$;

-- Only a signed-in person calls these, through the route. Postgres lets everyone (PUBLIC) run a new
-- function, and Supabase grants anon as well, so both lose it.
revoke execute on function public.rename_category(uuid, text) from public, anon;
revoke execute on function public.delete_category(uuid) from public, anon;
grant execute on function public.rename_category(uuid, text) to authenticated;
grant execute on function public.delete_category(uuid) to authenticated;

-- The API sees a new function once PostgREST reloads its schema cache. Supabase reloads it after a
-- change like this one by itself; this asks once more.
notify pgrst, 'reload schema';

-- Check after running. Expect two rows, delete_category then rename_category, each void, f, t, f:
--   select p.proname, p.prorettype::regtype, p.prosecdef,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE'),
--          has_function_privilege('anon', p.oid, 'EXECUTE')
--   from pg_proc p
--   where p.pronamespace = 'public'::regnamespace and p.proname in ('delete_category', 'rename_category')
--   order by p.proname;
--
-- Rollback, only once no deployment that calls them is live:
--   drop function public.rename_category(uuid, text);
--   drop function public.delete_category(uuid);
