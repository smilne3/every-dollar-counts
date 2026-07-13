-- Phase 3: monthly budget limit per category (calendar-month period).
create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  category text not null,          -- effective-category value (PFC primary or override)
  monthly_limit numeric not null,
  unique (household_id, category)
);
