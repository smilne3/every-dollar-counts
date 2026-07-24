-- Phase 5: Plaid production — link status, product tracking, environment tagging,
-- and cascade cleanup.

-- Per-item link health and which products it was linked with.
-- status mirrors PlaidErrorCategory in lib/plaid-errors.ts — each value is a different sentence
-- on screen, and getting it wrong costs real money:
--   'ok'
--   'needs_reconnect'         re-auth required; Link update mode fixes it, spends NO Item slot
--   'action_at_bank'          user must unlock / reset password / finish setup AT the bank first;
--                             a Reconnect button here just fails again and invites a relink
--   'temporarily_unavailable' bank down or rate-limited; wait, nothing for the user to do
--   'config_error'            our misconfiguration (e.g. a sandbox token hitting production).
--                             Never render this as "the bank is having trouble."
-- status_detail always carries the raw Plaid error_code so the UI can be specific.
alter table plaid_items
  add column if not exists status text not null default 'ok',
  add column if not exists status_detail text,
  add column if not exists products text[] not null default '{transactions}';

-- Which Plaid environment created this item. Local dev, preview, and production all share
-- this one database, and a sandbox access token is worthless against the production API —
-- it fails with INVALID_ACCESS_TOKEN, which is NOT a reconnect error. Without this column,
-- one bank linked from a laptop after go-live is indistinguishable from a real one and
-- takes every real bank's sync down with it. The sync loop, the bank list, and the webhook
-- route all filter on it; the reset script deletes only sandbox rows.
-- KNOWN GAP: the dashboard/trends/budgets money reads query accounts and transactions
-- directly, and those tables have no plaid_env column, so a sandbox bank linked against this
-- shared DB after go-live would still show up in net worth. Closed operationally by the cutover
-- runbook's "never link from preview/dev against the live DB" rule; the durable code fix is to
-- denormalize plaid_env onto accounts + transactions and filter those reads too.
alter table plaid_items
  add column if not exists plaid_env text not null default 'sandbox';

-- Defensive: drop any transaction whose account no longer exists, so the FK below
-- can be added. None are expected today (no disconnect feature has existed), and this
-- makes the migration safe to apply regardless of whether the sandbox reset ran first.
delete from transactions
  where account_id not in (select account_id from accounts);

-- Deleting a bank (plaid_items) already cascades to its accounts (see 002). This carries
-- the cascade the rest of the way to transactions, so removing a bank can never leave
-- orphaned transactions silently counting toward spending.
alter table transactions
  drop constraint if exists transactions_account_id_fkey;
alter table transactions
  add constraint transactions_account_id_fkey
  foreign key (account_id) references accounts(account_id) on delete cascade;
