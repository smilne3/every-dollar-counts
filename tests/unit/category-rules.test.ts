import { describe, it, expect } from 'vitest'
import {
  merchantKey,
  kindOf,
  bankCategory,
  buildKindContext,
  buildCategoryContext,
  resolveCategory,
  changedByRule,
  type CategorizableTxn,
  type CategoryContext,
  type CategoryData,
} from '@/lib/category-rules'
import { DEFAULTS, GROCERY, HH, cat, rule, testCtx, testData } from './helpers/category-context'

// #28 spec §5.3: resolveCategory is the only code that turns a row into a category name. Pick, then
// rule, then bank; card payments never take a rule; a rule never crosses spending/transfer/income.
const row = (over: Partial<CategorizableTxn> = {}): CategorizableTxn => ({
  user_category: null,
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: null,
  merchant_name: 'Safeway',
  ...over,
})
const without = (name: string) => DEFAULTS.filter((c) => c.name !== name)
const safewayToGrocery = rule('Safeway', GROCERY.id)

describe('merchantKey', () => {
  it('is null for null, empty and whitespace', () => {
    expect(merchantKey(null)).toBeNull()
    expect(merchantKey('')).toBeNull()
    expect(merchantKey('   ')).toBeNull()
  })
  it('trims and lowercases, and nothing more', () => {
    expect(merchantKey(' SAFEWAY ')).toBe('safeway')
    expect(merchantKey('Walmart+')).toBe('walmart+')
  })
})

describe('kindOf and bankCategory', () => {
  const k = buildKindContext(DEFAULTS)
  it('names transfers first, then income, and everything else spending', () => {
    expect(kindOf('Transfer In', k)).toBe('transfer')
    expect(kindOf('Income', k)).toBe('income')
    expect(kindOf('Grocery', k)).toBe('spending')
    expect(kindOf('Uncategorized', k)).toBe('spending')
    expect(kindOf('No such category', k)).toBe('spending')
  })
  it('maps a primary to its category and kind', () => {
    expect(bankCategory({ pfc_primary: 'FOOD_AND_DRINK' }, k)).toEqual({ name: 'Food & Drink', kind: 'spending' })
    expect(bankCategory({ pfc_primary: 'TRANSFER_OUT' }, k)).toEqual({ name: 'Transfer Out', kind: 'transfer' })
  })
  it("takes an unmapped row's kind from Plaid's tag", () => {
    const noTransferOut = buildKindContext(without('Transfer Out'))
    expect(bankCategory({ pfc_primary: 'TRANSFER_OUT' }, noTransferOut)).toEqual({ name: 'Uncategorized', kind: 'transfer' })
    expect(bankCategory({ pfc_primary: 'INCOME' }, buildKindContext(without('Income')))).toEqual({ name: 'Uncategorized', kind: 'income' })
    expect(bankCategory({ pfc_primary: 'LOAN_DISBURSEMENTS' }, k)).toEqual({ name: 'Uncategorized', kind: 'spending' })
    expect(bankCategory({ pfc_primary: null }, k)).toEqual({ name: 'Uncategorized', kind: 'spending' })
  })
  it('is last-wins when two categories share a primary, like pfcToName', () => {
    const k2 = buildKindContext([...DEFAULTS, cat('Groceries & Dining', 'FOOD_AND_DRINK', 200)])
    expect(bankCategory({ pfc_primary: 'FOOD_AND_DRINK' }, k2).name).toBe('Groceries & Dining')
  })
})

describe('resolveCategory', () => {
  const ctx = testCtx(DEFAULTS, [safewayToGrocery])

  it('applies a rule when there is no pick', () => {
    expect(resolveCategory(row(), ctx)).toEqual({ name: 'Grocery', source: 'rule', ruleId: safewayToGrocery.id, bankName: 'Food & Drink' })
  })
  it('lets a hand pick beat a rule', () => {
    expect(resolveCategory(row({ user_category: 'Travel' }), ctx)).toEqual({ name: 'Travel', source: 'pick', ruleId: null, bankName: 'Food & Drink' })
  })
  it('never applies a rule to a card payment, but keeps its pick', () => {
    const card = row({ pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(resolveCategory(card, ctx)).toEqual({ name: 'Loan Payments', source: 'bank', ruleId: null, bankName: 'Loan Payments' })
    expect(resolveCategory({ ...card, user_category: 'Shopping' }, ctx).source).toBe('pick')
  })
  it.each([null, '', '  '])('never matches merchant %j', (merchant_name) => {
    expect(resolveCategory(row({ merchant_name }), ctx).source).toBe('bank')
  })
  it('matches across case and surrounding space, and nothing looser', () => {
    expect(resolveCategory(row({ merchant_name: ' SAFEWAY ' }), ctx).name).toBe('Grocery')
    const walmart = testCtx(DEFAULTS, [rule('Walmart', GROCERY.id)])
    expect(resolveCategory(row({ merchant_name: 'Walmart+' }), walmart).source).toBe('bank')
  })
  it('does not apply a spending rule to a transfer row', () => {
    expect(resolveCategory(row({ pfc_primary: 'TRANSFER_OUT' }), ctx)).toMatchObject({ name: 'Transfer Out', source: 'bank' })
  })
  it('applies a spending rule to an Uncategorized row with a spending primary', () => {
    expect(resolveCategory(row({ pfc_primary: 'LOAN_DISBURSEMENTS' }), ctx)).toMatchObject({ name: 'Grocery', source: 'rule', bankName: 'Uncategorized' })
  })
  it('after "Transfer Out" is deleted, applies neither a spending nor a transfer rule to a TRANSFER_OUT row', () => {
    const cats = without('Transfer Out')
    const spending = testCtx(cats, [safewayToGrocery])
    const transfer = testCtx(cats, [rule('Safeway', 'c-Transfer In')])
    const t = row({ pfc_primary: 'TRANSFER_OUT' })
    expect(resolveCategory(t, spending)).toMatchObject({ name: 'Uncategorized', source: 'bank' })
    expect(resolveCategory(t, transfer)).toMatchObject({ name: 'Uncategorized', source: 'bank' })
  })
  it('after "Income" is deleted, does not apply a spending rule to an INCOME row', () => {
    const t = row({ pfc_primary: 'INCOME' })
    expect(resolveCategory(t, testCtx(without('Income'), [safewayToGrocery]))).toMatchObject({ name: 'Uncategorized', source: 'bank' })
  })
  it("gives the bank category when the rule's category is missing from the context", () => {
    const dangling = testCtx(DEFAULTS, [rule('Safeway', 'c-gone')])
    expect(resolveCategory(row(), dangling)).toMatchObject({ name: 'Food & Drink', source: 'bank' })
  })
  // Review Focus 1: rules point at an id, so a rename moves every row at once.
  it('follows a renamed category', () => {
    const renamed = DEFAULTS.map((c) => (c.id === GROCERY.id ? { ...c, name: 'Groceries' } : c))
    expect(resolveCategory(row(), testCtx(renamed, [safewayToGrocery])).name).toBe('Groceries')
  })
  it('reports the bank name, and changedByRule only when the rule changed it', () => {
    const r = resolveCategory(row(), ctx)
    expect(r.bankName).toBe('Food & Drink')
    expect(changedByRule(r)).toBe(true)
    const same = resolveCategory(row(), testCtx(DEFAULTS, [rule('Safeway', 'c-Food & Drink')]))
    expect(same.source).toBe('rule')
    expect(changedByRule(same)).toBe(false)
    expect(changedByRule(resolveCategory(row({ user_category: 'Travel' }), ctx))).toBe(false)
  })
})

describe('buildCategoryContext', () => {
  it('can build as if a category and its rules were gone', () => {
    const data = testData(DEFAULTS, [safewayToGrocery])
    const gone = buildCategoryContext(data, { withoutCategoryId: GROCERY.id })
    expect(resolveCategory(row(), gone)).toMatchObject({ name: 'Food & Drink', source: 'bank' })
    const foodGone = buildCategoryContext(data, { withoutCategoryId: 'c-Food & Drink' })
    expect(resolveCategory(row({ merchant_name: 'Other' }), foodGone).name).toBe('Uncategorized')
  })
  it('throws on rules from more than one household', () => {
    const data = testData(DEFAULTS, [safewayToGrocery, rule('Giant', GROCERY.id, { household_id: 'hh-2' })])
    expect(() => buildCategoryContext(data)).toThrow('category rules span more than one household')
  })
  it('accepts a CategoryContext wherever a KindContext is', () => {
    const ctx: CategoryContext = testCtx()
    expect(kindOf('Income', ctx)).toBe('income')
  })
  it('refuses hand-built contexts and data at compile time', () => {
    // @ts-expect-error a literal is not a CategoryContext
    const literal: CategoryContext = {}
    // @ts-expect-error data must come from fetchCategoryContext
    const data: CategoryData = { categories: DEFAULTS, rules: [] }
    expect([literal, data, HH]).toBeTruthy()
  })
})
