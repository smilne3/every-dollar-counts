-- Remove transactions belonging to balance-sheet accounts rather than cash-flow ones.
--
-- What prompted it: a mortgage escrow disbursement ("CITY TAX PMT", 2026-09-02, -3752.28) landed
-- on the loan account, and Plaid tagged it INCOME / INCOME_TAX_REFUND at LOW confidence -- the one
-- low-confidence call on that account, next to a VERY_HIGH one. lib/dashboard.ts books any inflow
-- in an INCOME category as income, so September reported $17,977.00 against real household income
-- of $14,224.72: overstated by 26% by a single row nobody earned. The servicer was forwarding
-- money already paid to it through the monthly mortgage payment.
--
-- lib/ingest.ts now refuses to store these at all (isCashFlowAccount). This statement clears what
-- the previous behaviour already wrote. It cannot be skipped and left to fix itself: Plaid never
-- re-sends a transaction its cursor has passed, so an existing row stays in the income total
-- forever unless deleted here.
--
-- BALANCES ARE UNTOUCHED. `accounts` keeps every loan and investment row, and netWorth() reads
-- current_balance and never transactions -- so the mortgage stays a live liability against the
-- home's manual asset value, and cash-flow correctness costs nothing on the net-worth side. That
-- separation is why storeAccounts fetches every item type; see the comment at
-- app/api/plaid/exchange-public-token/route.ts:128.
--
-- The types are spelled out here rather than referencing NON_CASHFLOW_ACCOUNT_TYPES in
-- lib/ingest.ts, because SQL cannot read it. The two have to be kept in step by hand;
-- tests/unit/ingest-non-cashflow.test.ts pins the set the application enforces.
--
-- Safe to re-run: a second execution matches nothing.
delete from transactions
where account_id in (
  select account_id from accounts where type in ('loan', 'investment')
);
