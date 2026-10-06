import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/trends-page.test.tsx: the static page import below
// is linked before this file's body runs, firing the mock factory.
const { results, tz, presentation, paged, history } = vi.hoisted(() => ({
  // What lib/history-start answers. Mocked so these tests can tell a page that takes the history
  // start from historyStart apart from one that guesses it from its own transaction read: this
  // stub serves the whole fixture to every query, so the two would otherwise always agree.
  history: { value: { kind: 'none' } as { kind: 'ready'; month: string } | { kind: 'pending'; bank: string } | { kind: 'none' } },
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
  // readAllRows (lib/read-all.ts) asks for the rows after its cursor with .or(); there are none
  // past this fixture, so a continuation page is empty and the read ends.
  let afterCursor = false
  chain.or = () => {
    afterCursor = true
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
  createClient: async () => ({
    from: (table: string) =>
      table === 'transactions' && paged.transactions ? paged.transactions.query() : chainFor(table),
  }),
}))
vi.mock('@/lib/household', () => ({
  DEFAULT_TIMEZONE: 'America/New_York',
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
vi.mock('@/lib/plaid-items', () => ({ listItemsForHousehold: async () => [] }))
vi.mock('@/lib/manual-assets', () => ({ listManualAssets: async () => [] }))
vi.mock('@/lib/receivable', () => ({ fetchReceivable: async () => 0 }))
vi.mock('@/lib/history-start', () => ({ historyStart: async () => history.value }))

import { pagedTable } from '../stubs/postgrest-pages'
import DashboardPage from '@/app/(app)/dashboard/page'
import BreakdownPage from '@/app/(app)/breakdown/[metric]/page'
import { BreakdownList } from '@/components/BreakdownList'
import { moneyWhole } from '@/lib/format'

const render = () => DashboardPage({ searchParams: Promise.resolve({}) })

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
  results.accounts = { data: [{ id: 'a1', type: 'depository', current_balance: 100 }], error: null }
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.categories = { data: [], error: null }
  results.transactions = { data: [], error: null }
  results.budgets = { data: [], error: null }
  paged.transactions = null
  history.value = { kind: 'none' }
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
    ['a bank has not delivered its history yet', { kind: 'pending', bank: 'Capital One' }],
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

    history.value = { kind: 'pending', bank: 'Capital One' }
    const foot = textOf((await phoneRows()).rows[2].foot)
    expect(foot).not.toContain('Avg')
    expect(foot.replace(/\s+/g, ' ')).toContain('$0 in · $5,000 out')
  })

  // Beside a whole-dollar figure, on a narrow row, the budget note is whole dollars too.
  it('gives the Spent row its budget note in whole dollars', async () => {
    results.categories = { data: [{ id: 'c2', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 }], error: null }
    results.budgets = { data: [{ category: 'Food & Drink', monthly_limit: 15000 }], error: null }
    results.transactions = { data: month('09', 0, 14289.44), error: null }
    expect(textOf((await phoneRows()).rows[1].foot)).toContain('$14,289 of $15,000 budgeted')
  })

  it('colours the Saved row coral when the month lost money', async () => {
    results.categories = income
    results.transactions = fixture()
    const saved = (await phoneRows()).rows[2]
    expect(saved.amount).toBeLessThan(0)
    expect(saved.tone).toBe('coral')
  })

  // The tiles are the md-and-up layout; on a phone they must not render beside the rows.
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
  // the old duplication at page.tsx:176 fails here and nowhere else.
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
