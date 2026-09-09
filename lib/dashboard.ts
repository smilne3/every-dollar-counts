import { effectiveCategory } from './effective-category'
import { isCreditCardPayment } from './categories'
import { monthKey } from './budget'
import { spendableAmount } from './reimbursements'
import type { SpendContext } from './spend-context'
import { MONTH_LABELS } from './format'

export type FlowTxn = {
  id: string
  amount: number
  date: string
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
}

export type Acct = { type: string | null; current_balance: number | null }

const ASSET_TYPES = new Set(['depository', 'investment', 'other'])
const LIABILITY_TYPES = new Set(['credit', 'loan'])

// Plaid reports credit/loan balances as POSITIVE amounts owed, so a mortgage looks
// identical to a savings account unless callers ask.
export function isLiability(type: string | null): boolean {
  return LIABILITY_TYPES.has(type ?? '')
}

// Manually-entered assets (e.g. the home) added to the asset side of net worth. The mortgage stays
// a live Plaid liability, so the home's net contribution is automatically (home value - mortgage).
export function sumManualAssets(assets: { value: number | null }[]): number {
  return assets.reduce((s, a) => s + (a.value ?? 0), 0)
}

// Net worth = assets - liabilities across all connected accounts, plus what you are owed back.
//
// `receivable` is REQUIRED rather than defaulted: every surface that shows net worth has to state
// what it counts as owed to you, so a page that forgets is a type error rather than a screen quietly
// disagreeing with the dashboard about the same household. Pass 0 to count only real balances.
// See fetchReceivable() in lib/receivable.ts for what belongs in it.
export function netWorth(accounts: Acct[], receivable: number): number {
  let assets = 0
  let liabilities = 0
  for (const a of accounts) {
    const bal = a.current_balance ?? 0
    if (ASSET_TYPES.has(a.type ?? '')) assets += bal
    else if (LIABILITY_TYPES.has(a.type ?? '')) liabilities += bal
  }
  return assets - liabilities + receivable
}

// Cash on hand = balances in spendable (depository) accounts.
export function cashOnHand(accounts: Acct[]): number {
  return accounts
    .filter((a) => a.type === 'depository')
    .reduce((s, a) => s + (a.current_balance ?? 0), 0)
}


// The last `n` months (chronological), each as { key: 'YYYY-MM', label: 'Jul' }.
//
// Takes the household's own calendar day (see lib/clock.ts). It used to take a Date and read its
// year and month straight off it, which projects the instant through the RUNTIME's zone — so on
// a UTC server it rolled to a new month four hours early for a US Eastern household, and the
// dashboard's "Spent in September" tile showed a fresh ~$0 month while August was still running
// (#73).
export function lastNMonths(today: string, n: number): { key: string; label: string }[] {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  if (!year || !month || month > 12) {
    throw new Error(`lastNMonths: expected 'YYYY-MM-DD', got '${today}'`)
  }
  const out: { key: string; label: string }[] = []
  for (let i = n - 1; i >= 0; i--) {
    // Constructed in UTC and read back in UTC, so the two cancel and no local zone is involved.
    const d = new Date(Date.UTC(year, month - 1 - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    out.push({ key, label: MONTH_LABELS[d.getUTCMonth()] })
  }
  return out
}

// Money out (spending) and money in (income) per month.
// Plaid convention: amount > 0 = money OUT, amount < 0 = money IN.
// - spending excludes `ctx.nonSpending` (income + transfers) so transfers/paychecks
//   never count as spending.
// - income excludes `ctx.transfers` (transfers only) so paychecks still count as
//   income but moving money between your own accounts does not.
// - a refund is an inflow (amount < 0) in a SPENDING category (e.g. a Travel refund). It nets
//   DOWN that category's spending rather than counting as income — otherwise every merchant
//   refund inflates income and leaves the original purchase counted at full price.
// - a reimbursable transaction (#27) is netted through `spendableAmount` BEFORE any of the above
//   branching, so a fully-reimbursed outflow nets to 0 and falls through both branches, and a
//   tagged repayment inflow nets to 0 rather than reading as income or as a refund.
export function monthlyFlows(
  txns: FlowTxn[],
  ctx: SpendContext,
  months: { key: string; label: string }[]
): { key: string; label: string; spending: number; income: number }[] {
  const acc: Record<string, { spending: number; income: number }> = {}
  for (const m of months) acc[m.key] = { spending: 0, income: 0 }
  for (const t of txns) {
    const mk = monthKey(t.date)
    const bucket = acc[mk]
    if (!bucket) continue
    // A credit-card payment is an internal transfer — skip both legs (out of checking, into card).
    if (isCreditCardPayment(t)) continue
    const cat = effectiveCategory(t, ctx.pfcMap)
    // Transfers are neither spending nor income.
    if (ctx.transfers.has(cat)) continue
    // Income categories are in nonSpending but not transfers (transfers are already gone).
    const isIncomeCategory = ctx.nonSpending.has(cat)
    const amt = spendableAmount(t, ctx.reimbursedByTxn)
    if (amt > 0) {
      // Money out: spending, unless it's an income category (rare; e.g. a clawback).
      if (!isIncomeCategory) bucket.spending += amt
    } else if (amt < 0) {
      // Money in: real income for an income category; otherwise a refund that nets down spending
      // (amt is negative, so += reduces the category's spending).
      if (isIncomeCategory) bucket.income += -amt
      else bucket.spending += amt
    }
  }
  return months.map((m) => ({ ...m, ...acc[m.key] }))
}
