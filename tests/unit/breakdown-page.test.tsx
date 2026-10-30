import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/budgets-page.test.tsx and tests/unit/trends-page.test.tsx:
// the static page import below is linked before this file's body runs, firing the mock factory.
const { results, calls, tz, history, selects, receivable } = vi.hoisted(() => ({
  // Every `.select()` the page sends, per table, so a test can pin the suggestion embed (§7.4).
  selects: {} as Record<string, string[]>,
  // What lib/receivable answers: what the household is owed, 0 unless a test says otherwise.
  receivable: { value: 0 },
  // What lib/history-start answers; see tests/unit/dashboard-page.test.tsx for why it is mocked.
  history: { value: new Map() as ReadonlyMap<string, string | null> },
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
  chain.gte = (_col: string, v: string) => {
    calls.gte.push(v)
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
        return chainFor(table)
      },
    }),
  }
})
// The service-role client answers from `results` too, so lib/manual-assets.ts and
// lib/plaid-items.ts run for real and a failed read reaches the page as it would in production
// (#91). plaid_items goes through the strict stand-in in tests/stubs/plaid-items.ts, which applies
// the read's filters to the stored rows, so the banner shows only this household's banks (#135).
vi.mock('@/lib/supabase/admin', async () => {
  const { plaidItemsQuery } = await import('../stubs/plaid-items')
  return {
    supabaseAdmin: {
      from: (table: string) =>
        table === 'plaid_items' ? plaidItemsQuery(results.plaid_items ?? { data: [], error: null }) : chainFor(table),
    },
  }
})
// lib/plaid-items.ts needs only plaidEnv from lib/plaid.
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
// The real module but for the timezone, so currentHouseholdId reads `results.memberships`.
vi.mock('@/lib/household', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/household')>()),
  householdTimezone: async () => tz.value,
}))
vi.mock('@/lib/receivable', () => ({ fetchReceivable: async () => receivable.value }))
vi.mock('@/lib/history-start', () => ({ historyStart: async () => history.value }))

import BreakdownPage from '@/app/(app)/breakdown/[metric]/page'
import { BreakdownList } from '@/components/BreakdownList'
import { MissingBalancesNote } from '@/components/MissingBalancesNote'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import { PageHeader } from '@/components/ui/PageHeader'
import { catalogFingerprint } from '@/lib/category-rules'
import { sug } from './helpers/category-context'
import { blocks, bannerText, balancesNote } from './helpers/banner'
import { storedItem, FOREIGN_ITEMS } from '../stubs/plaid-items'
import { render as renderDom, screen, cleanup } from '@testing-library/react'

const FOOD = { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }
const GROCERY = { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 }
const SAFEWAY_RULE = { id: 'r-safeway', household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c-grocery', origin: 'seeded' }

const render = (metric: string) => BreakdownPage({ params: Promise.resolve({ metric }) })

// What historyStart answers: each bank's first transaction, by id. `since` has storedItem()'s bank's
// history beginning in `month`; `waitingOn` has a bank whose first transactions haven't landed.
const since = (month: string): ReadonlyMap<string, string | null> => new Map([['item-1', `${month}-10`]])
const waitingOn = (itemId: string): ReadonlyMap<string, string | null> => new Map([[itemId, null]])

// An account as the accounts table stores it, at the bank `plaid_item_id`.
const account = (plaid_item_id: string, over: Record<string, unknown> = {}) => ({
  id: `acct-${plaid_item_id}`,
  account_id: `plaid-acct-${plaid_item_id}`,
  plaid_item_id,
  name: 'Checking',
  type: 'depository',
  subtype: 'checking',
  current_balance: 100,
  iso_currency_code: 'USD',
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers()
  calls.gte = []
  tz.value = 'America/New_York'
  results.accounts = { data: [], error: null }
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.categories = { data: [], error: null }
  results.category_rules = { data: [], error: null }
  results.transactions = { data: [], error: null }
  results.manual_assets = { data: [], error: null }
  results.plaid_items = { data: [], error: null }
  receivable.value = 0
  for (const k of Object.keys(selects)) delete selects[k]
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const METRICS = ['net-worth', 'cash', 'spent', 'saved']

describe('Breakdown reads', () => {
  // #91: this page exists to explain the net-worth figure, and rendered as no assets it explained
  // one without the house, the mortgage still subtracted as a live liability.
  it('fails loudly when the manual assets read fails, rather than explaining net worth without the house', async () => {
    results.manual_assets = { data: null, error: { message: 'statement timeout' } }
    await expect(render('net-worth')).rejects.toThrow(/could not read manual assets: statement timeout/)
  })

  // Only net worth shows the house, so only net worth reads it. Now that a failed read throws (#91),
  // reading it for every metric would take down Cash, Spent and Saved over a value none of them shows.
  it.each(['cash', 'spent', 'saved'])('still renders %s when the manual assets read fails', async (metric) => {
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'))
    results.manual_assets = { data: null, error: { message: 'statement timeout' } }
    await expect(render(metric)).resolves.toBeTruthy()
  })

  // Every metric shows the "isn't syncing" banner, so every metric needs the household's banks
  // (#135). Rendered as no banks, a failed read would show stale figures with no warning (#46), so
  // it throws, as the dashboard does, and app/(app)/error.tsx offers a retry.
  it.each(METRICS)('fails loudly on %s when the household read fails, rather than hiding the banner', async (metric) => {
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'))
    results.memberships = { data: null, error: { message: 'statement timeout' } }
    await expect(render(metric)).rejects.toThrow(/could not read your household: statement timeout/)
  })

  it.each(METRICS)('fails loudly on %s when the banks read fails, rather than hiding the banner', async (metric) => {
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'))
    results.plaid_items = { data: null, error: { message: 'statement timeout' } }
    await expect(render(metric)).rejects.toThrow(/could not read linked banks: statement timeout/)
  })

  // #172: an account with no membership, which sign-in lets through when it cannot check
  // (lib/access.ts), has no household, so no banks, and on net worth no home value. Every metric
  // renders, and reads neither: both reads are set to fail here, so reading one would throw.
  it.each(METRICS)('renders %s for an account with no household, reading no banks', async (metric) => {
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'))
    results.memberships = { data: null, error: null }
    results.plaid_items = { data: null, error: { message: 'read for no household' } }
    results.manual_assets = { data: null, error: { message: 'read for no household' } }
    expect(bannerText(await render(metric))).toBe('')
  })
})

// The dashboard's banner, on the drill-downs its tiles link to (#135).
describe('Breakdown banks (#135)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'))
    // Both banks' balances are in, so these tests are about syncing alone (#170).
    results.accounts = { data: [account('item-1'), account('item-2', { type: 'credit', subtype: 'credit card' })], error: null }
  })

  it.each(METRICS)("warns on %s that a bank isn't syncing, first, above the header", async (metric) => {
    results.plaid_items = {
      data: [storedItem({ status: 'needs_reconnect' }), storedItem({ id: 'item-2', institution_name: 'Amex' }), ...FOREIGN_ITEMS],
      error: null,
    }
    const tree = await render(metric)
    expect(bannerText(tree)).toBe(
      "Capital One isn't syncing — reconnect in Settings to resume. These figures may be out of date."
    )
    const order = blocks(tree).map((b) => b.type)
    expect(order.indexOf(NotSyncingBanner)).toBe(0)
    expect(order.indexOf(NotSyncingBanner)).toBeLessThan(order.indexOf(PageHeader))
  })

  // Another household's broken bank, or this household's from the other Plaid environment, must
  // not raise the banner here.
  it.each(METRICS)("says nothing on %s while every one of the household's banks is syncing", async (metric) => {
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(bannerText(await render(metric))).toBe('')
  })
})

// #170: a bank whose first balance pull failed has no accounts, and so no transactions, which each
// need their account's row. Every breakdown leaves it out and looks complete: net worth and cash on
// hand sum the accounts, spent and saved the transactions. The dashboard's note says so here too,
// under the banner and above the header.
describe("Breakdown before a bank's balances arrive (#170)", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'))
    results.accounts = { data: [account('item-1')], error: null }
  })
  const amex = (over: Record<string, unknown> = {}) =>
    storedItem({ id: 'item-2', institution_name: 'Amex', created_at: '2026-07-15T09:00:00Z', ...over })

  it.each(METRICS)("notes on %s the bank whose balances haven't arrived, after the banner and before the header", async (metric) => {
    results.plaid_items = { data: [storedItem(), amex()], error: null }
    const tree = await render(metric)
    expect(balancesNote(tree)).toEqual({
      text: "Amex is connected, but its balances and transactions haven't arrived yet. Press Refresh to fetch them.",
      refresh: true,
    })
    expect(blocks(tree).map((b) => b.type).slice(0, 3)).toEqual([NotSyncingBanner, MissingBalancesNote, PageHeader])
  })

  // Whether or not another bank's balances are in: an empty breakdown is no truer.
  it.each(METRICS)('notes it on %s when no bank has accounts yet', async (metric) => {
    results.accounts = { data: [], error: null }
    results.plaid_items = { data: [storedItem()], error: null }
    expect(balancesNote(await render(metric))).toEqual({
      text: "Capital One is connected, but its balances and transactions haven't arrived yet. Press Refresh to fetch them.",
      refresh: true,
    })
  })

  // Another household's bank, or this household's from the other Plaid environment, has no
  // accounts here either, and is not this household's bank.
  it.each(METRICS)("says nothing on %s while every one of the household's banks has its accounts", async (metric) => {
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(balancesNote(await render(metric))).toBeNull()
  })

  it.each(METRICS)("promises nothing on %s for a bank that isn't syncing, and offers no Refresh", async (metric) => {
    results.plaid_items = { data: [storedItem(), amex({ status: 'needs_reconnect' })], error: null }
    expect(balancesNote(await render(metric))).toEqual({
      text: "Amex is connected, but its balances and transactions can't arrive until it's sorted out in Settings.",
      refresh: false,
    })
  })

  // A bank linked for investments only is as missing from net worth as any other, though the
  // average does not wait for it (see 'Saved breakdown' below).
  it('notes on net-worth a bank linked for investments only', async () => {
    results.plaid_items = {
      data: [storedItem(), storedItem({ id: 'item-3', institution_name: 'Fidelity', products: ['investments'] })],
      error: null,
    }
    expect(balancesNote(await render('net-worth'))).toEqual({
      text: "Fidelity is connected, but its balances and transactions haven't arrived yet. Press Refresh to fetch them.",
      refresh: true,
    })
  })

  // On Saved this month's money in and out are short of the bank too, so the note is there, and the
  // average's card says it is waiting for the bank (see 'Saved breakdown' below).
  it('notes the bank on saved, where the average waits for it as well', async () => {
    history.value = since('2026-05')
    results.plaid_items = { data: [storedItem(), amex()], error: null }
    const tree = await render('saved')
    expect(balancesNote(tree)?.text).toBe(
      "Amex is connected, but its balances and transactions haven't arrived yet. Press Refresh to fetch them."
    )
    expect(textOf(blocks(tree).at(-1)!)).toBe("The average is waiting for Amex's transaction history to arrive.")
  })
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
  // 2026-09-15 in New York: September is in progress. The fixture runs May to September: June,
  // July and August save $1,000, $3,000 and -$1,000.
  const txn = (id: string, date: string, amount: number, pfc: string) => ({
    id, date, amount, user_category: null, pfc_primary: pfc, pfc_detailed: null, reimbursable_amount: null,
  })
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'))
    results.plaid_items = {
      data: [storedItem(), storedItem({ id: 'item-2', institution_name: 'Amex', created_at: '2026-07-15T09:00:00Z' })],
      error: null,
    }
    results.accounts = { data: [account('item-1'), account('item-2', { type: 'credit', subtype: 'credit card' })], error: null }
    results.categories = { data: [{ id: 'c1', name: 'Income', pfc_primary: 'INCOME', sort_order: 0 }], error: null }
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
  })

  it('lists each complete month and their mean, newest first, linking to each month', async () => {
    history.value = since('2026-05')
    const tree = await render('saved')
    const avg = lists(tree)[1] as { rows: { label: string; amount: number; href: string }[]; total: unknown }
    expect(avg.rows.map((r) => [r.label, r.amount, r.href])).toEqual([
      ['August', -1000, '/transactions?month=2026-08'],
      ['July', 3000, '/transactions?month=2026-07'],
      ['June', 1000, '/transactions?month=2026-06'],
    ])
    expect(avg.total).toMatchObject({ label: 'Average per month', amount: 1000 })
    expect(textOf(tree)).toContain('last 3 months')
  })

  it('starts where historyStart says, and names a single month as one', async () => {
    history.value = since('2026-07')
    const tree = await render('saved')
    expect(lists(tree)[1].rows.map((r) => r.label)).toEqual(['August'])
    expect(textOf(tree)).toContain('last 1 month')
    expect(textOf(tree)).not.toContain('last 1 months')
  })

  it.each([
    ['no full month has followed the history start', since('2026-08'), /not enough history yet/i],
    ['a bank is still delivering its history', waitingOn('item-1'), /waiting for Capital One's/],
    ['there are no transactions', new Map(), /no transactions yet/i],
  ])('says why there is no average when %s', async (_, state, reason) => {
    history.value = state
    const tree = await render('saved')
    expect(lists(tree)).toHaveLength(1)
    expect(textOf(tree)).toMatch(reason)
  })

  // #169: historyStart says which bank by id; its name comes from the bank list this page reads
  // with the service-role client, the one read that can see plaid_items.
  it('names the bank the average is waiting for, from the bank list', async () => {
    history.value = waitingOn('item-2')
    expect(textOf(blocks(await render('saved')).at(-1)!)).toBe(
      "The average is waiting for Amex's transaction history to arrive."
    )
  })

  // #170: a bank whose first balance pull failed has no accounts, so no transactions either, and
  // every month here is short of it. historyStart can't see it, since it finds banks through their
  // accounts, so this is the bank list against the page's own accounts.
  it("waits for a bank whose balances haven't arrived, and names it", async () => {
    history.value = since('2026-05')
    results.accounts = { data: [account('item-1')], error: null }
    const tree = await render('saved')
    expect(lists(tree)).toHaveLength(1)
    expect(textOf(blocks(tree).at(-1)!)).toBe("The average is waiting for Amex's transaction history to arrive.")
  })

  // Linked for investments only, a bank sends no transactions, so the average has nothing to wait
  // for, though its balances are missing too.
  it("keeps the average for a bank linked for investments only, whose balances haven't arrived", async () => {
    history.value = since('2026-05')
    results.plaid_items = {
      data: [storedItem(), storedItem({ id: 'item-3', institution_name: 'Fidelity', products: ['investments'] })],
      error: null,
    }
    results.accounts = { data: [account('item-1')], error: null }
    expect(lists(await render('saved'))).toHaveLength(2)
  })

  // Nor once they arrive: Plaid types its cash account depository, so historyStart has the bank
  // with no first transaction, and none will ever come (#170).
  it('keeps the average for a bank linked for investments only, once its cash account is in', async () => {
    history.value = new Map([['item-1', '2026-05-10'], ['item-3', null]])
    results.plaid_items = {
      data: [storedItem(), storedItem({ id: 'item-3', institution_name: 'Fidelity', products: ['investments'] })],
      error: null,
    }
    results.accounts = { data: [account('item-1'), account('item-3', { subtype: 'cash management' })], error: null }
    expect(lists(await render('saved'))).toHaveLength(2)
  })

  // #135: August would be missing a broken bank's transactions from the day it broke, and still be
  // averaged as a full month. So the average goes, and one line says why, where it would have been.
  it("has no average while a bank isn't syncing, and says why in its place", async () => {
    history.value = since('2026-05')
    results.plaid_items = { data: [storedItem({ status: 'needs_reconnect' }), storedItem({ id: 'item-2', institution_name: 'Amex' })], error: null }
    const tree = await render('saved')
    expect(lists(tree)).toHaveLength(1)
    expect(textOf(tree)).not.toMatch(/average saved/i)
    const avgCard = blocks(tree).at(-1)!
    expect(textOf(avgCard)).toBe("No average while Capital One isn't syncing.")
  })

  // This month's own money in and out still show: the banner above says they may be out of date.
  it("still shows this month's money in and out while a bank isn't syncing", async () => {
    history.value = since('2026-05')
    results.plaid_items = { data: [storedItem({ status: 'needs_reconnect' })], error: null }
    expect(lists(await render('saved'))[0].rows.map((r) => r.label)).toEqual(['Money in (income)', 'Money out (spending)'])
  })

  // Only this household's banks count: a broken bank elsewhere leaves the average alone.
  it("keeps the average when only another household's bank, or one from the other environment, is broken", async () => {
    history.value = since('2026-05')
    results.plaid_items = { data: [storedItem(), ...FOREIGN_ITEMS], error: null }
    expect(lists(await render('saved'))).toHaveLength(2)
  })
})

describe('Breakdown categories and rules (#28)', () => {
  const safeway = { id: 't1', amount: 42, date: '2026-09-10', merchant_name: 'Safeway', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null }
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-15T16:00:00Z'))
  })

  it('lists Safeway under Grocery through its rule', async () => {
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.category_rules = { data: [SAFEWAY_RULE], error: null }
    results.transactions = { data: [safeway], error: null }
    const rows = lists(await render('spent'))[0].rows
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Grocery', amount: 42 }))
    expect(rows.some((r) => r.label === 'Food & Drink')).toBe(false)
  })

  // #28 spec §5.4: a rule moves a dollar between categories, never in or out of Saved.
  it('shows the same money in and out with and without the rule', async () => {
    const INCOME = { id: 'c-income', name: 'Income', pfc_primary: 'INCOME', sort_order: 2 }
    results.categories = { data: [FOOD, GROCERY, INCOME], error: null }
    results.transactions = {
      data: [
        safeway,
        { id: 't2', amount: -3000, date: '2026-09-05', merchant_name: 'Acme Payroll', user_category: null, pfc_primary: 'INCOME', pfc_detailed: null, reimbursable_amount: null },
      ],
      error: null,
    }
    const inOut = async () => lists(await render('saved'))[0].rows.map((r) => [r.label, r.amount])
    const without = await inOut()
    results.category_rules = { data: [SAFEWAY_RULE], error: null }
    const withRule = await inOut()
    expect(without).toEqual([
      ['Money in (income)', 3000],
      ['Money out (spending)', 42],
    ])
    expect(withRule).toEqual(without)
  })

  // Spec §14.3/§14.7: a Whole Foods row with no rule takes Jev's confident suggestion, and only
  // while CATEGORY_SUGGESTIONS is on.
  const wholeFoods = (suggestion: unknown) => ({
    id: 't3', amount: 30, date: '2026-09-11', merchant_name: 'Whole Foods', user_category: null,
    pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, reimbursable_amount: null, suggestion,
  })
  const spentRows = async (rows: unknown[]) => {
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.category_rules = { data: [], error: null }
    results.transactions = { data: rows, error: null }
    return lists(await render('spent'))[0].rows
  }

  it('lists Whole Foods under Grocery through its suggestion when suggestions are on', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
    const rows = await spentRows([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Grocery', amount: 30 }))
    expect(rows.some((r) => r.label === 'Food & Drink')).toBe(false)
  })

  it('lists Whole Foods under Food & Drink when suggestions are off', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
    const rows = await spentRows([wholeFoods(sug(GROCERY.id, 0.99, catalogFingerprint([FOOD, GROCERY])))])
    expect(rows).toContainEqual(expect.objectContaining({ label: 'Food & Drink', amount: 30 }))
    expect(rows.some((r) => r.label === 'Grocery')).toBe(false)
  })

  // Review Focus 5: switching on changes nothing for rows that carry no suggestion.
  it('lists the same with the switch on as off when no row has a suggestion', async () => {
    const rows = [wholeFoods(null), { ...safeway, suggestion: null }]
    vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
    const on = (await spentRows(rows)).map((r) => [r.label, r.amount])
    vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
    const off = (await spentRows(rows)).map((r) => [r.label, r.amount])
    expect(on).toContainEqual(['Food & Drink', 72])
    expect(on).toEqual(off)
  })

  // Spec §7.4's coverage guard: every transactions read the page resolves carries the embed.
  it.each(['spent', 'saved'])('selects each transaction\'s suggestion on %s', async (metric) => {
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.transactions = { data: [wholeFoods(null)], error: null }
    await render(metric)
    expect(selects.transactions?.length).toBeGreaterThan(0)
    for (const cols of selects.transactions) expect(cols).toContain('category_suggestions(')
  })

  // A failed rules read rendered as "no rules" would quietly move every learned label back (#46).
  it('throws when the categories and rules cannot be read', async () => {
    results.category_rules = { data: null, error: { message: 'boom' } }
    await expect(render('spent')).rejects.toThrow(/could not read category rules/)
  })
})

// The owed-to-you total keeps its cents wherever it appears (owner decision, 2026-10-30, #215): here
// as on the dashboard's link and the reimbursements page. Rounded, a 30-cent remainder read "Owed to
// you $0". The rows are rendered as the page hands them to BreakdownList, so this needs both halves:
// the page marking the row, and the list keeping its cents.
describe('Net worth breakdown: Owed to you, to the cent', () => {
  afterEach(cleanup)

  const shown = async (owed: number) => {
    receivable.value = owed
    results.accounts = { data: [account('item-1', { current_balance: 1234.56 })], error: null }
    const props = lists(await render('net-worth'))[0] as Parameters<typeof BreakdownList>[0]
    renderDom(<BreakdownList {...props} />)
    const amountOf = (label: string) =>
      screen.getByText(label).closest('li')!.querySelector('.tabular-nums')!.textContent
    return { owed: amountOf('Owed to you'), account: amountOf('Checking') }
  }

  it.each([
    [12.34, '$12.34'],
    [0.3, '$0.30'],
  ])('shows %s owed as %s, beside an account in whole dollars', async (owed, text) => {
    expect(await shown(owed)).toEqual({ owed: text, account: '$1,235' })
  })

  // The page marks that one row exact, and no other row on any breakdown.
  it.each(METRICS)('marks no row exact but Owed to you, on %s', async (metric) => {
    receivable.value = 12.34
    results.accounts = { data: [account('item-1')], error: null }
    const rows = lists(await render(metric)).flatMap((l) => l.rows as { label: string; exact?: boolean }[])
    expect(rows.filter((r) => r.exact).map((r) => r.label)).toEqual(metric === 'net-worth' ? ['Owed to you'] : [])
  })
})
