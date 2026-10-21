import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/trends-page.test.tsx: the static page import below
// is linked before this file's body runs, firing the mock factory.
const { results, tz, presentation, paged, history, selects } = vi.hoisted(() => ({
  // Every `.select()` the page sends, per table, so a test can pin the suggestion embed (§7.4).
  selects: {} as Record<string, string[]>,
  // What lib/history-start answers. Mocked so these tests can tell a page that takes the history
  // start from historyStart apart from one that guesses it from its own transaction read: this
  // stub serves the whole fixture to every query, so the two would otherwise always agree.
  history: { value: { kind: 'none' } as { kind: 'ready'; month: string } | { kind: 'pending'; itemId: string } | { kind: 'none' } },
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  // When set, `transactions` is served by a PostgREST-like stub that caps each response at 1,000
  // rows, so the test can tell a paged read from a plain one (#69).
  paged: { transactions: null as null | { query: () => Record<string, unknown> } },
  tz: { value: 'America/New_York' },
  presentation: { stampLabel: false },
}))

// A supabase query is a builder awaited at the end, so the stub returns itself for every chained
// method and resolves to whatever the test configured for that table.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'gte', 'lte', 'limit', 'not']) chain[m] = () => chain
  chain.select = (cols: string) => {
    (selects[table] ??= []).push(cols)
    return chain
  }
  // readAllRows (lib/read-all.ts) asks for the rows after its cursor with .or(); there are none
  // past this fixture, so a continuation page is empty and the read ends.
  let afterCursor = false
  chain.or = () => {
    afterCursor = true
    return chain
  }
  // maybeSingle only. Null data and no error is its answer for no row; .single() makes no row an
  // error (PGRST116), which a stand-in answering null would hide (#172).
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      afterCursor ? { data: [], error: null } : (results[table] ?? { data: [], error: null })
    ).then(resolve)
  return chain
}

// The signed-in client refuses plaid_items, which RLS gives it no rows of (#169).
vi.mock('@/lib/supabase/server', async () => {
  const { refuseSignedInPlaidItems } = await import('../stubs/plaid-items')
  return {
    createClient: async () => ({
      from: (table: string) => {
        refuseSignedInPlaidItems(table)
        return table === 'transactions' && paged.transactions ? paged.transactions.query() : chainFor(table)
      },
    }),
  }
})
// The service-role client answers from `results` too, so lib/manual-assets.ts and
// lib/plaid-items.ts run for real and a failed read reaches the page as it would in production
// (#91). plaid_items goes through the strict stand-in in tests/stubs/plaid-items.ts, which applies
// the read's filters to the stored rows, so the banner shows only this household's banks (#135).
// lib/plaid-items.ts needs only plaidEnv from lib/plaid.
vi.mock('@/lib/supabase/admin', async () => {
  const { plaidItemsQuery } = await import('../stubs/plaid-items')
  return {
    supabaseAdmin: {
      from: (table: string) =>
        table === 'plaid_items' ? plaidItemsQuery(results.plaid_items ?? { data: [], error: null }) : chainFor(table),
    },
  }
})
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
// Categories and rules come through lib/category-context.ts (#28), whose own test covers paging.
// Built from `results.categories` / `results.category_rules`, so a failed categories read still
// rejects with the page's message.
// The real module otherwise, so the page gets the real SUGGESTION_EMBED and the switch is read by
// the real suggestionsEnabled (spec §14.7).
vi.mock('@/lib/category-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/category-context')>()
  const { testData } = await import('./helpers/category-context')
  return {
    ...actual,
    fetchCategoryContext: async () => {
      const c = results.categories ?? { data: [], error: null }
      if (c.error) throw new Error(`could not read categories: ${c.error.message}`)
      const r = results.category_rules ?? { data: [], error: null }
      if (r.error) throw new Error(`could not read category rules: ${r.error.message}`)
      return testData(c.data as never, r.data as never, { suggestionsOn: actual.suggestionsEnabled() })
    },
    readTransactionsForCounts: async () => {
      const t = results.transactions ?? { data: [], error: null }
      if (t.error) throw new Error(`could not read transactions: ${t.error.message}`)
      return t.data
    },
  }
})
// The real module but for the timezone, so currentHouseholdId reads `results.memberships` as the
// saved breakdown it is compared with below does.
vi.mock('@/lib/household', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/household')>()),
  householdTimezone: async () => tz.value,
}))
// The real module by default. Under `stampLabel` every label gets a prefix no local expression
// could produce, which is the ONLY way to tell "the page took p.label" apart from "the page
// re-derived merchant_name ?? name ?? 'Transaction'": those two agree on every possible input by
// construction, so no assertion on the value can separate them. See the test that uses it.
vi.mock('@/lib/transaction-presentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transaction-presentation')>()
  return {
    ...actual,
    presentTransaction: (t: Parameters<typeof actual.presentTransaction>[0]) => {
      const p = actual.presentTransaction(t)
      return presentation.stampLabel ? { ...p, label: `presented:${p.label}` } : p
    },
  }
})
vi.mock('@/lib/receivable', () => ({ fetchReceivable: async () => 0 }))
vi.mock('@/lib/history-start', () => ({ historyStart: async () => history.value }))

import { pagedTable } from '../stubs/postgrest-pages'
import { storedItem, FOREIGN_ITEMS } from '../stubs/plaid-items'
import { blocks, bannerText, balancesNote } from './helpers/banner'
import DashboardPage from '@/app/(app)/dashboard/page'
import BreakdownPage from '@/app/(app)/breakdown/[metric]/page'
import { BreakdownList } from '@/components/BreakdownList'
import { MissingBalancesNote } from '@/components/MissingBalancesNote'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { LinkButton } from '@/components/LinkButton'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { moneyWhole } from '@/lib/format'
import { catalogFingerprint } from '@/lib/category-rules'
import { sug } from './helpers/category-context'

const render = () => DashboardPage({ searchParams: Promise.resolve({}) })

// An account at storedItem()'s bank, which every test starts with, and one at the second bank some
// tests link. Each is that bank's balances being in (#170). The second moves no figure.
const A1 = { id: 'a1', plaid_item_id: 'item-1', type: 'depository', current_balance: 100 }
const A2 = { id: 'a2', plaid_item_id: 'item-2', type: 'credit', current_balance: 0 }

// The exact moment from the #73 screenshot: 8:10pm on Wednesday 2 September in US Eastern, which
// is already Thursday 3 September in UTC.
const REPORTED = new Date('2026-09-03T00:10:00Z')

// Walk the returned element tree and collect every string, so assertions do not depend on where
// in the JSX a given piece of copy sits.
function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const el = node as { props?: { children?: unknown; title?: unknown; subtitle?: unknown; label?: unknown } }
  if (!el.props) return ''
  return [el.props.title, el.props.subtitle, el.props.label, el.props.children].map(textOf).join(' ')
}

// Collect the StatCard elements from the returned tree so tile assertions can read their props
// directly. textOf() deliberately flattens to strings, which cannot see a `variant` or an `amount`.
type StatCardProps = {
  label: string
  amount: number
  variant?: 'hero' | 'compact'
  tone?: 'ink' | 'coral'
  foot?: unknown
}

function findStatCards(node: unknown): { props: StatCardProps }[] {
  const found: { props: StatCardProps }[] = []
  const walk = (n: unknown) => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    const el = n as { type?: unknown; props?: { children?: unknown } }
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'StatCard') {
      found.push(el as unknown as { props: StatCardProps })
    }
    if (el.props?.children) walk(el.props.children)
  }
  walk(node)
  return found
}

// The items the page hands to <RecentActivity>. The list itself is not rendered here — this reads
// the props off the element, which is exactly the seam the page owns.
function recentItemsOf(node: unknown): Record<string, unknown>[] | null {
  let found: Record<string, unknown>[] | null = null
  const walk = (n: unknown) => {
    if (n == null || typeof n !== 'object' || found) return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    const el = n as { type?: unknown; props?: { items?: unknown; children?: unknown } }
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'RecentActivity') {
      found = el.props?.items as Record<string, unknown>[]
      return
    }
    if (el.props?.children) walk(el.props.children)
  }
  walk(node)
  return found
}

// Every className in the returned tree, so a structural assertion does not depend on where in
// the JSX the element sits.
function classNamesOf(node: unknown): string[] {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    const el = n as { props?: { className?: unknown; children?: unknown } }
    if (typeof el.props?.className === 'string') out.push(el.props.className)
    if (el.props?.children) walk(el.props.children)
  }
  walk(node)
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(REPORTED)
  tz.value = 'America/New_York'
  presentation.stampLabel = false
  // One account, so the page renders the money tiles rather than the empty state.
  results.accounts = { data: [A1], error: null }
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.categories = { data: [], error: null }
  results.category_rules = { data: [], error: null }
  results.transactions = { data: [], error: null }
  results.budgets = { data: [], error: null }
  results.manual_assets = { data: [], error: null }
  results.plaid_items = { data: [], error: null }
  paged.transactions = null
  history.value = { kind: 'none' }
  for (const k of Object.keys(selects)) delete selects[k]
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Dashboard banks (#135)', () => {
  it("warns that a bank isn't syncing, first, above the header", async () => {
    results.accounts = { data: [A1, A2], error: null }
    results.plaid_items = {
      data: [storedItem({ status: 'needs_reconnect' }), storedItem({ id: 'item-2', institution_name: 'Amex' }), ...FOREIGN_ITEMS],
      error: null,
    }
    const tree = await render()
    expect(bannerText(tree)).toBe(
      "Capital One isn't syncing — reconnect in Settings to resume. These figures may be out of date."
    )
    const order = blocks(tree).map((b) => b.type)
    expect(order.indexOf(NotSyncingBanner)).toBe(0)
    expect(order.indexOf(NotSyncingBanner)).toBeLessThan(order.indexOf(PageHeader))
  })

  // Another household's broken bank, or this household's from the other Plaid environment, must
  // not raise the banner here.
  it('says nothing while every one of the household\'s banks is syncing', async () => {
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(bannerText(await render())).toBe('')
  })

  // The OAuth return's one-time note stays first, as it was before the banner moved.
  it('keeps the OAuth notice above the banner', async () => {
    results.plaid_items = { data: [storedItem({ status: 'temporarily_unavailable' })], error: null }
    const tree = await DashboardPage({ searchParams: Promise.resolve({ notice: 'Bank connected.' }) })
    const order = blocks(tree)
    expect(textOf(order[0]).trim()).toBe('Bank connected.')
    expect(order[1].type).toBe(NotSyncingBanner)
  })
})

// Whether `type` is rendered anywhere in the tree the page returned.
function renders(node: unknown, type: unknown): boolean {
  return findElement(node, type) !== null
}

// The first element of `type` in the tree, with the props the page gave it.
function findElement(node: unknown, type: unknown): { props: Record<string, unknown> } | null {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findElement(n, type)
      if (found) return found
    }
    return null
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> }
  if (el.type === type) return el as { props: Record<string, unknown> }
  return el.props ? findElement(el.props.children, type) : null
}

// What the empty-state card says, its heading, line and button label in order, and the card.
function emptyCard(tree: unknown): { text: string; card: unknown } {
  const card = blocks(tree).find((b) => b.type === Card)
  if (!card) throw new Error('the page rendered no card')
  return { text: textOf(card).replace(/\s+/g, ' ').trim(), card }
}

// #164: the exchange route keeps a bank whose first balance pull failed, and says to press Refresh.
// Until the balances arrive it has no accounts. Read as "no bank", the page offered Connect, which
// would link the same bank again and spend one of ten lifetime connections (#51).
describe('Dashboard before a bank\'s balances arrive (#164)', () => {
  beforeEach(() => {
    results.accounts = { data: [], error: null }
  })

  it('says the balances are on their way, and offers Refresh instead of Connect', async () => {
    results.plaid_items = { data: [storedItem()], error: null }
    const tree = await render()
    const text = textOf(tree).replace(/\s+/g, ' ')
    expect(text).toContain('Your balances are on their way')
    expect(text).toContain("Capital One is connected, but its balances haven't arrived yet. Press Refresh to fetch them.")
    expect(text).not.toContain('Connect your first account')
    expect(renders(tree, RefreshButton)).toBe(true)
    expect(renders(tree, LinkButton)).toBe(false)
  })

  it('counts several banks whose balances have not arrived', async () => {
    results.plaid_items = { data: [storedItem(), storedItem({ id: 'item-2', institution_name: 'Amex', created_at: '2026-07-15T09:00:00Z' })], error: null }
    expect(textOf(await render()).replace(/\s+/g, ' ')).toContain(
      "2 banks are connected, but their balances haven't arrived yet."
    )
  })

  it('says "Your bank" when the bank has no name', async () => {
    results.plaid_items = { data: [storedItem({ institution_name: null })], error: null }
    expect(textOf(await render()).replace(/\s+/g, ' ')).toContain(
      "Your bank is connected, but its balances haven't arrived yet."
    )
  })

  // Refresh skips a bank whose login broke, so the banner's "reconnect in Settings" has to be there
  // too, first, as it is above the figures.
  it("warns above the header when that bank isn't syncing either", async () => {
    results.plaid_items = { data: [storedItem({ status: 'needs_reconnect' })], error: null }
    const tree = await render()
    expect(bannerText(tree)).toBe(
      "Capital One isn't syncing — reconnect in Settings to resume. These figures may be out of date."
    )
    const order = blocks(tree).map((b) => b.type)
    expect(order.indexOf(NotSyncingBanner)).toBe(0)
    expect(order.indexOf(PageHeader)).toBe(1)
  })

  // #172: a bank that isn't syncing can't be counted on to send its balances. Refresh skips a broken
  // login and retries the rest without fixing what stopped them, so "on their way" and "Press
  // Refresh" would be a promise it can't keep. The card promises nothing and points to Settings,
  // and still never offers Connect.
  it.each(['needs_reconnect', 'config_error', 'action_at_bank', 'temporarily_unavailable'])(
    'promises nothing for a bank that is %s, and points to Settings instead of Refresh',
    async (status) => {
      results.plaid_items = { data: [storedItem({ status })], error: null }
      const tree = await render()
      const { text, card } = emptyCard(tree)
      expect(text).toBe(
        "Your bank needs attention Capital One is connected, but its balances can't arrive until it's sorted out in Settings. Go to Settings"
      )
      expect(findElement(card, Link)?.props.href).toBe('/settings')
      expect(renders(tree, RefreshButton)).toBe(false)
      expect(renders(tree, LinkButton)).toBe(false)
    }
  )

  it('says how many banks need attention when none of them is syncing', async () => {
    results.plaid_items = {
      data: [storedItem({ status: 'needs_reconnect' }), storedItem({ id: 'item-2', institution_name: 'Amex', status: 'config_error' })],
      error: null,
    }
    expect(emptyCard(await render()).text).toBe(
      "Your banks need attention 2 banks are connected, but their balances can't arrive until they're sorted out in Settings. Go to Settings"
    )
  })

  // With both kinds, the card speaks only for the bank that is syncing; the banner, first, for the
  // one that isn't.
  it('with one bank syncing and one not, promises balances only for the one syncing', async () => {
    results.plaid_items = {
      data: [storedItem(), storedItem({ id: 'item-2', institution_name: 'Amex', status: 'needs_reconnect', created_at: '2026-07-15T09:00:00Z' })],
      error: null,
    }
    const tree = await render()
    expect(emptyCard(tree).text).toBe(
      "Your balances are on their way Capital One is connected, but its balances haven't arrived yet. Press Refresh to fetch them."
    )
    expect(renders(tree, RefreshButton)).toBe(true)
    expect(renders(tree, LinkButton)).toBe(false)
    expect(bannerText(tree)).toBe("Amex isn't syncing — reconnect in Settings to resume. These figures may be out of date.")
  })

  it('still offers Connect to a household with no banks at all', async () => {
    const tree = await render()
    expect(textOf(tree)).toContain('Connect your first account')
    expect(renders(tree, LinkButton)).toBe(true)
    expect(renders(tree, RefreshButton)).toBe(false)
  })

  // Another household's bank, or this household's from the other Plaid environment, is not this
  // household's bank waiting for balances.
  it("still offers Connect when the only banks are another household's or the other environment's", async () => {
    results.plaid_items = { data: FOREIGN_ITEMS, error: null }
    const tree = await render()
    expect(textOf(tree)).toContain('Connect your first account')
    expect(renders(tree, LinkButton)).toBe(true)
  })

  it('greets by the household\'s hour here too', async () => {
    results.plaid_items = { data: [storedItem()], error: null }
    const text = textOf(await render())
    expect(text).toContain('Good evening')
    expect(text).toContain('Wednesday, September 2')
  })
})

// #170: the same state with another bank's accounts in. Net worth and cash on hand are sums over
// accounts, so they leave the new bank out and look complete. A note says so, with the notices
// above the header, and the figures stay.
describe("Dashboard before a second bank's balances arrive (#170)", () => {
  const amex = (over: Record<string, unknown> = {}) =>
    storedItem({ id: 'item-2', institution_name: 'Amex', created_at: '2026-07-15T09:00:00Z', ...over })

  it("notes the bank whose balances haven't arrived, after the banner and before the header", async () => {
    results.plaid_items = { data: [storedItem(), amex()], error: null }
    const tree = await render()
    expect(balancesNote(tree)).toEqual({
      text: "Amex is connected, but its balances haven't arrived yet. Press Refresh to fetch them.",
      refresh: true,
    })
    const order = blocks(tree).map((b) => b.type)
    expect(order.indexOf(MissingBalancesNote)).toBe(order.indexOf(NotSyncingBanner) + 1)
    expect(order.indexOf(MissingBalancesNote)).toBeLessThan(order.indexOf(PageHeader))
    expect(findStatCards(tree).map((c) => c.props.label)).toContain('Net worth')
  })

  // The bank comes before the house: a reminder to update a figure that is in can wait for one that
  // is missing.
  it('comes before the home value reminder', async () => {
    results.plaid_items = { data: [storedItem(), amex()], error: null }
    results.manual_assets = { data: [{ id: 'm1', name: 'Home', value: 500000, updated_at: '2026-07-01T00:00:00Z' }], error: null }
    const tree = await render()
    const kids = blocks(tree)
    const home = kids.findIndex((b) => textOf(b).includes('Your home value was last updated'))
    expect(home).toBeGreaterThan(-1)
    expect(kids.findIndex((b) => b.type === MissingBalancesNote)).toBe(home - 1)
  })

  // Another household's bank, or this household's from the other Plaid environment, has no
  // accounts here either, and is not this household's bank.
  it('says nothing while every one of the household\'s banks has its accounts', async () => {
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(balancesNote(await render())).toBeNull()
  })

  // Refresh skips a broken login, so the note promises nothing and the banner above it sends the
  // reader to Settings.
  it("promises nothing for a bank that isn't syncing, and offers no Refresh", async () => {
    results.plaid_items = { data: [storedItem(), amex({ status: 'needs_reconnect' })], error: null }
    const tree = await render()
    expect(balancesNote(tree)).toEqual({
      text: "Amex is connected, but its balances can't arrive until it's sorted out in Settings.",
      refresh: false,
    })
    expect(bannerText(tree)).toBe("Amex isn't syncing — reconnect in Settings to resume. These figures may be out of date.")
  })
})

describe('Dashboard average savings (#126)', () => {
  // REPORTED is 2026-09-02 in New York, so September is in progress. The fixture runs March to
  // September: March saves $8,000 and April to August $2,000 each.
  const month = (m: string, income: number, spend: number) => [
    { id: `${m}-in`, amount: -income, date: `2026-${m}-10`, user_category: null, pfc_primary: 'INCOME', pfc_detailed: null, reimbursable_amount: null },
    { id: `${m}-out`, amount: spend, date: `2026-${m}-12`, user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null },
  ]
  const income = { data: [{ id: 'c1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 }], error: null }
  const fixture = (savings: Record<string, number> = {}) => ({
    data: [
      // $10,000 in each month; spending is whatever leaves the month's saving.
      ...['03', '04', '05', '06', '07', '08'].flatMap((m) => month(m, 10000, 10000 - (savings[m] ?? (m === '03' ? 8000 : 2000)))),
      ...month('09', 0, 5000),
    ],
    error: null,
  })
  const savedTile = async () => findStatCards(await render()).find((c) => c.props.label === 'Saved this month')!
  const avgLine = async () => {
    const foot = (await savedTile()).props.foot
    const spans = (foot as { props: { children: unknown[] } }).props.children.filter(Boolean) as {
      props: { className: string; children: string }
    }[]
    return spans.find((sp) => typeof sp.props.children === 'string' && sp.props.children.startsWith('Avg'))
  }

  // History from February: March to August qualify, (8,000 + 5 x 2,000) / 6. A window one month
  // short would drop March and read $2,000.
  it('shows the mean over the complete months, and how many', async () => {
    results.categories = income
    results.transactions = fixture()
    history.value = { kind: 'ready', month: '2026-02' }
    expect((await avgLine())!.props.children).toBe('Avg $3,000/mo · 6 mo')
  })

  // The start comes from historyStart, not from the earliest row the page happened to read: here
  // the page read rows from March, but history is only complete from May.
  it('starts where historyStart says, not at the earliest transaction it read', async () => {
    results.categories = income
    results.transactions = fixture()
    history.value = { kind: 'ready', month: '2026-05' }
    expect((await avgLine())!.props.children).toBe('Avg $2,000/mo · 3 mo')
  })

  it.each([
    ['history is in but no full month has followed it', { kind: 'ready', month: '2026-08' }],
    ['a bank has not delivered its history yet', { kind: 'pending', itemId: 'item-1' }],
    ['there are no transactions', { kind: 'none' }],
  ] as const)('shows no line when %s', async (_, state) => {
    results.categories = income
    results.transactions = fixture()
    history.value = state
    expect(await avgLine()).toBeUndefined()
  })

  it('is coral when the household loses money on average, and only then', async () => {
    results.categories = income
    history.value = { kind: 'ready', month: '2026-02' }
    results.transactions = fixture({ '03': -2000, '04': -2000, '05': -2000, '06': -2000, '07': -2000, '08': -2000 })
    const losing = (await avgLine())!
    expect(losing.props.children).toBe('Avg -$2,000/mo · 6 mo')
    expect(losing.props.className).toContain('text-coral')

    results.transactions = fixture()
    expect((await avgLine())!.props.className).not.toContain('text-coral')
  })

  // A few cents below zero rounds to "$0"; a red $0 would be noise.
  it('is not coral when the average rounds to zero', async () => {
    results.categories = income
    history.value = { kind: 'ready', month: '2026-07' }
    results.transactions = fixture({ '08': -0.3 })
    const line = (await avgLine())!
    expect(line.props.className).not.toContain('text-coral')
  })

  // The tile links to /breakdown/saved, and the two must tell the same story. One fixture, one
  // history state, both pages.
  it('agrees with the saved breakdown it links to', async () => {
    results.categories = income
    results.transactions = fixture({ '05': 3100, '07': -450.4 })
    history.value = { kind: 'ready', month: '2026-03' }
    const tile = (await avgLine())!.props.children
    const breakdown = await BreakdownPage({ params: Promise.resolve({ metric: 'saved' }) })
    const lists: { total?: { amount: number }; rows: unknown[] }[] = []
    ;(function walk(n: unknown) {
      if (n == null || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      const el = n as { type?: unknown; props?: Record<string, unknown> }
      if (el.type === BreakdownList) lists.push(el.props as never)
      else if (el.props) walk(el.props.children)
    })(breakdown)
    const avg = lists[1]
    expect(tile).toBe(`Avg ${moneyWhole(avg.total!.amount)}/mo · ${avg.rows.length} mo`)
  })

  // On a phone the three figures are rows in one card (components/ui/StatRows), not tiles. Both
  // ship in one server-rendered document and CSS picks, so they must carry the same figures.
  const phoneRows = async () => {
    const tree = await render()
    const found: { rows: { label: string; amount: number; href: string; tone?: string; foot?: unknown }[] }[] = []
    ;(function walk(n: unknown) {
      if (n == null || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      const el = n as { type?: { name?: string }; props?: Record<string, unknown> }
      if (el.type?.name === 'StatRows') found.push(el.props as never)
      else if (el.props) walk(el.props.children)
    })(tree)
    return { tree, rows: found[0].rows }
  }

  it('gives the phone rows the same figures and links as the tiles', async () => {
    results.categories = income
    results.transactions = fixture()
    history.value = { kind: 'ready', month: '2026-02' }
    const { tree, rows } = await phoneRows()
    const tiles = findStatCards(tree).filter((c) => c.props.label !== 'Net worth')
    expect(rows.map((r) => [r.label, r.amount])).toEqual(tiles.map((t) => [t.props.label, t.props.amount]))
    expect(rows.map((r) => r.href)).toEqual(['/breakdown/cash', '/breakdown/spent', '/breakdown/saved'])
  })

  it('puts the average in the Saved row, and money in and out when there is no average', async () => {
    results.categories = income
    results.transactions = fixture()
    history.value = { kind: 'ready', month: '2026-02' }
    expect(textOf((await phoneRows()).rows[2].foot)).toContain('Avg $3,000/mo · 6 mo')

    history.value = { kind: 'pending', itemId: 'item-1' }
    const foot = textOf((await phoneRows()).rows[2].foot)
    expect(foot).not.toContain('Avg')
    expect(foot.replace(/\s+/g, ' ')).toContain('$0 in · $5,000 out')
  })

  // #135: every month since a bank broke is short of its transactions, so there is no average on
  // either layout. Neither has room to say why; the banner above names the bank, and the saved
  // breakdown gives the reason where the average would have been.
  it("shows no average while a bank isn't syncing, on the tile or the phone row", async () => {
    results.categories = income
    results.transactions = fixture()
    history.value = { kind: 'ready', month: '2026-02' }
    results.accounts = { data: [A1, A2], error: null }
    results.plaid_items = { data: [storedItem({ status: 'needs_reconnect' }), storedItem({ id: 'item-2', institution_name: 'Amex' })], error: null }
    expect(await avgLine()).toBeUndefined()
    const foot = textOf((await phoneRows()).rows[2].foot)
    expect(foot).not.toContain('Avg')
    expect(foot.replace(/\s+/g, ' ')).toContain('$0 in · $5,000 out')
  })

  // Only this household's banks count: a broken bank elsewhere leaves the average alone.
  it("keeps the average when only another household's bank, or one from the other environment, is broken", async () => {
    results.categories = income
    results.transactions = fixture()
    history.value = { kind: 'ready', month: '2026-02' }
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect((await avgLine())!.props.children).toBe('Avg $3,000/mo · 6 mo')
  })

  // #170: a second bank whose first balance pull failed has no accounts, so none of its
  // transactions either, and every month is short of it. Neither layout has room to say why; the
  // note above the header names the bank, and the saved breakdown gives the reason. The average
  // comes back once the bank has an account.
  it("shows no average while a bank's balances haven't arrived, on the tile or the phone row", async () => {
    results.categories = income
    results.transactions = fixture()
    history.value = { kind: 'ready', month: '2026-02' }
    results.plaid_items = {
      data: [storedItem(), storedItem({ id: 'item-2', institution_name: 'Amex', created_at: '2026-07-15T09:00:00Z' })],
      error: null,
    }
    expect(await avgLine()).toBeUndefined()
    expect(textOf((await phoneRows()).rows[2].foot)).not.toContain('Avg')

    results.accounts = { data: [A1, A2], error: null }
    expect((await avgLine())!.props.children).toBe('Avg $3,000/mo · 6 mo')
  })

  // Beside a whole-dollar figure, on a narrow row, the budget note is whole dollars too.
  it('gives the Spent row its budget note in whole dollars', async () => {
    results.categories = { data: [{ id: 'c2', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 }], error: null }
    results.budgets = { data: [{ category: 'Food & Drink', monthly_limit: 15000 }], error: null }
    results.transactions = { data: month('09', 0, 14289.44), error: null }
    expect(textOf((await phoneRows()).rows[1].foot)).toContain('$14,289 of $15,000 budgeted')
  })

  // The tiles show exact cents from md up. budgetFoot takes its formatter, so handing the tile the
  // phone's whole-dollar one is an easy slip; this is the test that catches it.
  it('keeps the Spent and Saved tile notes exact', async () => {
    results.categories = { data: [{ id: 'c2', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 }], error: null }
    results.budgets = { data: [{ category: 'Food & Drink', monthly_limit: 15000 }], error: null }
    results.transactions = { data: month('09', 0, 14289.44), error: null }
    const tiles = findStatCards(await render())
    expect(textOf(tiles.find((t) => t.props.label.startsWith('Spent'))!.props.foot)).toContain(
      '$14,289.44 of $15,000.00 budgeted'
    )
    expect(textOf(tiles.find((t) => t.props.label === 'Saved this month')!.props.foot).replace(/\s+/g, ' ')).toContain(
      '$0.00 in · $14,289.44 out'
    )
  })

  it('gives the Cash row its account count', async () => {
    expect(textOf((await phoneRows()).rows[0].foot).replace(/\s+/g, ' ')).toContain('In 1 account')
  })

  // Breaking even is not a loss: a $0 month stays ink.
  it('does not colour a break-even month coral', async () => {
    results.categories = income
    results.transactions = { data: month('09', 5000, 5000), error: null }
    const saved = (await phoneRows()).rows[2]
    expect(saved.amount).toBe(0)
    expect(saved.tone).toBe('ink')
  })

  it('colours the Saved row coral when the month lost money', async () => {
    results.categories = income
    results.transactions = fixture()
    const saved = (await phoneRows()).rows[2]
    expect(saved.amount).toBeLessThan(0)
    expect(saved.tone).toBe('coral')
  })

  // The tiles are the md-and-up layout and the rows the phone layout; CSS picks, so both wrappers
  // must carry their breakpoint class.
  it('hides the tiles below md and the rows from md up', async () => {
    const classes = classNamesOf(await render())
    expect(classes).toContain('hidden md:contents')
    expect(classes).toContain('md:hidden')
  })

  // The read is seven months; the chart under "Last 6 months" must still get six.
  it('still charts six months', async () => {
    results.categories = income
    results.transactions = fixture()
    const tree = await render()
    const chart = (function find(n: unknown): { props: { data: { key: string }[] } } | null {
      if (n == null || typeof n !== 'object') return null
      if (Array.isArray(n)) {
        for (const c of n) {
          const f = find(c)
          if (f) return f
        }
        return null
      }
      const el = n as { type?: { name?: string }; props?: { children?: unknown } }
      if (el.type?.name === 'SpendIncomeChart') return el as never
      return el.props ? find(el.props.children) : null
    })(tree)
    expect(chart!.props.data.map((d) => d.key)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'])
  })
})

describe('Dashboard reads', () => {
  // The one measured on real data. With no categories nothing maps to Income or Transfer, so the
  // exclusions in monthlyFlows never fire and a paycheck is counted as negative spending: "Spent"
  // reads -$1,796.70 and "Saved" +$1,796.70 where the truth is $3,929.35 and $1,796.70. That is a
  // number the reader would believe, which is worse than an error (#46).
  it('fails loudly when the categories read fails, rather than counting income as spending', async () => {
    results.categories = { data: null, error: { message: 'permission denied' } }
    await expect(render()).rejects.toThrow(/could not read categories: permission denied/)
  })

  // #28: a failed rules read rendered as "no rules" would quietly move every learned label back,
  // which is #46's failure in a new place.
  it('throws when the rules cannot be read', async () => {
    results.category_rules = { data: null, error: { message: 'boom' } }
    await expect(render()).rejects.toThrow(/could not read category rules/)
  })

  // #69: the six-month window passes PostgREST's 1,000-row cap near each month end. A plain read
  // against this stub gets the first 1,000 of these 1,050 one-dollar purchases, so "Spent" would
  // read $1,000.
  it('counts every transaction in the window, past the 1,000-row cap', async () => {
    paged.transactions = pagedTable(
      Array.from({ length: 1050 }, (_, i) => ({
        id: `t${String(i).padStart(5, '0')}`,
        date: `2026-09-0${1 + (i % 3)}`,
        amount: 1,
        user_category: null,
        pfc_primary: 'FOOD_AND_DRINK',
        pfc_detailed: null,
        reimbursable_amount: null,
      }))
    )
    const spent = findStatCards(await render()).find((c) => c.props.label.startsWith('Spent in'))
    expect(spent!.props.amount).toBeCloseTo(1050, 2)
  })

  it('fails loudly when a later page of the transactions read fails', async () => {
    paged.transactions = pagedTable(
      Array.from({ length: 1050 }, (_, i) => ({ id: `t${String(i).padStart(5, '0')}`, date: '2026-09-01' })),
      { failOnRequest: 2 }
    )
    await expect(render()).rejects.toThrow(/could not read transactions: boom/)
  })

  it('fails loudly when the transactions read fails, rather than reporting a spotless month', async () => {
    results.transactions = { data: null, error: { message: 'statement timeout' } }
    await expect(render()).rejects.toThrow(/could not read transactions: statement timeout/)
  })

  // Zero accounts renders "Connect your first account". A household with eleven of them being told
  // it has none is a more convincing failure than an error, not a smaller one.
  it('fails loudly when the accounts read fails, rather than offering to connect a first bank', async () => {
    results.accounts = { data: null, error: { message: 'connection reset' } }
    await expect(render()).rejects.toThrow(/could not read accounts: connection reset/)
  })

  it('fails loudly when the household read fails, rather than dropping the home value from net worth', async () => {
    results.memberships = { data: null, error: { message: 'permission denied' } }
    await expect(render()).rejects.toThrow(/could not read your household: permission denied/)
  })

  // #172: an account with no membership, which sign-in lets through when it cannot check
  // (lib/access.ts), has no household, so no banks and no home value. It renders, and reads neither:
  // both reads are set to fail here, so reading one would throw.
  it('renders for an account with no household, reading no banks and no home value', async () => {
    results.memberships = { data: null, error: null }
    results.accounts = { data: [], error: null }
    results.plaid_items = { data: null, error: { message: 'read for no household' } }
    results.manual_assets = { data: null, error: { message: 'read for no household' } }
    expect(textOf(await render())).toContain('Connect your first account')
  })

  // #91: the read one step below the household's. Rendered as no assets, net worth dropped by the
  // house's full value, because the mortgage is still subtracted as a live liability.
  it('fails loudly when the manual assets read fails, rather than dropping the house from net worth', async () => {
    results.manual_assets = { data: null, error: { message: 'statement timeout' } }
    await expect(render()).rejects.toThrow(/could not read manual assets: statement timeout/)
  })

  // #91: rendered as no banks, every bank looked fine, so the "isn't syncing" banner, which must
  // always be visible on this screen, disappeared with the stale figures still showing.
  it("fails loudly when the banks read fails, rather than hiding the isn't-syncing banner", async () => {
    results.plaid_items = { data: null, error: { message: 'statement timeout' } }
    await expect(render()).rejects.toThrow(/could not read linked banks: statement timeout/)
  })

  it('fails loudly when the budgets read fails, rather than reporting no budgets set', async () => {
    results.budgets = { data: null, error: { message: 'timeout' } }
    await expect(render()).rejects.toThrow(/could not read budgets: timeout/)
  })

  it('renders when every read succeeds', async () => {
    await expect(render()).resolves.toBeTruthy()
  })

  // §4: the tiles are treated by importance, not equally. jsdom does no layout, so what is
  // decidable here is that the hero tile exists and carries the figure that clipped twice.
  it('gives net worth the hero tile', async () => {
    results.accounts = {
      data: [{ id: 'a1', type: 'depository', current_balance: 1182885.15 }],
      error: null,
    }
    const tree = await render()
    const hero = findStatCards(tree).find((c) => c.props.label === 'Net worth')
    expect(hero).toBeTruthy()
    expect(hero!.props.variant).toBe('hero')
    expect(hero!.props.amount).toBeCloseTo(1182885.15, 2)
  })

  // Pins which tiles are compact: exactly the three supporting figures. Filtering on `!== 'hero'`
  // would have stayed green if every tile lost its variant. What that variant then does about
  // rounding is stat-card.test.tsx's business, not this file's.
  it('leaves the other three tiles compact', async () => {
    const labels = findStatCards(await render())
      .filter((c) => c.props.variant === 'compact')
      .map((c) => c.props.label)
    expect(labels).toContain('Cash on hand')
    expect(labels).toContain('Saved this month')
    expect(labels.some((l: string) => l.startsWith('Spent in'))).toBe(true)
  })

  // A negative month turns the "Saved this month" figure red. The rule shipped on `main` as a
  // `<span className="text-coral">` the caller wrapped the figure in; this stage rewired it into a
  // `tone` prop, and deleting that prop outright passed all 476 tests — the red would have gone
  // silently. Asserted on the prop, because the colour is now the tile's to apply.
  it('tones the saved tile by the sign of the month', async () => {
    const outflow = {
      id: 't1',
      name: 'RENT',
      merchant_name: null,
      amount: 2400, // Plaid: positive is money out
      date: '2026-09-01',
      user_category: null,
      pfc_primary: null,
      pfc_detailed: null,
      reimbursable_amount: null,
    }
    // No categories seeded, so nothing maps to Income: the outflow is pure spending, income is 0
    // and saved comes out at -2400.
    results.transactions = { data: [outflow], error: null }
    const overspent = findStatCards(await render()).find((c) => c.props.label === 'Saved this month')
    expect(overspent!.props.tone).toBe('coral')

    // The other direction needs a category that maps INCOME, or the inflow reads as a refund
    // against spending rather than as money in: saved is then +2600.
    results.categories = {
      data: [{ id: 'c1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 }],
      error: null,
    }
    results.transactions = {
      data: [
        outflow,
        { ...outflow, id: 't2', name: 'PAYROLL', amount: -5000, pfc_primary: 'INCOME' },
      ],
      error: null,
    }
    const saved = findStatCards(await render()).find((c) => c.props.label === 'Saved this month')
    expect(saved!.props.tone).toBe('ink')
  })

  // Rounding is display-only. The tile is handed the real figure and decides for itself; a
  // pre-rounded value here would round the desktop layout too.
  it('hands the tiles unrounded figures', async () => {
    results.accounts = {
      data: [{ id: 'a1', type: 'depository', current_balance: 34920.49 }],
      error: null,
    }
    const cash = findStatCards(await render()).find((c) => c.props.label === 'Cash on hand')
    expect(cash!.props.amount).toBeCloseTo(34920.49, 2)
  })

  // The page's half of the presentTransaction fold. recent-activity.test.tsx builds its own items,
  // so nothing else covers this map: a page that went back to handing the list the raw Plaid amount,
  // or that re-derived the merchant fallback and the card-payment call for itself, would ship green.
  it('hands recent activity presented rows rather than raw Plaid ones', async () => {
    results.transactions = {
      data: [
        {
          id: 'r1',
          // The two label sources differ ON PURPOSE. With merchant_name null they are the same
          // string, and re-deriving `merchant_name ?? name ?? 'Transaction'` on the page — the
          // duplication this task removed — is then indistinguishable from taking p.label.
          name: 'JOE S DEN',
          merchant_name: 'Joe S Den',
          amount: -7866.69, // Plaid: negative is money in, and this leg only looks like income
          date: '2026-09-01',
          user_category: null,
          pfc_primary: 'LOAN_PAYMENTS',
          pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
          reimbursable_amount: null,
        },
        {
          // The other leg of the fallback: no merchant, so the raw name has to come through.
          id: 'r2',
          name: 'CAPITAL ONE AUTOPAY PYMT',
          merchant_name: null,
          amount: 42,
          date: '2026-08-31',
          user_category: null,
          pfc_primary: null,
          pfc_detailed: null,
          reimbursable_amount: null,
        },
      ],
      error: null,
    }
    expect(recentItemsOf(await render())).toEqual([
      {
        id: 'r1',
        date: '2026-09-01',
        category: 'Uncategorized', // no categories seeded, so PFC maps to nothing
        label: 'Joe S Den', // the merchant, not the raw name
        display: 7866.69,
        tone: 'neutral',
        isInternal: true,
      },
      {
        id: 'r2',
        date: '2026-08-31',
        category: 'Uncategorized',
        label: 'CAPITAL ONE AUTOPAY PYMT', // no merchant, so the raw name
        display: -42,
        tone: 'out',
        isInternal: false,
      },
    ])
  })

  // The fixture above cannot catch the page re-deriving the label, because the expression it would
  // re-derive — `merchant_name ?? name ?? 'Transaction'` — IS presentTransaction's rule, so both
  // produce the same string for every input. Only the source can be distinguished, not the value:
  // this stamps the module's answer so a locally computed label cannot impersonate it. Restoring
  // the old duplication in activityItem (lib/category-views.ts) fails here and nowhere else.
  it('takes the row label from presentTransaction rather than re-deriving the same rule', async () => {
    presentation.stampLabel = true
    results.transactions = {
      data: [
        {
          id: 'r1',
          name: 'JOE S DEN',
          merchant_name: 'Joe S Den',
          amount: 42,
          date: '2026-09-01',
          user_category: null,
          pfc_primary: null,
          pfc_detailed: null,
          reimbursable_amount: null,
        },
      ],
      error: null,
    }
    expect(recentItemsOf(await render())![0].label).toBe('presented:Joe S Den')
  })

  // #28 spec §7.2: Recent activity names a row through resolveCategory, as every total does, so a
  // rule relabels it here too rather than leaving the dashboard on the bank's Food & Drink.
  it('labels Safeway Grocery in Recent activity', async () => {
    results.categories = {
      data: [
        { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 },
        { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 },
      ],
      error: null,
    }
    results.category_rules = {
      data: [{ id: 'r-safeway', household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c-grocery', origin: 'seeded' }],
      error: null,
    }
    results.transactions = {
      data: [
        {
          id: 'r1',
          name: 'SAFEWAY #123',
          merchant_name: 'Safeway',
          amount: 42,
          date: '2026-09-01',
          user_category: null,
          pfc_primary: 'FOOD_AND_DRINK',
          pfc_detailed: null,
          reimbursable_amount: null,
        },
      ],
      error: null,
    }
    expect(recentItemsOf(await render())![0].category).toBe('Grocery')
  })

  // Spec §14.3/§14.7: a Whole Foods row with no rule takes Jev's confident suggestion, in Recent
  // activity and in the Spent figure's budget, and only while CATEGORY_SUGGESTIONS is on.
  describe('Jev suggestions', () => {
    const FOOD = { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }
    const GROCERY = { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 }
    const wholeFoods = (suggestion: unknown) => ({
      id: 'r2', name: 'WHOLEFDS #10', merchant_name: 'Whole Foods', amount: 30, date: '2026-09-01',
      user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null, suggestion,
    })
    const seed = (rows: unknown[]) => {
      results.categories = { data: [FOOD, GROCERY], error: null }
      results.category_rules = { data: [], error: null }
      results.transactions = { data: rows, error: null }
      // Budgeted on Grocery only, so the Spent tile's note moves with the row's category.
      results.budgets = { data: [{ category: 'Grocery', monthly_limit: 100 }], error: null }
    }
    const spentFoot = (tree: unknown) =>
      textOf(findStatCards(tree).find((c) => c.props.label.startsWith('Spent in'))!.props.foot)

    it('labels Whole Foods Grocery through its suggestion when suggestions are on', async () => {
      vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
      seed([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
      const tree = await render()
      expect(recentItemsOf(tree)![0].category).toBe('Grocery')
      expect(spentFoot(tree)).toContain('$30.00 of $100.00 budgeted')
    })

    it('leaves Whole Foods Food & Drink when suggestions are off', async () => {
      vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
      seed([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
      const tree = await render()
      expect(recentItemsOf(tree)![0].category).toBe('Food & Drink')
      expect(spentFoot(tree)).toContain('$0.00 of $100.00 budgeted')
    })

    // Review Focus 5: switching on changes nothing for rows that carry no suggestion.
    it('renders the same with the switch on as off when no row has a suggestion', async () => {
      const shown = async () => {
        seed([wholeFoods(null)])
        const tree = await render()
        return { recent: recentItemsOf(tree)!.map((i) => i.category), foot: spentFoot(tree) }
      }
      vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
      const on = await shown()
      vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
      const off = await shown()
      expect(on.recent).toEqual(['Food & Drink'])
      expect(on).toEqual(off)
    })

    // Spec §7.4's coverage guard: both transactions reads (the window and Recent activity) carry
    // the embed.
    it('selects each transaction\'s suggestion in both reads', async () => {
      seed([wholeFoods(null)])
      await render()
      expect(new Set(selects.transactions).size).toBe(2)
      for (const cols of selects.transactions) expect(cols).toContain('category_suggestions(')
    })
  })

  // The stage's entire visible payload is these two class strings and nothing else asserts them.
  // Reverting the outer container to the old single grid, or dropping `md:contents` from the
  // inner row — which crushes the three tiles into one cell at desktop — both passed the whole
  // file before this test existed. jsdom computes no layout, so the strings ARE the evidence.
  it('keeps the hero-plus-row container structure', async () => {
    const classes = classNamesOf(await render())
    expect(classes).toContain('space-y-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0 lg:grid-cols-4')
    // Below md the tiles give way to StatRows (see "hides the tiles below md…"); from md up they
    // must still be direct grid children, or the three crush into one cell.
    expect(classes).toContain('hidden md:contents')
  })
})

describe('Dashboard clock', () => {
  // The reported bug, exactly.
  it('greets by the household\'s hour, not the server\'s', async () => {
    const text = textOf(await render())
    expect(text).toContain('Good evening')
    expect(text).not.toContain('Good morning')
  })

  it('dates the page by the household\'s day, not the server\'s', async () => {
    const text = textOf(await render())
    expect(text).toContain('Wednesday, September 2')
    expect(text).not.toContain('September 3')
  })

  // The half that actually matters: at 8pm on 31 August the server is already in September, so
  // the tile would name a fresh month while August was still running.
  it('names the household\'s month on the spending tile', async () => {
    vi.setSystemTime(new Date('2026-09-01T00:10:00Z')) // 8:10pm on 31 August in New York
    const text = textOf(await render())
    expect(text).toContain('Spent in August')
    expect(text).not.toContain('Spent in September')
  })

  it('follows the stored zone rather than a hardcoded one', async () => {
    tz.value = 'Asia/Tokyo' // 9:10am on the 3rd
    const text = textOf(await render())
    expect(text).toContain('Good morning')
    expect(text).toContain('Thursday, September 3')
  })

  // The empty-account state has its own PageHeader, built the same way but reached by a different
  // branch (accounts.length === 0) — a regression there would not be caught by any test above,
  // which all render with the one seeded account from beforeEach.
  it('greets by the household\'s hour on the empty-account state too', async () => {
    results.accounts = { data: [], error: null }
    const text = textOf(await render())
    expect(text).toContain('Good evening')
    expect(text).not.toContain('Good morning')
  })
})
