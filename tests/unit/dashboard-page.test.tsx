import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/trends-page.test.tsx: the static page import below
// is linked before this file's body runs, firing the mock factory.
const { results, tz, presentation } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  tz: { value: 'America/New_York' },
  presentation: { stampLabel: false },
}))

// A supabase query is a builder awaited at the end, so the stub returns itself for every chained
// method and resolves to whatever the test configured for that table.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'gte', 'lte', 'limit', 'not']) chain[m] = () => chain
  chain.single = async () => results[table] ?? { data: null, error: null }
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
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

import DashboardPage from '@/app/(app)/dashboard/page'

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
        isCC: true,
      },
      {
        id: 'r2',
        date: '2026-08-31',
        category: 'Uncategorized',
        label: 'CAPITAL ONE AUTOPAY PYMT', // no merchant, so the raw name
        display: -42,
        tone: 'out',
        isCC: false,
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
    expect(classes).toContain('grid grid-cols-3 gap-3 md:contents')
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
