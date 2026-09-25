import { describe, it, expect, beforeEach, vi } from 'vitest'

const { results } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}))

const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'not', 'gte', 'lte', 'limit']) chain[m] = () => chain
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
}))

import ReimbursementsPage from '@/app/(app)/reimbursements/page'

const render = () => ReimbursementsPage()

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
type CardProps = { label: string; amount: number; date: string; note?: string | null }
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
  // #46's lesson, already enforced for the read: a failed query must not render as "nothing owed".
  it('fails loudly when the read fails, rather than reporting nothing outstanding', async () => {
    results.transactions = { data: null, error: { message: 'connection reset' } }
    await expect(render()).rejects.toThrow(/could not read reimbursable transactions/)
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
