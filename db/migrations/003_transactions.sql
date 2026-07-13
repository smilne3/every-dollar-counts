-- Phase 2: transactions. Plaid's PFC value is stored immutable (pfc_*);
-- the user's optional re-categorization lives in user_category.

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  account_id text not null,
  plaid_transaction_id text not null unique,
  amount numeric not null,
  date date not null,
  name text,
  merchant_name text,
  pfc_primary text,
  pfc_detailed text,
  pfc_confidence text,
  user_category text,                        -- nullable override
  removed boolean default false
);
