import { describe, it, expect } from 'vitest'
import { spendByCategory, type Txn } from '@/lib/budget'
import { monthlyFlows, type FlowTxn } from '@/lib/dashboard'
import { buildSpendContext } from '@/lib/spend-context'
import type { Category } from '@/lib/categories'
import { owedToYou } from '@/lib/reimbursements'

const categories: Category[] = [
  { id: '1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 },
  { id: '2', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 1 },
  { id: '3', name: 'Travel', pfc_primary: 'TRAVEL', sort_order: 2 },
  { id: '4', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 3 },
]

// One month, deliberately containing every interesting shape at once. `reimbursable_amount` replaces
// the old `reimbursement_splits` rows for 'b', 'c' and 'e' — same magnitudes (400, 300, 400), now
// living on the transaction itself rather than in a side table.
const txns: Txn[] = [
  // plain spending
  { id: 'a', amount: 120, date: '2026-07-02', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null },
  // partly reimbursable: $500 dinner, $400 back from work
  { id: 'b', amount: 500, date: '2026-07-04', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: 400 },
  // fully reimbursable outflow
  { id: 'c', amount: 300, date: '2026-07-06', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null, reimbursable_amount: 300 },
  // a genuine refund, NOT reimbursable — must still net down Travel
  { id: 'd', amount: -50, date: '2026-07-08', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null, reimbursable_amount: null },
  // a tagged repayment, deliberately in a SPENDING category: untagged it would net Travel down by
  // 400 like a refund, so this is what proves tagging makes it flow-neutral
  { id: 'e', amount: -400, date: '2026-07-10', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null, reimbursable_amount: 400 },
  // real income
  { id: 'f', amount: -2000, date: '2026-07-12', user_category: null, pfc_primary: 'INCOME', pfc_detailed: null, reimbursable_amount: null },
  // a credit-card payment, excluded from both sides
  { id: 'g', amount: 900, date: '2026-07-14', user_category: null, pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', reimbursable_amount: null },
]

describe('reimbursement reconciliation', () => {
  // The reimbursable map is built straight from the transactions' own `reimbursable_amount` column —
  // the same path the five money surfaces take, so this reconciliation exercises what they actually
  // run. Write-offs no longer flow through this context (see spend-context.ts); a written-off claim's
  // frozen spending is a display-only concern of the transactions page now, not a money-surface input.
  const ctx = buildSpendContext({ categories, txns })
  const all = txns

  // total spending == Σ outflows − Σ reimbursable amounts, with refunds still netting.
  it('spendByCategory totals reconcile with the inputs', () => {
    const total = Object.values(spendByCategory(all, ctx)).reduce((s, v) => s + v, 0)
    // outflows that count: 120 + 500 + 300 = 920 (the card payment is excluded)
    // reimbursable on those outflows: 400 + 300 = 700
    // the untagged refund still nets down: -50
    // the tagged repayment (e) contributes 0 — NOT -400
    expect(total).toBeCloseTo(920 - 700 - 50) // 170
  })

  it('monthlyFlows agrees with spendByCategory on spending for the month', () => {
    const flows = monthlyFlows(all as FlowTxn[], ctx, [{ key: '2026-07', label: 'Jul' }])
    const fromCategories = Object.values(spendByCategory(all, ctx)).reduce((s, v) => s + v, 0)
    expect(flows[0].spending).toBeCloseTo(fromCategories)
  })

  it('counts real income but not the tagged repayment', () => {
    const flows = monthlyFlows(all as FlowTxn[], ctx, [{ key: '2026-07', label: 'Jul' }])
    expect(flows[0].income).toBeCloseTo(2000)
  })

  // With no reimbursable amounts marked, every number must match the pre-#27 behaviour exactly: both
  // inflows in spending categories net down like refunds, which is the #8 behaviour we must preserve.
  it('is a no-op when nothing is reimbursable', () => {
    const plain = buildSpendContext({ categories, txns: [] })
    const total = Object.values(spendByCategory(txns, plain)).reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(920 - 50 - 400) // 470 — e now nets Travel down, as a refund would
    const flows = monthlyFlows(txns as FlowTxn[], plain, [{ key: '2026-07', label: 'Jul' }])
    expect(flows[0].spending).toBeCloseTo(470)
    expect(flows[0].income).toBeCloseTo(2000)
  })

  // THE central promise of this feature, asserted directly rather than left to two spending surfaces
  // agreeing with each other: every dollar that leaves spending because it was marked reimbursable
  // must reappear as a receivable, or net worth silently moves. spendByCategory and monthlyFlows can
  // each be internally correct and still leak money between them — that is exactly how #8 (untagged
  // repayments netting spending down like refunds) and #31 (credit-card payments treated as
  // reimbursable) reached production despite passing tests. A reviewer checking this once is not a
  // substitute for a standing invariant: unmarked spending minus marked spending must equal what
  // owedToYou says the household is owed.
  it('spending drop from marking equals owedToYou — the feature exists to keep net worth flat', () => {
    const plain = buildSpendContext({ categories, txns: [] })
    const marked = buildSpendContext({ categories, txns })

    const unmarkedTotal = Object.values(spendByCategory(txns, plain)).reduce((s, v) => s + v, 0)
    const markedTotal = Object.values(spendByCategory(txns, marked)).reduce((s, v) => s + v, 0)

    expect(unmarkedTotal).toBeCloseTo(470)
    expect(markedTotal).toBeCloseTo(170)
    expect(unmarkedTotal - markedTotal).toBeCloseTo(owedToYou(txns)) // 300
  })
})
