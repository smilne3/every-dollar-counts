// Account types whose transactions are balance-sheet, not household cash flow. A mortgage's
// BALANCE belongs in netWorth() and keeps being stored by storeAccounts (lib/ingest.ts); its
// TRANSACTIONS do not belong in income or spending. The monthly PAYMENT row mirrors money already counted as
// it left the funding account, and an escrow disbursement (CITY TAX PMT) is the servicer
// forwarding money paid to it months earlier -- which Plaid tags INCOME_TAX_REFUND at LOW
// confidence, so lib/dashboard.ts books it as income and overstates the month.
//
// A DENYLIST, not an allowlist, for the reason 017_app_env.sql spells out: filtering that fails
// toward real transactions vanishing is the worse failure, because an empty month is
// indistinguishable from a quiet one. An unrecognised type -- a type Plaid adds later, or an
// account whose row has not been stored yet -- keeps flowing and stays visible.
const NON_CASHFLOW_ACCOUNT_TYPES = new Set(['loan', 'investment'])

export function isCashFlowAccount(type: string | null | undefined): boolean {
  return !NON_CASHFLOW_ACCOUNT_TYPES.has(type ?? '')
}
