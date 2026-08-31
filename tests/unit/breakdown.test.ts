import { describe, it, expect } from 'vitest'
import { groupAccountsByKind, sortedSpendRows } from '@/lib/breakdown'
import { netWorth, sumManualAssets } from '@/lib/dashboard'

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

// The Net worth tile and its drill-down are computed by two different modules: the tile by netWorth()
// in lib/dashboard.ts, the rows by groupAccountsByKind() here. They classify account types
// independently, so nothing but this test stops one of them learning about a new type and the
// drill-down quietly failing to add up to the number the user clicked.
describe('net worth reconciliation', () => {
  const accounts = [
    acct('a1', 'depository', 8000),
    acct('a2', 'investment', 2000),
    acct('a3', 'other', 100),
    acct('a4', 'credit', 500),
    acct('a5', 'loan', 10000),
    acct('a6', null, 999), // unknown type: ignored by BOTH sides, which is itself the invariant
  ]
  const manualAssets = [{ value: 400_000 }]

  it('breakdown rows sum to the same total as the net worth tile', () => {
    const receivable = 500
    const tile = netWorth(accounts, receivable) + sumManualAssets(manualAssets)

    const g = groupAccountsByKind(accounts)
    const rows = g.assetTotal - g.liabilityTotal + sumManualAssets(manualAssets) + receivable

    expect(rows).toBeCloseTo(tile)
  })

  it('still reconciles with nothing owed', () => {
    const g = groupAccountsByKind(accounts)
    expect(g.assetTotal - g.liabilityTotal + sumManualAssets(manualAssets)).toBeCloseTo(
      netWorth(accounts, 0) + sumManualAssets(manualAssets)
    )
  })
})
