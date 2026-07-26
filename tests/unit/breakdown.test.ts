import { describe, it, expect } from 'vitest'
import { groupAccountsByKind, sortedSpendRows } from '@/lib/breakdown'

const acct = (
  account_id: string,
  type: string | null,
  current_balance: number | null,
  name = 'Acct',
  subtype: string | null = null
) => ({ id: `uuid-${account_id}`, account_id, type, current_balance, name, subtype })

describe('groupAccountsByKind', () => {
  it('splits assets from liabilities and totals each, with net = assets - liabilities', () => {
    const r = groupAccountsByKind([
      acct('a', 'depository', 8000),
      acct('b', 'investment', 2000),
      acct('c', 'other', 100),
      acct('d', 'credit', 500),
      acct('e', 'loan', 10000),
    ])
    expect(r.assetTotal).toBe(10100)
    expect(r.liabilityTotal).toBe(10500)
    expect(r.net).toBe(-400)
    expect(r.assets.map((a) => a.account_id)).toEqual(['a', 'b', 'c'])
    expect(r.liabilities.map((a) => a.account_id)).toEqual(['d', 'e'])
    expect(r.liabilities[0].owed).toBe(true)
    expect(r.assets[0].owed).toBe(false)
  })

  it('treats null balances as zero and ignores unknown types', () => {
    const r = groupAccountsByKind([acct('a', 'depository', null), acct('x', 'weird', 999)])
    expect(r.assetTotal).toBe(0)
    expect(r.liabilityTotal).toBe(0)
    expect(r.assets.map((a) => a.account_id)).toEqual(['a']) // depository with null balance still listed
  })
})

describe('sortedSpendRows', () => {
  it('returns rows sorted by amount descending', () => {
    const r = sortedSpendRows({ Food: 12, Travel: 300, Shopping: 89 })
    expect(r).toEqual([
      { category: 'Travel', amount: 300 },
      { category: 'Shopping', amount: 89 },
      { category: 'Food', amount: 12 },
    ])
  })
})
