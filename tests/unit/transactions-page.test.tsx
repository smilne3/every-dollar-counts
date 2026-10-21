import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/breakdown-page.test.tsx and
// tests/unit/dashboard-page.test.tsx: the static page import below is linked before this file's
// body runs, firing the mock factory.
const { results, selects, gates, started } = vi.hoisted(() => ({
  // Every `.select()` the page sends, per table, so a test can pin the suggestion embed (§7.4).
  selects: {} as Record<string, string[]>,
  results: {} as Record<
    string,
    { data: unknown; count?: number; error: { message: string } | null }
  >,
  // Reads a test holds open until it lets go, by name, and every read the page has started, so a
  // test can tell a read made beside another from one made after it (#156).
  gates: {} as Record<string, Promise<void>>,
  started: [] as string[],
}))

// A supabase query is a builder awaited at the end, so the stub returns itself for every chained
// method and resolves to whatever the test configured for that table. Same shape as the two page
// tests above; `range` and `or` are this page's additions, and the transactions read destructures
// `count` alongside `data` because it asks for { count: 'exact' }. An accounts read gets only the
// columns it selects, as from Postgres: the note needs each account's plaid_item_id (#170), and a
// read that dropped it would leave every bank looking as though none of its accounts had arrived.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  let columns: string[] = []
  for (const m of ['select', 'order', 'eq', 'gte', 'lt', 'lte', 'range', 'or', 'limit', 'not'])
    chain[m] = () => chain
  chain.select = (cols: string) => {
    (selects[table] ??= []).push(cols)
    columns = cols.split(',').map((c) => c.trim())
    return chain
  }
  const selected = (reply: { data: unknown; count?: number; error: unknown }) =>
    table === 'accounts' && Array.isArray(reply.data)
      ? { ...reply, data: (reply.data as Record<string, unknown>[]).map((r) => Object.fromEntries(columns.filter((c) => c in r).map((c) => [c, r[c]]))) }
      : reply
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
      .then(() => selected(results[table] ?? { data: [], count: 0, error: null }))
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
        if (table !== 'plaid_items') throw new Error(`transactions page read ${table} through the service-role client`)
        started.push(table)
        return plaidItemsQuery(results.plaid_items ?? { data: [], error: null }, gates.plaid_items)
      },
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
      started.push('categories')
      await gates.categories
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
// The two row components are client components. Nothing here RENDERS them — this test inspects the
// element tree the server component returns — but importing them still runs their module bodies.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

import TransactionsPage from '@/app/(app)/transactions/page'
import { MissingBalancesNote } from '@/components/MissingBalancesNote'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import { TransactionCard } from '@/components/TransactionCard'
import { TransactionRow } from '@/components/TransactionRow'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { catalogFingerprint } from '@/lib/category-rules'
import { sug } from './helpers/category-context'
import { blocks, bannerText, balancesNote } from './helpers/banner'
import { storedItem, FOREIGN_ITEMS } from '../stubs/plaid-items'

type Params = { q?: string; account?: string; category?: string; month?: string; flow?: string; page?: string }
const render = (searchParams: Params = {}) =>
  TransactionsPage({ searchParams: Promise.resolve(searchParams) })

// The household's one account, at storedItem()'s bank, so that bank's accounts are in (#170).
const ACCOUNTS = [{ account_id: 'acc-1', name: '360 Checking', plaid_item_id: 'item-1' }]

// Holds the read named `name` open until the test lets it go.
function hold(name: string): () => void {
  let release!: () => void
  gates[name] = new Promise<void>((resolve) => (release = resolve))
  return release
}
// One turn of the event loop, so every read the page can start without the held ones has started.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// Same shapes as breakdown-page.test.tsx: a household Grocery with no PFC of its own, reached only
// through a pick or the Safeway rule (#28).
const FOOD = { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }
const GROCERY = { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 }
const SAFEWAY_RULE = { id: 'r-safeway', household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c-grocery', origin: 'seeded' }

const txn = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den',
  amount: 100,
  date: '2026-08-29',
  user_category: null,
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: null,
  account_id: 'acc-1',
  reimbursable_amount: null,
  reimbursable_note: null,
  ...over,
})

beforeEach(() => {
  for (const k of Object.keys(selects)) delete selects[k]
  for (const k of Object.keys(gates)) delete gates[k]
  started.length = 0
  vi.unstubAllEnvs()
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.plaid_items = { data: [], error: null }
  results.categories = { data: [FOOD, GROCERY], error: null }
  results.category_rules = { data: [SAFEWAY_RULE], error: null }
  results.accounts = {
    data: ACCOUNTS,
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
      // Food & Drink by its primary; Grocery through SAFEWAY_RULE.
      txn({ id: 't4', merchant_name: 'Safeway' }),
    ],
    count: 4,
    error: null,
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// A React element in the returned tree. `type` is 'div' for a host element and the component
// function itself for TransactionCard / TransactionRow, which is what lets the two be told apart
// by identity rather than by rendered markup.
type El = { type?: unknown; key?: unknown; props?: Record<string, unknown> }

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
    expect(cards).toHaveLength(4)
    expect(rows).toHaveLength(4)
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
      expect(card.props?.category).toEqual(row.props?.category)
      expect(card.props?.categoryOptions).toEqual(row.props?.categoryOptions)
    }
  })

  it('derives the category the same way for an override, a PFC mapping and a rule', async () => {
    const { cards } = await branches()
    expect(cards.map((c) => (c.props?.category as { name: string }).name)).toEqual(['Food & Drink', 'Grocery', 'Uncategorized', 'Grocery'])
  })

  // #28 spec §8.1: the learned marker needs the REASON for a name, not just the name, so each row
  // is handed the whole ResolvedCategory.
  it('hands each row its resolved category, source included', async () => {
    const { cards, rows } = await branches()
    const learned = { name: 'Grocery', source: 'rule', ruleId: 'r-safeway', bankName: 'Food & Drink' }
    expect(rows.find((r) => r.key === 't4')?.props?.category).toEqual(learned)
    expect(cards.find((c) => c.key === 't4')?.props?.category).toEqual(learned)
  })

  // #28 spec §7.2: the drill-down filters through resolveCategory, so a rule files a row the same
  // way here as in the Breakdown total it was opened from. t2 is there by its pick, t4 by the rule.
  it('files Safeway under Grocery through its rule', async () => {
    const { rows } = await branches({ category: 'Grocery', month: '2026-08' })
    expect(rows.map((r) => r.key)).toEqual(['t2', 't4'])
  })

  // Spec §14.3/§14.7: a Whole Foods row with no rule takes Jev's confident suggestion, and only
  // while CATEGORY_SUGGESTIONS is on. t2 is in Grocery by its pick, t4 by the rule, t5 by Jev.
  describe('Jev suggestions', () => {
    const wholeFoods = (suggestion: unknown) => txn({ id: 't5', merchant_name: 'Whole Foods', suggestion })
    const withRows = (extra: unknown[]) => {
      const t = results.transactions as { data: unknown[]; count: number }
      t.data = [...t.data, ...extra]
      t.count = t.data.length
    }

    it('files Whole Foods under Grocery through its suggestion when suggestions are on', async () => {
      vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
      withRows([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
      const { rows } = await branches({ category: 'Grocery', month: '2026-08' })
      expect(rows.map((r) => r.key)).toEqual(['t2', 't4', 't5'])
    })

    it('leaves Whole Foods under Food & Drink when suggestions are off', async () => {
      vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
      withRows([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
      const { rows } = await branches({ category: 'Grocery', month: '2026-08' })
      expect(rows.map((r) => r.key)).toEqual(['t2', 't4'])
      const food = await branches({ category: 'Food & Drink', month: '2026-08' })
      expect(food.rows.map((r) => r.key)).toContain('t5')
    })

    // Review Focus 5: switching on changes nothing for rows that carry no suggestion.
    it('renders the same with the switch on as off when no row has a suggestion', async () => {
      const t = results.transactions as { data: Record<string, unknown>[]; count: number }
      t.data = t.data.map((r) => ({ ...r, suggestion: null }))
      withRows([wholeFoods(null)])
      const shown = async () =>
        (await branches()).rows.map((r) => [r.key, (r.props?.category as { name: string }).name])
      vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
      const on = await shown()
      vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
      const off = await shown()
      expect(on).toContainEqual(['t5', 'Food & Drink'])
      expect(on).toEqual(off)
    })
  })

  // Spec §7.4's coverage guard: every transactions read the page resolves carries the embed.
  it('selects each transaction\'s suggestion', async () => {
    await render()
    expect(selects.transactions?.length).toBeGreaterThan(0)
    for (const cols of selects.transactions) expect(cols).toContain('category_suggestions(')
  })

  // An unpicked card payment counts in no category total, so the list a Loan Payments row opens
  // must not hold one either, or the two stop adding up.
  it('leaves the card payment out of a category drill-down', async () => {
    results.categories = {
      data: [FOOD, GROCERY, { id: 'c-loans', name: 'Loan Payments', pfc_primary: 'LOAN_PAYMENTS', sort_order: 2 }],
      error: null,
    }
    const all = walk(await render({ category: 'Loan Payments', month: '2026-08' }))
    expect(all.some((d) => d.el.type === TransactionRow)).toBe(false)
    expect(all.some((d) => d.el.type === TransactionCard)).toBe(false)
  })

  // Money in and Money out list the rows behind the dashboard's figures: an income row only in,
  // and neither a transfer nor a card payment out.
  describe('flow', () => {
    beforeEach(() => {
      results.categories = {
        data: [
          FOOD,
          GROCERY,
          { id: 'c-income', name: 'Income', pfc_primary: 'INCOME', sort_order: 2 },
          { id: 'c-tout', name: 'Transfer Out', pfc_primary: 'TRANSFER_OUT', sort_order: 3 },
        ],
        error: null,
      }
      const t = results.transactions as { data: unknown[]; count: number }
      t.data = [
        ...t.data,
        txn({ id: 't5', merchant_name: 'Acme Payroll', amount: -3000, pfc_primary: 'INCOME' }),
        txn({ id: 't6', merchant_name: 'Savings', amount: 500, pfc_primary: 'TRANSFER_OUT' }),
      ]
      t.count = 6
    })

    it('lists only the income row under Money in', async () => {
      const { cards, rows } = await branches({ flow: 'in' })
      expect(rows.map((r) => r.key)).toEqual(['t5'])
      expect(cards.map((c) => c.key)).toEqual(['t5'])
    })

    it('leaves the transfer, the card payment and the income out of Money out', async () => {
      const { cards, rows } = await branches({ flow: 'out' })
      expect(rows.map((r) => r.key)).toEqual(['t1', 't2', 't4'])
      expect(cards.map((c) => c.key)).toEqual(['t1', 't2', 't4'])
    })
  })

  // The in-memory filters rewrite `list` after the fetch. Both branches map that same `list`, so a
  // filtered view must shorten both or neither.
  it('keeps the two branches in step when a filter shortens the list', async () => {
    const { cards, rows } = await branches({ category: 'Grocery' })
    expect(cards).toHaveLength(2)
    expect(rows).toHaveLength(2)
    for (const [i, card] of cards.entries()) expect(card.props?.t).toBe(rows[i].props?.t)
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
    results.transactions = { data: null, error: { message: 'statement timeout' } }
    await expect(render()).rejects.toThrow(/could not read transactions: statement timeout/)
  })

  it('fails loudly when the categories read fails', async () => {
    results.categories = { data: null, error: { message: 'permission denied' } }
    await expect(render()).rejects.toThrow(/could not read categories: permission denied/)
  })

  // TransactionRow renders the desktop table, which is not changing — only the phone sheet
  // (TransactionCard) gets an account name, keyed off the transaction's own account_id against a
  // household-wide accounts query.
  describe('account names', () => {
    it("hands each card its transaction's account name, keyed by account_id", async () => {
      const { cards } = await branches()
      expect(cards.map((c) => c.props?.accountName)).toEqual([
        '360 Checking',
        '360 Checking',
        '360 Checking',
        '360 Checking',
      ])
    })

    // Degrades sensibly rather than rendering the raw Plaid id or an empty row — that is
    // TransactionCard's job (see its own tests); the page's job is to hand it `undefined` rather
    // than guessing.
    it("omits the name when a transaction's account is not in the map", async () => {
      results.transactions.data = [txn({ id: 't1', account_id: 'acc-unknown' })]
      results.transactions.count = 1
      const { cards } = await branches()
      expect(cards[0].props?.accountName).toBeUndefined()
    })

    it('never hands the account name to the desktop row', async () => {
      const { rows } = await branches()
      expect(rows.every((r) => !('accountName' in (r.props ?? {})))).toBe(true)
    })

    it('fails loudly when the accounts read fails', async () => {
      results.accounts = { data: null, error: { message: 'permission denied' } }
      await expect(render()).rejects.toThrow(/could not read account names: permission denied/)
    })
  })
})

// The dashboard's banner, above the list where a missing transaction gets noticed (#171). While a
// bank isn't syncing its rows stop at its last sync, and without the banner nothing says why.
describe('Transactions banks (#171)', () => {
  it("warns that a bank isn't syncing, first, above the header", async () => {
    results.accounts = { data: [...ACCOUNTS, { account_id: 'acc-2', name: 'Gold Card', plaid_item_id: 'item-2' }], error: null }
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
  it("says nothing while every one of the household's banks is syncing", async () => {
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(bannerText(await render())).toBe('')
  })

  // Rendered as no banks, a failed read would show a broken bank's list with no warning (#46). It
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
    const first = [hold('categories'), hold('memberships')]
    const second = [hold('accounts'), hold('plaid_items')]
    const page = render()
    await settle()
    expect(started).toContain('categories')
    expect(started).toContain('memberships')
    first.forEach((release) => release())
    await settle()
    expect(started).toContain('accounts')
    expect(started).toContain('plaid_items')
    second.forEach((release) => release())
    await page
  })
})

// #170: a bank whose first balance pull failed has no accounts, so none of its transactions can be
// in this list: each needs its account's row. The dashboard's note says so above the list, with a
// Refresh button, which this page has no other of.
describe("Transactions before a bank's balances arrive (#170)", () => {
  const amex = storedItem({ id: 'item-2', institution_name: 'Amex', created_at: '2026-07-15T09:00:00Z' })

  it('notes the bank, with Refresh, after the banner and before the header', async () => {
    results.plaid_items = { data: [storedItem(), amex], error: null }
    const tree = await render()
    expect(balancesNote(tree)).toEqual({
      text: "Amex is connected, but its balances and transactions haven't arrived yet. Press Refresh to fetch them.",
      refresh: true,
    })
    expect(blocks(tree).map((b) => b.type).slice(0, 3)).toEqual([NotSyncingBanner, MissingBalancesNote, PageHeader])
  })

  // Another household's bank, or this household's from the other Plaid environment, has no
  // accounts here either, and is not this household's bank.
  it("says nothing while every one of the household's banks has its accounts", async () => {
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(balancesNote(await render())).toBeNull()
  })
})

// #185: an unfiltered empty list said "Connect a bank" even with a bank linked, whose first
// transactions can take hours to arrive. Linking it again spends one of ten lifetime connections
// (#51), so only a household with no bank is told to connect one.
describe('Transactions with none yet (#185)', () => {
  beforeEach(() => {
    results.transactions = { data: [], count: 0, error: null }
  })
  // What the empty list's card says.
  const emptyText = (tree: unknown) => {
    const card = walk(tree).find((d) => d.el.type === Card && d.el.props?.className === 'p-8 text-center')
    return walk(card?.el.props?.children).find((d) => d.el.type === 'p')?.el.props?.children
  }

  it('says to connect a bank when the household has none', async () => {
    expect(emptyText(await render())).toBe('No transactions yet. Connect a bank on the Dashboard.')
  })

  it("says a linked bank's transactions haven't arrived, and doesn't offer to connect one", async () => {
    results.plaid_items = { data: [storedItem()], error: null }
    expect(emptyText(await render())).toBe(
      "Your bank is connected, but its transactions haven't arrived yet. They can take a few hours on a new connection."
    )
  })

  it('says the same of several banks', async () => {
    results.plaid_items = { data: [storedItem(), storedItem({ id: 'item-2', institution_name: 'Amex' })], error: null }
    expect(emptyText(await render())).toBe(
      "Your banks are connected, but their transactions haven't arrived yet. They can take a few hours on a new connection."
    )
  })

  // Another household's bank, or this household's from the other Plaid environment, is not one of
  // this household's.
  it("still says to connect a bank when the only banks are another household's or the other environment's", async () => {
    results.plaid_items = { data: FOREIGN_ITEMS, error: null }
    expect(emptyText(await render())).toBe('No transactions yet. Connect a bank on the Dashboard.')
  })

  // A filtered view's empty list is about the filter, whatever banks there are.
  it("keeps a filtered view's wording", async () => {
    results.plaid_items = { data: [storedItem()], error: null }
    expect(emptyText(await render({ month: '2026-08' }))).toBe(
      'No transactions to show for this view. (Balances-only accounts like a mortgage have none.)'
    )
  })
})
