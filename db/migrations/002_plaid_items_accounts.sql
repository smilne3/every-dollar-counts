-- Phase 2: linked banks (Plaid items) + their accounts.

create table if not exists plaid_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  item_id text not null unique,
  access_token_encrypted text not null,      -- encrypted at rest; never sent to browser
  cursor text,                               -- transactions/sync next_cursor
  institution_name text,
  created_at timestamptz default now()
);

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  plaid_item_id uuid not null references plaid_items(id) on delete cascade,
  account_id text not null unique,
  name text,
  type text,
  subtype text,
  current_balance numeric,
  available_balance numeric,
  iso_currency_code text
);
