import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/budgets-page.test.tsx and tests/unit/trends-page.test.tsx:
// the static page import below is linked before this file's body runs, firing the mock factory.
const { results, calls, tz } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  calls: { gte: [] as string[] },
  tz: { value: 'America/New_York' },
}))

// A supabase query is a builder awaited at the end, so the stub returns itself for every chained
// method and resolves to whatever the test configured for that table. `.gte` is recorded rather
// than just chained, since the date bound it's given is the whole behaviour under test here.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'lte', 'limit', 'not']) chain[m] = () => chain
  // readAllRows (lib/read-all.ts) asks for the rows after its cursor with .or(); there are none
  // past this fixture, so a continuation page is empty and the read ends.
  let afterCursor = false
  chain.or = () => {
    afterCursor = true
    return chain
  }
  chain.gte = (_col: string, v: string) => {
    calls.gte.push(v)
    return chain
  }
  chain.single = async () => results[table] ?? { data: null, error: null }
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      afterCursor ? { data: [], error: null } : (results[table] ?? { data: [], error: null })
    ).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
}))
vi.mock('@/lib/household', () => ({
  DEFAULT_TIMEZONE: 'America/New_York',
  householdTimezone: async () => tz.value,
}))
vi.mock('@/lib/manual-assets', () => ({ listManualAssets: async () => [] }))
vi.mock('@/lib/receivable', () => ({ fetchReceivable: async () => 0 }))

import BreakdownPage from '@/app/(app)/breakdown/[metric]/page'
import { BreakdownList } from '@/components/BreakdownList'

const render = (metric: string) => BreakdownPage({ params: Promise.resolve({ metric }) })

beforeEach(() => {
  vi.useFakeTimers()
  calls.gte = []
  tz.value = 'America/New_York'
  results.accounts = { data: [], error: null }
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.categories = { data: [], error: null }
  results.transactions = { data: [], error: null }
})

// net-worth and cash never touch a date — only spent and saved read the household's month, and
// only those two are exercised below.
describe('Breakdown month window', () => {
  // Same trap as Budgets (#73), on a page Budgets doesn't share: at 8:10pm on 31 August the server
  // is already in September. This page's month key also gets embedded in the outbound
  // /transactions?...&month= links rendered below it, so a wrong month here leaks into a second
  // page's filter, silently.
  it('uses the household\'s month, not the server\'s, for the spent metric', async () => {
    vi.setSystemTime(new Date('2026-09-01T00:10:00Z')) // 8:10pm on 31 August in New York
    await render('spent')
    expect(calls.gte).toContain('2026-08-01')
    expect(calls.gte).not.toContain('2026-09-01')
  })

  // Saved reads seven months: this one plus the six complete months its average draws on (#126).
  // In the household's August that window opens in February; in the server's September it would
  // open in March.
  it('uses the household\'s month, not the server\'s, for the saved metric', async () => {
    vi.setSystemTime(new Date('2026-09-01T00:10:00Z'))
    await render('saved')
    expect(calls.gte).toContain('2026-02-01')
    expect(calls.gte).not.toContain('2026-03-01')
  })

  it('rolls over when the household\'s month actually changes', async () => {
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z')) // 8am on 1 September in New York
    await render('spent')
    expect(calls.gte).toContain('2026-09-01')
  })

  it('crosses a year boundary correctly', async () => {
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'))
    await render('spent')
    expect(calls.gte).toContain('2026-12-01')
  })
})

// Every BreakdownList on the page, in order, with the props the page handed it.
function lists(node: unknown, out: { rows: { label: string; amount: number }[]; total?: { label: string; amount: number } }[] = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((n) => lists(n, out))
    return out
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> }
  if (el.type === BreakdownList) out.push(el.props as never)
  else if (el.props && 'children' in el.props) lists(el.props.children, out)
  return out
}
const textOf = (node: unknown): string => {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const el = node as { props?: { children?: unknown } }
  return el.props ? textOf(el.props.children) : ''
}

describe('Saved breakdown: average per month (#126)', () => {
  // 2026-09-15 in New York: September is in progress. History starts 2026-05-20, so May is partial.
  // June, July and August qualify, saving $1,000, $3,000 and -$1,000.
  const txn = (id: string, date: string, amount: number, pfc: string) => ({
    id, date, amount, user_category: null, pfc_primary: pfc, pfc_detailed: null, reimbursable_amount: null,
  })
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'))
    results.categories = { data: [{ id: 'c1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 }], error: null }
    // historyStartMonth reads the first transaction per account. This stub answers every read with
    // the whole fixture, so one account's "first" is the fixture's first row.
    results.accounts = { data: [{ account_id: 'acc-1' }], error: null }
  })

  it('lists each complete month and their mean, newest first', async () => {
    results.transactions = {
      data: [
        txn('may', '2026-05-20', 900, 'FOOD_AND_DRINK'),
        txn('jun-in', '2026-06-05', -4000, 'INCOME'), txn('jun-out', '2026-06-06', 3000, 'FOOD_AND_DRINK'),
        txn('jul-in', '2026-07-05', -4000, 'INCOME'), txn('jul-out', '2026-07-06', 1000, 'FOOD_AND_DRINK'),
        txn('aug-in', '2026-08-05', -4000, 'INCOME'), txn('aug-out', '2026-08-06', 5000, 'FOOD_AND_DRINK'),
        txn('sep-out', '2026-09-06', 7000, 'FOOD_AND_DRINK'),
      ],
      error: null,
    }
    const tree = await render('saved')
    const avg = lists(tree)[1]
    expect(avg.rows.map((r) => [r.label, r.amount])).toEqual([
      ['August', -1000],
      ['July', 3000],
      ['June', 1000],
    ])
    expect(avg.total).toMatchObject({ label: 'Average per month', amount: 1000 })
    expect(textOf(tree)).toContain('last 3 months')
  })

  it('says there is not enough history when no month qualifies', async () => {
    results.transactions = { data: [txn('sep-out', '2026-09-06', 70, 'FOOD_AND_DRINK')], error: null }
    const tree = await render('saved')
    expect(lists(tree)).toHaveLength(1)
    expect(textOf(tree)).toMatch(/not enough history/i)
  })
})
