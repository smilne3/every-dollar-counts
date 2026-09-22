import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/breakdown-page.test.tsx and
// tests/unit/dashboard-page.test.tsx: the static page import below is linked before this file's
// body runs, firing the mock factory.
const { results } = vi.hoisted(() => ({
  results: {} as Record<
    string,
    { data: unknown; count?: number; error: { message: string } | null }
  >,
}))

// A supabase query is a builder awaited at the end, so the stub returns itself for every chained
// method and resolves to whatever the test configured for that table. Same shape as the two page
// tests above; `range` and `or` are this page's additions, and the transactions read destructures
// `count` alongside `data` because it asks for { count: 'exact' }.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'gte', 'lt', 'lte', 'range', 'or', 'limit', 'not'])
    chain[m] = () => chain
  chain.single = async () => results[table] ?? { data: null, error: null }
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results[table] ?? { data: [], count: 0, error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
}))
// The two row components are client components. Nothing here RENDERS them — this test inspects the
// element tree the server component returns — but importing them still runs their module bodies.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

import TransactionsPage from '@/app/(app)/transactions/page'
import { TransactionCard } from '@/components/TransactionCard'
import { TransactionRow } from '@/components/TransactionRow'

type Params = { q?: string; account?: string; category?: string; month?: string; flow?: string; page?: string }
const render = (searchParams: Params = {}) =>
  TransactionsPage({ searchParams: Promise.resolve(searchParams) })

const txn = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den',
  amount: 100,
  date: '2026-08-29',
  user_category: null,
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: null,
  reimbursable_amount: null,
  reimbursable_note: null,
  ...over,
})

beforeEach(() => {
  results.categories = {
    data: [{ id: 'c1', name: 'Food', pfc_primary: 'FOOD_AND_DRINK', sort_order: 1 }],
    error: null,
  }
  results.transactions = {
    data: [
      txn({ id: 't1' }),
      txn({ id: 't2', user_category: 'Grocery' }),
      // The $7,866.69 shape. Both branches have to be handed it identically, because it is the one
      // row whose gating differs from every other.
      txn({
        id: 't3',
        amount: -7866.69,
        pfc_primary: 'LOAN_PAYMENTS',
        pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      }),
    ],
    count: 3,
    error: null,
  }
})

// A React element in the returned tree. `type` is 'div' for a host element and the component
// function itself for TransactionCard / TransactionRow, which is what lets the two be told apart
// by identity rather than by rendered markup.
type El = { type?: unknown; props?: Record<string, unknown> }

function isEl(n: unknown): n is El {
  return typeof n === 'object' && n !== null && 'props' in (n as object)
}

// Every element in the tree with how deep it sits, so "the div NEAREST the cards" can be picked
// out rather than the page's outermost div, which also contains them.
function walk(node: unknown, depth = 0, out: { el: El; depth: number }[] = []) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, depth, out)
    return out
  }
  if (!isEl(node)) return out
  out.push({ el: node, depth })
  walk(node.props?.children, depth + 1, out)
  return out
}

function innermostDivAround(all: { el: El; depth: number }[], child: unknown): El {
  const holders = all.filter(
    ({ el }) => el.type === 'div' && walk(el.props?.children).some((d) => d.el.type === child)
  )
  expect(holders.length).toBeGreaterThan(0)
  return holders.sort((a, b) => b.depth - a.depth)[0].el
}

const branches = async (params: Params = {}) => {
  const all = walk(await render(params))
  const cardWrap = innermostDivAround(all, TransactionCard)
  const tableWrap = innermostDivAround(all, TransactionRow)
  return {
    all,
    cardWrap,
    tableWrap,
    cards: walk(cardWrap.props?.children).filter((d) => d.el.type === TransactionCard).map((d) => d.el),
    rows: walk(tableWrap.props?.children).filter((d) => d.el.type === TransactionRow).map((d) => d.el),
  }
}

// This page is an async server component, so jsdom's lack of layout does not matter: the test calls
// the function and inspects the element tree it RETURNS, the way breakdown-page and dashboard-page
// already do.
//
// What this CANNOT do is prove the overlap on a 390px screen is gone. Whether the amount is painted
// over the category pill is a paint fact, and it still needs a human with a browser. What is pinned
// here is the CSS contract the fix rests on, and that the two branches are handed the same rows.
describe('Transactions page dual layout', () => {
  // The whole fix is these two strings. `md:hidden` with no base class means the cards show below
  // md; `hidden … md:block` means the table is absent, not merely overflowed, below it. Get either
  // wrong and both layouts paint at once, which is the bug this branch exists to fix.
  it('pins the exact class on each branch', async () => {
    const { cardWrap, tableWrap } = await branches()
    expect(cardWrap.props?.className).toBe('md:hidden')
    expect(tableWrap.props?.className).toBe('hidden overflow-x-auto md:block')
  })

  it('renders every fetched transaction on both branches', async () => {
    const { cards, rows } = await branches()
    expect(cards).toHaveLength(3)
    expect(rows).toHaveLength(3)
  })

  // The containment in tests/unit/transaction-card.test.tsx proves the two COMPONENTS agree given
  // the same props. That is worth nothing if the page hands them different props, which is the
  // seam this covers.
  it('hands both branches the same derived props for the same row', async () => {
    const { cards, rows } = await branches()
    for (const [i, card] of cards.entries()) {
      const row = rows[i]
      // Same object, not merely equal: the page maps one `list` twice, and anything that made it
      // map two different lists would show up here first.
      expect(card.props?.t).toBe(row.props?.t)
      expect(card.props?.categoryName).toBe(row.props?.categoryName)
      expect(card.props?.categoryOptions).toEqual(row.props?.categoryOptions)
    }
  })

  it('derives the category the same way for an override and for a PFC mapping', async () => {
    const { cards } = await branches()
    expect(cards.map((c) => c.props?.categoryName)).toEqual(['Food', 'Grocery', 'Uncategorized'])
  })

  // The in-memory filters rewrite `list` after the fetch. Both branches map that same `list`, so a
  // filtered view must shorten both or neither.
  it('keeps the two branches in step when a filter shortens the list', async () => {
    const { cards, rows } = await branches({ category: 'Grocery' })
    expect(cards).toHaveLength(1)
    expect(rows).toHaveLength(1)
    expect(cards[0].props?.t).toBe(rows[0].props?.t)
  })

  // Neither branch exists in the empty state, so a test that only ever saw the populated page could
  // not tell "both layouts" from "one layout twice".
  it('renders neither branch when there is nothing to show', async () => {
    results.transactions = { data: [], count: 0, error: null }
    const all = walk(await render())
    expect(all.some((d) => d.el.type === TransactionCard)).toBe(false)
    expect(all.some((d) => d.el.type === TransactionRow)).toBe(false)
  })

  // Same #46 reasoning as the dashboard and breakdown pages: "no transactions" and "we could not
  // read your transactions" must not look the same.
  it('fails loudly when the transactions read fails', async () => {
    results.transactions = { data: null, count: null as unknown as number, error: { message: 'statement timeout' } }
    await expect(render()).rejects.toThrow(/could not read transactions: statement timeout/)
  })

  it('fails loudly when the categories read fails', async () => {
    results.categories = { data: null, error: { message: 'permission denied' } }
    await expect(render()).rejects.toThrow(/could not read categories: permission denied/)
  })
})
