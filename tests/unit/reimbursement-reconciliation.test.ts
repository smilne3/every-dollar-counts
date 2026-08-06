import { describe, it, expect } from 'vitest'
import { spendByCategory, type Txn } from '@/lib/budget'
import { monthlyFlows, type FlowTxn } from '@/lib/dashboard'
import { buildSpendContext } from '@/lib/spend-context'
import { writeOffsAsTxns, type Split, type WriteOff } from '@/lib/reimbursements'
import type { Category } from '@/lib/categories'

const categories: Category[] = [
  { id: '1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 },
  { id: '2', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 1 },
  { id: '3', name: 'Travel', pfc_primary: 'TRAVEL', sort_order: 2 },
  { id: '4', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 3 },
]

// One month, deliberately containing every interesting shape at once.
const txns: Txn[] = [
  // plain spending
  { id: 'a', amount: 120, date: '2026-07-02', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
  // partly reimbursable: $500 dinner, $400 back from work
  { id: 'b', amount: 500, date: '2026-07-04', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
  // fully reimbursable outflow
  { id: 'c', amount: 300, date: '2026-07-06', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null },
  // a genuine refund, NOT reimbursable — must still net down Travel
  { id: 'd', amount: -50, date: '2026-07-08', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null },
  // a tagged repayment, deliberately in a SPENDING category: untagged it would net Travel down by
  // 400 like a refund, so this is what proves tagging makes it flow-neutral
  { id: 'e', amount: -400, date: '2026-07-10', user_category: null, pfc_primary: 'TRAVEL', pfc_detailed: null },
  // real income
  { id: 'f', amount: -2000, date: '2026-07-12', user_category: null, pfc_primary: 'INCOME', pfc_detailed: null },
  // a credit-card payment, excluded from both sides
  { id: 'g', amount: 900, date: '2026-07-14', user_category: null, pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
]

const splits: Split[] = [
  { transaction_id: 'b', claim_id: 'c1', owed_by: 'Employer', amount: 400 },
  { transaction_id: 'c', claim_id: 'c1', owed_by: 'Employer', amount: 300 },
  { transaction_id: 'e', claim_id: 'c1', owed_by: 'Employer', amount: 400 },
]

const writeOffs: WriteOff[] = [
  { claim_id: 'c2', category: 'Travel', amount: 75, date: '2026-07-20' },
]

describe('reimbursement reconciliation', () => {
  const ctx = buildSpendContext({ categories, splits })
  const all = [...txns, ...writeOffsAsTxns(writeOffs)]

  // total spending == Σ outflows − Σ reimbursable splits + Σ write-offs, with refunds still netting.
  it('spendByCategory totals reconcile with the inputs', () => {
    const total = Object.values(spendByCategory(all, ctx)).reduce((s, v) => s + v, 0)
    // outflows that count: 120 + 500 + 300 = 920 (the card payment is excluded)
    // reimbursable on those outflows: 400 + 300 = 700
    // the untagged refund still nets down: -50
    // the tagged repayment (e) contributes 0 — NOT -400
    // the write-off adds: +75
    expect(total).toBeCloseTo(920 - 700 - 50 + 75) // 245
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

  // With no splits and no write-offs, every number must match the pre-#27 behaviour exactly: both
  // inflows in spending categories net down like refunds, which is the #8 behaviour we must preserve.
  it('is a no-op when nothing is reimbursable', () => {
    const plain = buildSpendContext({ categories, splits: [] })
    const total = Object.values(spendByCategory(txns, plain)).reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(920 - 50 - 400) // 470 — e now nets Travel down, as a refund would
    const flows = monthlyFlows(txns as FlowTxn[], plain, [{ key: '2026-07', label: 'Jul' }])
    expect(flows[0].spending).toBeCloseTo(470)
    expect(flows[0].income).toBeCloseTo(2000)
  })
})
