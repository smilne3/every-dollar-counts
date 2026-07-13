-- Custom categories: household-owned, editable (add/rename/remove).
-- Transactions/budgets keep referencing the category by NAME (text), so renames
-- cascade via string updates and auto-categorization maps Plaid PFC -> category name.

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  pfc_primary text,            -- Plaid primary this auto-maps from (null for custom)
  sort_order int not null default 0,
  unique (household_id, name)
);

alter table categories enable row level security;
drop policy if exists "manage your categories" on categories;
create policy "manage your categories" on categories
  for all to authenticated
  using ( household_id in (select private.household_ids()) )
  with check ( household_id in (select private.household_ids()) );

-- Single source of the 16 default categories (friendly names + their PFC primary).
create or replace function private.default_categories()
returns table(name text, pfc_primary text, sort_order int)
language sql immutable set search_path = '' as $$
  values
    ('Income'::text, 'INCOME'::text, 0),
    ('Transfer In', 'TRANSFER_IN', 1),
    ('Transfer Out', 'TRANSFER_OUT', 2),
    ('Loan Payments', 'LOAN_PAYMENTS', 3),
    ('Bank Fees', 'BANK_FEES', 4),
    ('Entertainment', 'ENTERTAINMENT', 5),
    ('Food & Drink', 'FOOD_AND_DRINK', 6),
    ('Shopping', 'GENERAL_MERCHANDISE', 7),
    ('Home', 'HOME_IMPROVEMENT', 8),
    ('Medical', 'MEDICAL', 9),
    ('Personal Care', 'PERSONAL_CARE', 10),
    ('Services', 'GENERAL_SERVICES', 11),
    ('Government & Nonprofit', 'GOVERNMENT_AND_NON_PROFIT', 12),
    ('Transportation', 'TRANSPORTATION', 13),
    ('Travel', 'TRAVEL', 14),
    ('Rent & Utilities', 'RENT_AND_UTILITIES', 15);
$$;

-- Auto-seed defaults whenever a household is created.
create or replace function private.seed_default_categories()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categories (household_id, name, pfc_primary, sort_order)
  select new.id, d.name, d.pfc_primary, d.sort_order from private.default_categories() d
  on conflict (household_id, name) do nothing;
  return new;
end; $$;

drop trigger if exists seed_categories_after_household on households;
create trigger seed_categories_after_household
  after insert on households
  for each row execute function private.seed_default_categories();

-- One-time seed for households that already exist.
insert into public.categories (household_id, name, pfc_primary, sort_order)
select h.id, d.name, d.pfc_primary, d.sort_order
from public.households h cross join private.default_categories() d
on conflict (household_id, name) do nothing;
