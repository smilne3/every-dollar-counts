-- How many Plaid connections this household has spent, for good.
--
-- The Trial plan allows 10 Production Items over the LIFETIME of the account, and per Plaid's own
-- billing docs "removing Items created on a Trial plan (using /item/remove) will not allow you to
-- create more Items". So a disconnect-and-relink burns two of the ten, permanently.
--
-- The app could not tell you where you stood, and structurally never could: disconnecting deletes
-- the plaid_items row (and cascades to its accounts and transactions), so the fact that a slot was
-- ever spent left no trace anywhere. components/BankList.tsx said so in a comment — it deliberately
-- refused to print "N of 10 used" because the number it had would DROP on a disconnect, which is
-- the opposite of the truth. This table is the record that survives the delete (#51).
create table if not exists plaid_slot_ledger (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  -- Plaid's own item_id. Unique so a retried link cannot count the same Item twice. NULLABLE, and
  -- null for a baseline row: links made before this ledger existed can only be learned from the
  -- Plaid dashboard, and Postgres permits many NULLs in a unique column.
  --
  -- NOT a foreign key to plaid_items ON PURPOSE. A reference would cascade away on disconnect,
  -- which is the exact moment this row has to survive.
  item_id text unique,
  institution_name text,
  -- Only production Items consume the ten. Sandbox links are free and unlimited, so the count
  -- filters on this rather than counting every row.
  plaid_env text not null check (plaid_env in ('sandbox','production')),
  note text,
  created_at timestamptz not null default now()
);

-- Seed from the banks linked right now, so the count starts from something true rather than zero.
-- This CANNOT see links that were already disconnected — that history is gone. The number this
-- produces is therefore a floor: at least this many are spent.
insert into plaid_slot_ledger (household_id, item_id, institution_name, plaid_env, note)
select household_id, item_id, institution_name, plaid_env, 'backfilled from live plaid_items'
from plaid_items
on conflict (item_id) do nothing;

-- Server-only, like plaid_items (006): RLS on, no policy for authenticated. Read via service_role.
alter table plaid_slot_ledger enable row level security;
