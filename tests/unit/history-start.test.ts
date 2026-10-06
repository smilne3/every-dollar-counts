import { describe, it, expect, vi, beforeEach } from 'vitest'

// A small in-memory database that applies the filters, ordering and limit a query asks for, so a
// read that sorts the wrong way or forgets `removed` gets the wrong answer here as it would live.
type Row = Record<string, unknown>
const { db } = vi.hoisted(() => ({
  db: {
    tables: {} as Record<string, Row[]>,
    fail: null as null | string,
    emptyBody: null as null | string,
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const eqs: [string, unknown][] = []
      let order: { col: string; asc: boolean } | null = null
      let limit = Infinity
      const run = () => {
        if (db.fail === table) return { data: null, error: { message: 'timeout' } }
        if (db.emptyBody === table) return { data: null, error: null }
        let rows = (db.tables[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v))
        if (order) {
          const { col, asc } = order
          rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1))
        }
        return { data: rows.slice(0, limit), error: null }
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => (eqs.push([c, v]), chain),
        order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), chain),
        limit: (n: number) => ((limit = n), chain),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      }
      return chain
    },
  }),
}))

import { historyStart } from '@/lib/history-start'

const acct = (account_id: string, plaid_item_id: string, type = 'depository') => ({ account_id, plaid_item_id, type })
const txn = (account_id: string, date: string, removed = false) => ({ account_id, date, removed })

beforeEach(() => {
  db.fail = null
  db.emptyBody = null
  db.tables = {
    plaid_items: [
      { id: 'amex', institution_name: 'American Express' },
      { id: 'capone', institution_name: 'Capital One' },
    ],
    accounts: [],
    transactions: [],
  }
})

describe('historyStart', () => {
  // The live household on 2026-10-06: Amex supplied about eleven months of history, Capital One
  // about 90 days. Before Capital One's begins, checking (where income lands) is missing entirely.
  it("is ready from the month the LAST bank's history begins", async () => {
    db.tables.accounts = [acct('platinum', 'amex', 'credit'), acct('venture', 'capone', 'credit'), acct('checking', 'capone')]
    db.tables.transactions = [
      txn('platinum', '2025-10-18'), txn('platinum', '2026-09-01'),
      txn('venture', '2026-04-27'), txn('venture', '2026-10-01'),
      txn('checking', '2026-04-28'),
    ]
    expect(await historyStart()).toEqual({ kind: 'ready', month: '2026-04' })
  })

  // A bank's history starts at its EARLIEST account. A card opened last month, or a savings account
  // that first moved money last month, is new activity, not missing history: the bank's other
  // accounts already cover those months.
  it('is not moved by a new account at a bank whose history is already in', async () => {
    db.tables.accounts = [acct('checking', 'capone'), acct('new-card', 'capone', 'credit')]
    db.tables.transactions = [txn('checking', '2026-04-28'), txn('new-card', '2026-09-14')]
    expect(await historyStart()).toEqual({ kind: 'ready', month: '2026-04' })
  })

  // Linked, but the first sync has not landed. Averaging without it would count months missing a
  // whole bank, so the answer is "waiting", by name, not a figure.
  it('is pending, naming the bank, when a bank has cash-flow accounts and no transactions yet', async () => {
    db.tables.accounts = [acct('platinum', 'amex', 'credit'), acct('checking', 'capone')]
    db.tables.transactions = [txn('platinum', '2025-10-18')]
    expect(await historyStart()).toEqual({ kind: 'pending', bank: 'Capital One' })
  })

  // Loans and investments never carry transactions (migration 020), so they are not waited for.
  it('ignores loan and investment accounts', async () => {
    db.tables.accounts = [acct('checking', 'capone'), acct('mortgage', 'amex', 'loan'), acct('brokerage', 'amex', 'investment')]
    db.tables.transactions = [txn('checking', '2026-04-28')]
    expect(await historyStart()).toEqual({ kind: 'ready', month: '2026-04' })
  })

  it('reads each account oldest first', async () => {
    db.tables.accounts = [acct('checking', 'capone')]
    db.tables.transactions = [txn('checking', '2026-10-01'), txn('checking', '2026-04-28'), txn('checking', '2026-07-01')]
    expect(await historyStart()).toEqual({ kind: 'ready', month: '2026-04' })
  })

  // A Plaid-removed row is not history: a removed pending charge must not move the start earlier.
  it('ignores removed transactions', async () => {
    db.tables.accounts = [acct('checking', 'capone')]
    db.tables.transactions = [txn('checking', '2026-01-03', true), txn('checking', '2026-04-28')]
    expect(await historyStart()).toEqual({ kind: 'ready', month: '2026-04' })
  })

  it('is none when the household has no cash-flow accounts', async () => {
    db.tables.accounts = [acct('mortgage', 'amex', 'loan')]
    expect(await historyStart()).toEqual({ kind: 'none' })
  })

  // #46: a failed read must not pass for "no history yet".
  it.each(['accounts', 'transactions', 'plaid_items'])('throws when the %s read fails', async (table) => {
    db.tables.accounts = [acct('platinum', 'amex', 'credit'), acct('checking', 'capone')]
    db.tables.transactions = [txn('platinum', '2025-10-18')]
    db.fail = table
    await expect(historyStart()).rejects.toThrow(/could not read/)
  })

  // postgrest-js reports an empty-body response as no data and no error.
  it.each(['accounts', 'transactions', 'plaid_items'])('throws when the %s read returns no data and no error', async (table) => {
    db.tables.accounts = [acct('platinum', 'amex', 'credit'), acct('checking', 'capone')]
    db.tables.transactions = [txn('platinum', '2025-10-18')]
    db.emptyBody = table
    await expect(historyStart()).rejects.toThrow(/no data and no error/)
  })
})
