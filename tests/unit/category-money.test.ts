import { describe, it, expect } from 'vitest'
import { monthlyFlows, type FlowTxn } from '@/lib/dashboard'
import { spendByCategory } from '@/lib/budget'
import { buildSpendContext } from '@/lib/spend-context'
import type { Category } from '@/lib/categories'
import { catalogFingerprint, type CategoryRule, type SuggestionRef } from '@/lib/category-rules'
import { DEFAULTS, GROCERY, cat, rule, sug, testData } from './helpers/category-context'

// #28 spec §5.4 and §14.3: rules and Jev's suggestions change only which category a dollar sits
// in. No set of rules or suggestions may change Spent, Income or Saved, for any set of categories,
// including ones with a default Income or Transfer category deleted and one named "Uncategorized".
const MONTHS = [{ key: '2026-09', label: 'Sep' }]
type Row = FlowTxn & { reimbursable_amount: number | null; suggestion: SuggestionRef | null }
const r = (id: string, merchant_name: string | null, amount: number, pfc_primary: string | null, over: Partial<Row> = {}): Row => ({
  id, date: '2026-09-10', amount, merchant_name, user_category: null, pfc_primary, pfc_detailed: null, reimbursable_amount: null, suggestion: null, ...over,
})
const ROWS = [
  r('a', 'Safeway', 50, 'FOOD_AND_DRINK'),
  r('b', 'Safeway', -10, 'FOOD_AND_DRINK'), // a refund
  r('c', 'Acme Payroll', -3000, 'INCOME'),
  r('d', 'Acme Payroll', 25, 'INCOME'), // a clawback
  r('e', 'Savings', 500, 'TRANSFER_OUT'),
  r('f', 'Savings', -500, 'TRANSFER_IN'),
  r('g', 'Chase', 6412.58, 'LOAN_PAYMENTS', { pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
  r('h', 'Lender', -1000, 'LOAN_DISBURSEMENTS'), // unmapped primary
  r('i', 'Safeway', 12, 'FOOD_AND_DRINK', { user_category: 'Travel' }),
  r('j', 'Venmo', 40, 'TRANSFER_OUT'),
  r('k', null, 30, 'GENERAL_MERCHANDISE'),
]
const merchants = [...new Set(ROWS.map((x) => x.merchant_name).filter((m): m is string => !!m))]
const without = (name: string) => DEFAULTS.filter((c) => c.name !== name)
const SETS: [string, Category[]][] = [
  ['the defaults', DEFAULTS],
  ['no Income', without('Income')],
  ['no Transfer In', without('Transfer In')],
  ['no Transfer Out', without('Transfer Out')],
  ['a category named Uncategorized', [...DEFAULTS, cat('Uncategorized', null, 300)]],
]

function totals(categories: Category[], rules: CategoryRule[], rows: Row[] = ROWS) {
  const ctx = buildSpendContext({ data: testData(categories, rules), txns: rows })
  const [m] = monthlyFlows(rows, ctx, MONTHS)
  const byCat = spendByCategory(rows, ctx)
  return { spending: m.spending, income: m.income, spent: Object.values(byCat).reduce((s, v) => s + v, 0), byCat }
}

describe('rules and money', () => {
  it("moves Safeway's spending from Food & Drink to Grocery", () => {
    const before = totals(DEFAULTS, []).byCat
    const after = totals(DEFAULTS, [rule('Safeway', GROCERY.id)]).byCat
    expect(before['Food & Drink']).toBe(40)
    expect(after['Food & Drink']).toBeUndefined()
    expect(after.Grocery).toBe(40) // 50 out, 10 refunded: the refund nets the rule's category down
  })

  it('keeps a matching card payment out of both totals', () => {
    const { spending, income } = totals(DEFAULTS, [rule('Chase', GROCERY.id)])
    expect(spending).toBe(totals(DEFAULTS, []).spending)
    expect(income).toBe(totals(DEFAULTS, []).income)
  })

  for (const [label, cats] of SETS) {
    it(`never moves Spent or Income for any single rule, over ${label}`, () => {
      const before = totals(cats, [])
      for (const m of merchants) {
        for (const c of cats) {
          const after = totals(cats, [rule(m, c.id)])
          expect(after.spending, `${m} → ${c.name}`).toBeCloseTo(before.spending, 2)
          expect(after.income, `${m} → ${c.name}`).toBeCloseTo(before.income, 2)
          expect(after.spent, `${m} → ${c.name}`).toBeCloseTo(before.spent, 2)
        }
      }
    })

    it(`never moves Spent or Income for many rules at once, over ${label}`, () => {
      let seed = 28 // deterministic, so a failure reproduces
      const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
      const before = totals(cats, [])
      for (let n = 0; n < 200; n++) {
        const rules = merchants.filter(() => rand() < 0.6).map((m) => rule(m, cats[Math.floor(rand() * cats.length)].id))
        const after = totals(cats, rules)
        expect(after.spending).toBeCloseTo(before.spending, 2)
        expect(after.income).toBeCloseTo(before.income, 2)
        expect(after.spent).toBeCloseTo(before.spent, 2)
      }
    })
  }
})

// testData switches suggestions on by default, so every suggestion below is live: current
// fingerprint, confidence 0.99. Only the kind gate and the card-payment exemption hold the line.
const suggestAll = (categoryId: string, fp: string) => ROWS.map((x) => ({ ...x, suggestion: sug(categoryId, 0.99, fp) }))

describe('suggestions and money', () => {
  // The suggestions really apply, so the property below is not vacuous.
  it('moves every unpicked spending row into the suggested category', () => {
    const after = totals(DEFAULTS, [], suggestAll(GROCERY.id, catalogFingerprint(DEFAULTS))).byCat
    expect(after['Food & Drink']).toBeUndefined()
    expect(after.Shopping).toBeUndefined()
    expect(after.Uncategorized).toBeUndefined()
    expect(after.Grocery).toBeCloseTo(40 + 30 - 1000, 2) // Safeway net, row k, the unmapped Lender inflow
    expect(after.Travel).toBe(12) // the hand pick stays
  })

  for (const [label, cats] of SETS) {
    it(`never moves Spent or Income for every row suggested into any one category, over ${label}`, () => {
      const before = totals(cats, [])
      const fp = catalogFingerprint(cats)
      for (const c of cats) {
        const after = totals(cats, [], suggestAll(c.id, fp))
        expect(after.spending, `→ ${c.name}`).toBeCloseTo(before.spending, 2)
        expect(after.income, `→ ${c.name}`).toBeCloseTo(before.income, 2)
        expect(after.spent, `→ ${c.name}`).toBeCloseTo(before.spent, 2)
      }
    })
  }

  it('keeps Spent unchanged when every row is suggested into a transfer category', () => {
    const before = totals(DEFAULTS, [])
    const fp = catalogFingerprint(DEFAULTS)
    for (const name of ['Transfer In', 'Transfer Out']) {
      const after = totals(DEFAULTS, [], suggestAll(`c-${name}`, fp))
      expect(after.spending, name).toBeCloseTo(before.spending, 2)
      expect(after.spent, name).toBeCloseTo(before.spent, 2)
    }
  })
})
