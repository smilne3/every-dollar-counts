import { describe, it, expect, vi, beforeEach } from 'vitest'

// Each account's earliest transaction, keyed by account_id; `fail` names a read to fail.
const { db } = vi.hoisted(() => ({
  db: {
    accounts: [] as { account_id: string }[],
    firsts: {} as Record<string, string>,
    fail: null as null | 'accounts' | 'transactions',
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      let account = ''
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'order']) chain[m] = () => chain
      chain.eq = (col: string, v: string) => {
        if (col === 'account_id') account = v
        return chain
      }
      const answer = () => {
        if (db.fail === table) return { data: null, error: { message: 'timeout' } }
        if (table === 'accounts') return { data: db.accounts, error: null }
        const first = db.firsts[account]
        return { data: first ? [{ date: first }] : [], error: null }
      }
      chain.limit = async () => answer()
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve)
      return chain
    },
  }),
}))

import { historyStartMonth } from '@/lib/history-start'

beforeEach(() => {
  db.accounts = []
  db.firsts = {}
  db.fail = null
})

describe('historyStartMonth', () => {
  // The live household on 2026-10-06: Amex supplied a year of history, Capital One about 90 days.
  // Before Capital One's history starts, checking (where income lands) is missing entirely.
  it('is the month the LAST account with transactions begins', async () => {
    db.accounts = [{ account_id: 'amex' }, { account_id: 'venture' }, { account_id: 'checking' }]
    db.firsts = { amex: '2025-10-18', venture: '2026-04-27', checking: '2026-04-28' }
    expect(await historyStartMonth()).toBe('2026-04')
  })

  // A loan or investment account with no transactions has no history to wait for.
  it('ignores accounts with no transactions', async () => {
    db.accounts = [{ account_id: 'amex' }, { account_id: 'mortgage' }]
    db.firsts = { amex: '2025-10-18' }
    expect(await historyStartMonth()).toBe('2025-10')
  })

  it('is null when there are no transactions at all', async () => {
    db.accounts = [{ account_id: 'mortgage' }]
    expect(await historyStartMonth()).toBeNull()
  })

  // Null would read as "no history yet" and quietly hide the average (#46).
  it.each(['accounts', 'transactions'] as const)('throws when the %s read fails', async (table) => {
    db.accounts = [{ account_id: 'amex' }]
    db.firsts = { amex: '2025-10-18' }
    db.fail = table
    await expect(historyStartMonth()).rejects.toThrow(/could not read/)
  })
})
