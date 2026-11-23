import { describe, it, expect, vi, beforeEach } from 'vitest'

// fetchReceivable: the read behind "Owed to you" and the receivable part of net worth. The Dashboard
// and Breakdown page tests replace this whole module, so until this file nothing ran it, and its
// error check or either filter could go with every test green (#223).
//
// The stand-in applies the filters it's given to its rows, projects them to the columns selected, and
// records every call. So a dropped filter, or a narrowed select, both changes the answer and shows in
// the recorded query.
type Row = Record<string, unknown>
const { db } = vi.hoisted(() => ({
  db: { rows: [] as Row[], error: null as null | { message: string }, calls: [] as unknown[][] },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      db.calls.push(['from', table])
      let rows = db.rows
      let columns: string[] = []
      const query = {
        select: (cols: string) => {
          db.calls.push(['select', cols])
          columns = cols.split(',').map((c) => c.trim())
          return query
        },
        not: (col: string, op: string, value: unknown) => {
          db.calls.push(['not', col, op, value])
          if (op === 'is' && value === null) rows = rows.filter((r) => r[col] != null)
          return query
        },
        eq: (col: string, value: unknown) => {
          db.calls.push(['eq', col, value])
          rows = rows.filter((r) => r[col] === value)
          return query
        },
        order: (col: string, options: unknown) => {
          db.calls.push(['order', col, options])
          return query
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(
            db.error
              ? { data: null, error: db.error }
              : { data: rows.map((r) => Object.fromEntries(columns.filter((c) => c in r).map((c) => [c, r[c]]))), error: null }
          ).then(resolve, reject),
      }
      return query
    },
  }),
}))

import { fetchReceivable } from '@/lib/receivable'

// Illustrative figures. Plaid's sign: amount > 0 is money out.
const OWED = { id: 't1', date: '2026-10-02', amount: 100, reimbursable_amount: 40, removed: false } // owed 40
const REPAID = { id: 't2', date: '2026-10-09', amount: -30, reimbursable_amount: 30, removed: false } // repaid 30
const UNMARKED = { id: 't3', date: '2026-10-05', amount: 55, reimbursable_amount: null, removed: false }
// A Plaid repost: the old copy is flagged removed, not deleted, so its mark must stop counting.
const REPOSTED = { id: 't4', date: '2026-10-03', amount: 900, reimbursable_amount: 900, removed: true }

beforeEach(() => {
  db.rows = [OWED, REPAID, UNMARKED, REPOSTED]
  db.error = null
  db.calls = []
})

describe('fetchReceivable', () => {
  it('answers what is owed from marked, current rows only', async () => {
    await expect(fetchReceivable()).resolves.toBe(10)
  })

  // The filters and the order the Reimbursements page's own query uses, so the two agree (see the
  // read's comment). Each one is pinned here, so dropping any fails.
  it('asks for marked rows that are not removed, newest first, with a unique tiebreak', async () => {
    await fetchReceivable()
    expect(db.calls).toEqual([
      ['from', 'transactions'],
      ['select', 'id, amount, reimbursable_amount'],
      ['not', 'reimbursable_amount', 'is', null],
      ['eq', 'removed', false],
      ['order', 'date', { ascending: false }],
      ['order', 'id', { ascending: false }],
    ])
  })

  // #46: a failed read must never pass for "you are owed nothing".
  it('rejects with the read error instead of answering 0', async () => {
    db.error = { message: 'canceling statement due to statement timeout' }
    await expect(fetchReceivable()).rejects.toThrow(
      'could not read reimbursable transactions: canceling statement due to statement timeout'
    )
  })

  it('answers 0 when nothing is marked', async () => {
    db.rows = [UNMARKED]
    await expect(fetchReceivable()).resolves.toBe(0)
  })
})
