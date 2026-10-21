import { describe, it, expect, beforeEach, vi } from 'vitest'

const { results, tz, gates, started } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  tz: { value: 'America/New_York' },
  // Reads a test holds open until it lets go, by name, and every read the page has started, so a
  // test can tell a read made beside another from one made after it (#156).
  gates: {} as Record<string, Promise<void>>,
  started: [] as string[],
}))

const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'not', 'gte', 'lte', 'limit']) chain[m] = () => chain
  // maybeSingle only. Null data and no error is its answer for no row; .single() makes no row an
  // error (PGRST116), which a stand-in answering null would hide (#172).
  chain.maybeSingle = async () => {
    started.push(table)
    await gates[table]
    return results[table] ?? { data: null, error: null }
  }
  chain.then = (resolve: (v: unknown) => unknown) => {
    started.push(table)
    return Promise.resolve(gates[table])
      .then(() => results[table] ?? { data: [], error: null })
      .then(resolve)
  }
  return chain
}

// The signed-in client refuses plaid_items, which RLS gives it no rows of (#169).
vi.mock('@/lib/supabase/server', async () => {
  const { refuseSignedInPlaidItems } = await import('../stubs/plaid-items')
  return {
    createClient: async () => ({
      from: (table: string) => {
        refuseSignedInPlaidItems(table)
        return chainFor(table)
      },
    }),
  }
})
// The service-role client reads only plaid_items here, for the "isn't syncing" banner (#171),
// through the strict stand-in in tests/stubs/plaid-items.ts: it applies the read's filters to the
// stored rows, so the banner shows only this household's banks. lib/plaid-items.ts runs for real,
// and needs only plaidEnv from lib/plaid.
vi.mock('@/lib/supabase/admin', async () => {
  const { plaidItemsQuery } = await import('../stubs/plaid-items')
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table !== 'plaid_items') throw new Error(`reimbursements page read ${table} through the service-role client`)
        started.push(table)
        return plaidItemsQuery(results.plaid_items ?? { data: [], error: null }, gates.plaid_items)
      },
    },
  }
})
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
// The real module but for the timezone, so currentHouseholdId reads `results.memberships`.
vi.mock('@/lib/household', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/household')>()),
  householdTimezone: async () => {
    started.push('timezone')
    await gates.timezone
    return tz.value
  },
}))

import ReimbursementsPage from '@/app/(app)/reimbursements/page'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import { PageHeader } from '@/components/ui/PageHeader'
import { blocks, bannerText } from './helpers/banner'
import { storedItem, FOREIGN_ITEMS } from '../stubs/plaid-items'

const render = () => ReimbursementsPage()

// Holds the read named `name` open until the test lets it go.
function hold(name: string): () => void {
  let release!: () => void
  gates[name] = new Promise<void>((resolve) => (release = resolve))
  return release
}
// One turn of the event loop, so every read the page can start without the held ones has started.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// Collect every className in the returned tree. jsdom computes no layout, so the class strings are
// the only evidence the two layouts are gated on the breakpoint at all.
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

// Collect the ReimbursementCard elements so assertions can read their props directly.
type CardProps = { label: string; amount: number; date: string; note?: string | null; currentYear: string }
function cardsOf(node: unknown): { props: CardProps }[] {
  const found: { props: CardProps }[] = []
  const walk = (n: unknown) => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    const el = n as { type?: unknown; props?: { children?: unknown } }
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'ReimbursementCard') {
      found.push(el as unknown as { props: CardProps })
    }
    if (el.props?.children) walk(el.props.children)
  }
  walk(node)
  return found
}

// The subtitle the page hands its PageHeader.
function subtitleOf(node: unknown): unknown {
  let found: unknown
  const walk = (n: unknown) => {
    if (found !== undefined || n == null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    const el = n as { type?: unknown; props?: { subtitle?: unknown; children?: unknown } }
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'PageHeader') {
      found = el.props?.subtitle
      return
    }
    if (el.props?.children) walk(el.props.children)
  }
  walk(node)
  return found
}

// The nearest enclosing className for every <table> and every ReimbursementCard in the tree.
//
// A page-wide `toContain('md:hidden')` is NOT evidence that both sections are gated: the page ships
// two of each wrapper, so stripping the covered section's wrappers entirely leaves the outstanding
// section's copies to satisfy it. That mutation survived until this walked per element.
function gatesOf(node: unknown): { tables: string[]; cards: string[] } {
  const tables: string[] = []
  const cards: string[] = []
  const walk = (n: unknown, gate: string) => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      n.forEach((c) => walk(c, gate))
      return
    }
    const el = n as { type?: unknown; props?: { className?: unknown; children?: unknown } }
    // Read the gate the ancestors established BEFORE this element's own className replaces it —
    // the table carries `w-full text-sm` itself, and it is the wrapper around it that must gate.
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'ReimbursementCard') {
      cards.push(gate)
    }
    if (el.type === 'table') tables.push(gate)
    const next = typeof el.props?.className === 'string' ? el.props.className : gate
    if (el.props?.children) walk(el.props.children, next)
  }
  walk(node, '')
  return { tables, cards }
}

// Two marked expenses. The $40 one is settled outright by its own $40 deposit, so it drops out of
// the outstanding list and renders under "Already reimbursed" — without it the covered section
// never renders at all and every assertion below only ever reaches the outstanding one.
//
// The $100 one is half covered by the $50 deposit: `remaining` is 50 while the marked amount is
// 100. That gap is exactly what the outstanding card must not get wrong. FIFO allocates on amounts
// oldest-first, so the August expense consumes its own $40 and leaves $50 for September.
beforeEach(() => {
  for (const k of Object.keys(gates)) delete gates[k]
  started.length = 0
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.plaid_items = { data: [], error: null }
  results.transactions = {
    data: [
      {
        id: 'e1',
        amount: 100,
        date: '2026-09-01',
        name: 'STARBUCKS STORE 123',
        merchant_name: 'Starbucks',
        reimbursable_amount: 100,
        reimbursable_note: 'Dave',
      },
      {
        id: 'd1',
        amount: -50,
        date: '2026-09-05',
        name: 'ACME EXPENSES',
        merchant_name: null,
        reimbursable_amount: 50,
        reimbursable_note: null,
      },
      {
        id: 'e0',
        amount: 40,
        date: '2026-08-20',
        name: 'THE HOME DEPOT 4021',
        merchant_name: 'Home Depot',
        reimbursable_amount: 40,
        reimbursable_note: 'Dave',
      },
      {
        id: 'd0',
        amount: -40,
        date: '2026-08-25',
        name: 'ACME EXPENSES',
        merchant_name: null,
        reimbursable_amount: 40,
        reimbursable_note: null,
      },
    ],
    error: null,
  }
})

describe('Reimbursements page', () => {
  // The #73 mistake, on a new page: the year that matters is the HOUSEHOLD's. At this instant it
  // is already 1 January in UTC but still 31 December in New York, so a server-clock reading would
  // hand every card the wrong year and silently qualify dates that need no qualifying.
  it('takes the current year from the household clock, not the server', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T02:30:00Z'))
    tz.value = 'America/New_York'
    const years = cardsOf(await render()).map((c) => c.props.currentYear)
    expect(years.length).toBeGreaterThan(0)
    expect(new Set(years)).toEqual(new Set(['2026']))
    vi.useRealTimers()
  })

  it('follows the stored zone rather than a hardcoded one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T02:30:00Z'))
    tz.value = 'Asia/Tokyo' // already 1 January there
    const years = cardsOf(await render()).map((c) => c.props.currentYear)
    expect(new Set(years)).toEqual(new Set(['2027']))
    vi.useRealTimers()
  })

  // #46's lesson, already enforced for the read: a failed query must not render as "nothing owed".
  it('fails loudly when the read fails, rather than reporting nothing outstanding', async () => {
    results.transactions = { data: null, error: { message: 'connection reset' } }
    await expect(render()).rejects.toThrow(/could not read reimbursable transactions/)
  })

  // #159: only a marked deposit covers a marked expense, and nothing said to mark one, so a
  // repayment left unmarked kept its expense owed here for good.
  it('says to mark the deposit when the money comes back, while something is owed', async () => {
    expect(subtitleOf(await render())).toMatch(
      /^You're owed .+\. These are the expenses to put on your next report\. When it's paid back, mark that deposit reimbursable on Transactions too\.$/
    )
  })

  it('offers a card for the outstanding expense', async () => {
    const cards = cardsOf(await render())
    expect(cards.length).toBeGreaterThan(0)
    expect(cards[0].props.label).toBe('Starbucks')
  })

  // The card shows what is STILL OWED, not the full marked figure. The desktop table labels those
  // two columns differently on purpose; a card has no header to disambiguate them.
  it('shows the outstanding remainder on the card, not the whole marked amount', async () => {
    const card = cardsOf(await render())[0]
    expect(card.props.amount).toBe(50)
    expect(card.props.amount).not.toBe(100)
  })

  it('passes who owes it through to the card', async () => {
    expect(cardsOf(await render())[0].props.note).toBe('Dave')
  })

  // §6's third field, and the one nothing else pins: the card formats whatever date it is handed,
  // so a hardcoded or borrowed one renders as a perfectly ordinary date and no other assertion
  // notices. Both lists read it from their own row — the outstanding list from the allocation's
  // `r.date`, the covered list from the transaction's `t.date`.
  it('passes each row its own date', async () => {
    const cards = cardsOf(await render())
    const outstanding = cards.find((c) => c.props.label === 'Starbucks')
    const covered = cards.find((c) => c.props.label === 'Home Depot')
    expect(outstanding!.props.date).toBe('2026-09-01')
    expect(covered!.props.date).toBe('2026-08-20')
    // Not each other's, and not the deposits that settled them.
    expect(outstanding!.props.date).not.toBe(covered!.props.date)
  })

  // The covered list carries the FULL reimbursed figure, not a remainder — a settled expense's
  // remainder is 0, so passing the wrong one here renders every reimbursement as $0.00. This is
  // the same confusion the outstanding test above guards from the other side.
  it('shows the full reimbursed figure on a settled expense, not its remainder', async () => {
    const card = cardsOf(await render()).find((c) => c.props.label === 'Home Depot')
    expect(card).toBeDefined()
    expect(card!.props.amount).toBe(40)
    expect(card!.props.amount).not.toBe(0)
  })

  // Both layouts ship; CSS picks. Reverting either wrapper, in EITHER section, is the mutation this
  // catches — checked per element, because the page renders two of each wrapper and a page-wide
  // search is satisfied by whichever one survives.
  it('gates the table and the card list on the breakpoint', async () => {
    const tree = await render()
    const classes = classNamesOf(tree)
    expect(classes).toContain('md:hidden')
    expect(classes.some((c) => c.includes('hidden') && c.includes('md:block'))).toBe(true)

    const { tables, cards } = gatesOf(tree)
    // The outstanding list and one month of "Already reimbursed": both sections must be present,
    // or the per-element assertions below are vacuously true for the section that is missing.
    expect(tables).toHaveLength(2)
    expect(cards).toHaveLength(2)
    for (const gate of tables) {
      expect(gate).toContain('hidden')
      expect(gate).toContain('md:block')
    }
    for (const gate of cards) expect(gate).toContain('md:hidden')
  })
})

// The dashboard's banner, above what you're owed (#171). A repayment deposit at a bank that isn't
// syncing never arrives to cover its expense, so "You're owed" stays too high with nothing to say
// the figure may be out of date.
describe('Reimbursable banks (#171)', () => {
  it("warns that a bank isn't syncing, first, above the header", async () => {
    results.plaid_items = {
      data: [storedItem({ status: 'temporarily_unavailable' }), storedItem({ id: 'item-2', institution_name: 'Amex' }), ...FOREIGN_ITEMS],
      error: null,
    }
    const tree = await render()
    expect(bannerText(tree)).toBe("Capital One isn't syncing — see Settings. These figures may be out of date.")
    const order = blocks(tree).map((b) => b.type)
    expect(order.indexOf(NotSyncingBanner)).toBe(0)
    expect(order.indexOf(PageHeader)).toBe(1)
  })

  // Another household's broken bank, or this household's from the other Plaid environment, must
  // not raise the banner here.
  it("says nothing while every one of the household's banks is syncing", async () => {
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(bannerText(await render())).toBe('')
  })

  // Rendered as no banks, a failed read would show what you're owed with no warning (#46). It
  // throws, as the dashboard does, and app/(app)/error.tsx offers a retry.
  it('fails loudly when the banks read fails, rather than hiding the banner', async () => {
    results.plaid_items = { data: null, error: { message: 'statement timeout' } }
    await expect(render()).rejects.toThrow(/could not read linked banks: statement timeout/)
  })

  it('fails loudly when the household read fails, rather than hiding the banner', async () => {
    results.memberships = { data: null, error: { message: 'permission denied' } }
    await expect(render()).rejects.toThrow(/could not read your household: permission denied/)
  })

  // An account with no membership, which sign-in lets through when it cannot check
  // (lib/access.ts), has no household, so no banks. The page renders, as it did before it read
  // banks, and reads none: the read is set to fail here, so reading it would throw.
  it('renders for an account with no household, reading no banks', async () => {
    results.memberships = { data: null, error: null }
    results.plaid_items = { data: null, error: { message: 'read for no household' } }
    expect(bannerText(await render())).toBe('')
  })

  // #156: the bank list is two reads, the household and then its banks, and neither may wait for
  // the page's own, or the page's own for them. So both reads of each pair are held open at once,
  // and both must have started: had either waited for the other, it could not have.
  it("asks for the banks beside the page's own reads, neither waiting for the other", async () => {
    const first = [hold('timezone'), hold('memberships')]
    const second = [hold('transactions'), hold('plaid_items')]
    const page = render()
    await settle()
    expect(started).toContain('timezone')
    expect(started).toContain('memberships')
    first.forEach((release) => release())
    await settle()
    expect(started).toContain('transactions')
    expect(started).toContain('plaid_items')
    second.forEach((release) => release())
    await page
  })
})
