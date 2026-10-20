import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/dashboard-page.test.tsx: the static page import
// below is linked before this file's body runs, firing the mock factory.
const { results, switchState } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  switchState: { suggestionsOn: true },
}))

// A supabase query is a builder awaited at the end, so the stub returns itself for every chained
// method and resolves to whatever the test configured for that table.
const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  // PostgREST sends a count only when the select asks for one, so the stub does too: without
  // { count: 'exact' } the count comes back null, as in production. Otherwise dropping the option
  // from the accounts read would still pass while every visit said "Couldn't check your accounts."
  let countAsked = false
  chain.select = (_columns?: string, options?: { count?: string }) => {
    countAsked = options?.count === 'exact'
    return chain
  }
  for (const m of ['order', 'eq', 'limit']) chain[m] = () => chain
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
  chain.then = (resolve: (v: unknown) => unknown) => {
    const reply = afterCursor ? { data: [], error: null } : (results[table] ?? { data: [], error: null })
    return Promise.resolve('count' in reply && !countAsked ? { ...reply, count: null } : reply).then(resolve)
  }
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => chainFor(table),
  }),
}))
// Categories and rules come through lib/category-context.ts (#28), whose own test covers paging.
// Built from `results.categories` / `results.category_rules`, so a failed categories read still
// rejects with the page's message.
vi.mock('@/lib/category-context', async () => {
  const { testData } = await import('./helpers/category-context')
  return {
    fetchCategoryContext: async () => {
      const c = results.categories ?? { data: [], error: null }
      if (c.error) throw new Error(`could not read categories: ${c.error.message}`)
      const r = results.category_rules ?? { data: [], error: null }
      if (r.error) throw new Error(`could not read category rules: ${r.error.message}`)
      return testData(c.data as never, r.data as never, { suggestionsOn: switchState.suggestionsOn })
    },
    readTransactionsForCounts: async () => {
      const t = results.transactions ?? { data: [], error: null }
      if (t.error) throw new Error(`could not read transactions: ${t.error.message}`)
      return t.data
    },
  }
})
// Settings also reads plaid_items/plaid_slot_ledger/manual_assets, all via the service-role
// client (lib/supabase/admin) rather than the request-scoped one stubbed above. That client
// answers from `results` too, so lib/plaid-items.ts and lib/manual-assets.ts run for real and a
// failed read reaches the page as it would in production (#91). The slot count is stubbed out, so
// the page never makes a real network call; lib/plaid-items.ts needs only plaidEnv from lib/plaid.
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: (table: string) => chainFor(table) } }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/plaid-slots', () => ({ countSlotsUsed: async () => null, LIFETIME_SLOTS: 10 }))

import SettingsPage from '@/app/(app)/settings/page'
import { TimezoneCard } from '@/components/TimezoneCard'
import { CategoryManager } from '@/components/CategoryManager'
import { CategoryRulesCard } from '@/components/CategoryRulesCard'
import { BankList } from '@/components/BankList'
import { HomeValueCard } from '@/components/HomeValueCard'
import { LinkButton } from '@/components/LinkButton'
import { Card } from '@/components/ui/Card'
import { txnRows } from '../stubs/postgrest-pages'
import { catalogFingerprint } from '@/lib/category-rules'

const FOOD = { id: 'c-food', name: 'Food & Drink', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }
const GROCERY = { id: 'c-grocery', name: 'Grocery', pfc_primary: null, sort_order: 1 }
const SAFEWAY_RULE = { id: 'r-safeway', household_id: 'hh-1', merchant_key: 'safeway', merchant_label: 'Safeway', category_id: 'c-grocery', origin: 'seeded' }

// Server Components return an unrendered React element tree — no DOM, no hooks fired — so the
// prop SettingsPage hands TimezoneCard can be read straight off that tree without mounting
// anything downstream of it (InvitePartnerForm, BankList, CategoryManager, ...).
function findProps(node: unknown, type: unknown): Record<string, unknown> | null {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProps(child, type)
      if (found) return found
    }
    return null
  }
  const el = node as { type?: unknown; props?: { children?: unknown } }
  if (el.type === type) return (el.props ?? {}) as Record<string, unknown>
  if (el.props && 'children' in el.props) return findProps(el.props.children, type)
  return null
}

// The children of the first element with role="alert", walked the same way as findProps. Only
// finds markup the page itself writes: a component's own output is not in an unrendered tree.
function alertText(node: unknown): string | null {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = alertText(child)
      if (found != null) return found
    }
    return null
  }
  const el = node as { props?: { role?: unknown; children?: unknown } }
  if (el.props?.role === 'alert') return flatText(el.props.children)
  if (el.props && 'children' in el.props) return alertText(el.props.children)
  return null
}

function flatText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatText).join('')
  return flatText((node as { props?: { children?: unknown } }).props?.children)
}

// The <Card> headed `title`, so an assertion is about that card rather than the whole page.
function card(node: unknown, title: string): unknown {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = card(child, title)
      if (found) return found
    }
    return null
  }
  const el = node as { type?: unknown; props?: { children?: unknown } }
  const kids = el.props?.children
  const headed = (Array.isArray(kids) ? kids : [kids]).some((k) => {
    const h = k as { type?: unknown; props?: { children?: unknown } } | null
    return h?.type === 'h2' && flatText(h.props?.children) === title
  })
  if (el.type === Card && headed) return el
  return el.props && 'children' in el.props ? card(kids, title) : null
}

beforeEach(() => {
  results.households = {
    data: [{ id: 'hh-1', name: 'Test Household', timezone: 'America/Los_Angeles' }],
    error: null,
  }
  results.accounts = { data: [], error: null, count: 0 } as unknown as {
    data: unknown
    error: null
  }
  results.categories = { data: [], error: null }
  results.category_rules = { data: [], error: null }
  results.transactions = { data: [], error: null }
  results.budgets = { data: [], error: null }
  results.manual_assets = { data: [], error: null }
  results.plaid_items = { data: [], error: null }
  switchState.suggestionsOn = true
})

// A console.error spy left behind by a failing test would hand its calls to the next test's spy.
afterEach(() => {
  vi.restoreAllMocks()
})

// Settings is the only place a bank can be reconnected (spec §7.3), so it catches a failed read per
// card, as it does for categories below. A card whose read failed says so; it never shows "none"
// in place of what it could not read (#46, #91).
describe('Settings: a failed read says so in its own card (#91)', () => {
  // Rendered as no assets, a failed read showed the home value as never entered.
  it('says the home value could not be loaded, and still renders the rest of the page', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    results.manual_assets = { data: null, error: { message: 'boom' } }
    const tree = await SettingsPage()
    const home = card(tree, 'Home value')
    expect(alertText(home)).toBe("Couldn't load your home value. Try again.")
    expect(findProps(home, 'a')).toMatchObject({ href: '/settings' })
    expect(findProps(tree, HomeValueCard)).toBeNull()
    expect(findProps(tree, BankList)).not.toBeNull()
    expect(findProps(tree, CategoryManager)).not.toBeNull()
    expect(log).toHaveBeenCalledWith('[settings] could not load the home value', new Error('could not read manual assets: boom'))
  })

  it('hands the Home value card the stored value when the read succeeds', async () => {
    results.manual_assets = {
      data: [{ id: 'a1', name: 'Home', value: 750000, updated_at: '2026-10-01T12:00:00Z' }],
      error: null,
    }
    const tree = await SettingsPage()
    expect(findProps(tree, HomeValueCard)).toEqual({ initialValue: 750000, updatedAt: '2026-10-01T12:00:00Z' })
    expect(alertText(card(tree, 'Home value'))).toBeNull()
  })

  // Rendered as no banks, a failed read said "No banks connected yet." beside Connect a bank: an
  // invitation to relink a bank that is still connected, which spends one of ten lifetime
  // connections (#51). Connect a bank goes too, since its own warning points at "the list above".
  it('says the banks could not be loaded, offers no new connection, and still renders the rest of the page', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    results.plaid_items = { data: null, error: { message: 'boom' } }
    const tree = await SettingsPage()
    const banks = card(tree, 'Banks')
    expect(alertText(banks)).toBe("Couldn't load your banks. Try again.")
    expect(findProps(tree, BankList)).toBeNull()
    expect(findProps(banks, LinkButton)).toBeNull()
    expect(findProps(tree, HomeValueCard)).not.toBeNull()
    expect(findProps(tree, CategoryManager)).not.toBeNull()
    expect(log).toHaveBeenCalledWith('[settings] could not load the banks', new Error('could not read linked banks: boom'))
  })

  it('lists the banks, and offers Connect a bank, when the read succeeds', async () => {
    const item = { id: 'item-1', institution_name: 'Capital One', status: 'ok', status_detail: null, products: ['transactions'], created_at: '2026-07-14T18:05:30Z' }
    results.plaid_items = { data: [item], error: null }
    const banks = card(await SettingsPage(), 'Banks')
    expect(findProps(banks, BankList)).toMatchObject({ items: [item] })
    expect(findProps(banks, LinkButton)).not.toBeNull()
    expect(alertText(banks)).toBeNull()
  })

  // The count read printed "No banks connected yet." whenever it had no count, failed or not. Here
  // the household has a bank, so that line would be a plain falsehood.
  it.each([
    ['fails', { data: null, error: { message: 'boom' }, count: null }, 'could not count accounts: boom'],
    ['returns no count and no error', { data: null, error: null, count: null }, 'could not count accounts: read returned no count and no error'],
  ])('says the accounts could not be checked when the count read %s', async (_name, reply, message) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    results.accounts = reply as never
    results.plaid_items = {
      data: [{ id: 'item-1', institution_name: 'Capital One', status: 'ok', status_detail: null, products: ['transactions'], created_at: '2026-07-14T18:05:30Z' }],
      error: null,
    }
    const banks = card(await SettingsPage(), 'Banks')
    expect(alertText(banks)).toBe("Couldn't check your accounts. Try again.")
    expect(flatText(banks)).not.toContain('No banks connected yet.')
    expect(findProps(banks, BankList)).not.toBeNull()
    expect(log).toHaveBeenCalledWith('[settings] could not load the account count', new Error(message))
  })

  it.each([
    [0, 'No banks connected yet.'],
    [3, '3 account(s) connected.'],
  ])('says how many accounts are connected when the count is %i', async (count, line) => {
    results.accounts = { data: null, error: null, count } as never
    const banks = card(await SettingsPage(), 'Banks')
    expect(flatText(banks)).toContain(line)
    expect(alertText(banks)).toBeNull()
  })

  // #164: a bank whose first balance pull failed is connected, with no accounts until Refresh
  // brings them. The count's "No banks connected yet." sat above a list that showed the bank, and
  // invited linking it again, which spends one of ten lifetime connections (#51).
  describe("while a bank's balances haven't arrived (#164)", () => {
    const capitalOne = { id: 'item-1', institution_name: 'Capital One', status: 'ok', status_detail: null, products: ['transactions'], created_at: '2026-07-14T18:05:30Z' }

    it('takes the first line from the bank list', async () => {
      results.plaid_items = { data: [capitalOne], error: null }
      const banks = card(await SettingsPage(), 'Banks')
      expect(flatText(banks)).toContain("Capital One is connected, but its balances haven't arrived yet.")
      expect(flatText(banks)).not.toContain('No banks connected yet.')
      expect(findProps(banks, BankList)).toMatchObject({ items: [capitalOne] })
      expect(alertText(banks)).toBeNull()
    })

    it('counts several banks whose balances have not arrived', async () => {
      results.plaid_items = { data: [capitalOne, { ...capitalOne, id: 'item-2', institution_name: 'Amex' }], error: null }
      expect(flatText(card(await SettingsPage(), 'Banks'))).toContain(
        "2 banks are connected, but their balances haven't arrived yet."
      )
    })

    // #172: a bank that isn't syncing can't be counted on to send its balances (Refresh skips a
    // broken login, and retries the rest without fixing what stopped them), so the line promises
    // nothing for it. Its status line in the list below says what it needs.
    it.each(['needs_reconnect', 'config_error', 'action_at_bank', 'temporarily_unavailable'])(
      'promises nothing for a bank that is %s',
      async (status) => {
        results.plaid_items = { data: [{ ...capitalOne, status }], error: null }
        const text = flatText(card(await SettingsPage(), 'Banks'))
        expect(text).toContain("Capital One is connected, but its balances can't arrive until it's sorted out.")
        expect(text).not.toContain("haven't arrived")
      }
    )

    it('counts several banks that are not syncing', async () => {
      results.plaid_items = {
        data: [{ ...capitalOne, status: 'needs_reconnect' }, { ...capitalOne, id: 'item-2', institution_name: 'Amex', status: 'config_error' }],
        error: null,
      }
      expect(flatText(card(await SettingsPage(), 'Banks'))).toContain(
        "2 banks are connected, but their balances can't arrive until they're sorted out."
      )
    })

    it('with one bank syncing and one not, says which is on its way and which is not', async () => {
      results.plaid_items = { data: [capitalOne, { ...capitalOne, id: 'item-2', institution_name: 'Amex', status: 'needs_reconnect' }], error: null }
      expect(flatText(card(await SettingsPage(), 'Banks'))).toContain(
        "Capital One is connected, but its balances haven't arrived yet. Amex is connected, but its balances can't arrive until it's sorted out."
      )
    })

    // Once any account has arrived the count is true again, and stays the first line.
    it('keeps the account count once there are accounts', async () => {
      results.accounts = { data: null, error: null, count: 3 } as never
      results.plaid_items = { data: [capitalOne], error: null }
      const text = flatText(card(await SettingsPage(), 'Banks'))
      expect(text).toContain('3 account(s) connected.')
      expect(text).not.toContain("haven't arrived")
    })

    // With the bank list unreadable, a count of zero cannot tell "no banks" from a bank with no
    // accounts yet, so the card says only that the list didn't load (#46).
    it('does not say "No banks connected yet." when the banks could not be loaded', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      results.plaid_items = { data: null, error: { message: 'boom' } }
      const banks = card(await SettingsPage(), 'Banks')
      // The heading and the alert, run together by flatText, and nothing else.
      expect(flatText(banks)).toBe("BanksCouldn't load your banks. Try again.")
      expect(alertText(banks)).toBe("Couldn't load your banks. Try again.")
    })
  })

  // The household read gates every card below it: unchecked, a read with neither rows nor an error
  // rendered every card as if nothing were connected (#46).
  it('throws when the household read returns no data and no error', async () => {
    results.households = { data: null, error: null }
    await expect(SettingsPage()).rejects.toThrow('could not read your household: read returned no data and no error')
  })
})

describe('Settings timezone control', () => {
  // The only place the app ever displays the zone that decides which month a household's money
  // is reported in. A household on America/Los_Angeles told it is on America/New_York would never
  // notice why its numbers are a day off (#73).
  it("passes the household's stored zone to the control, not the default", async () => {
    const tree = await SettingsPage()
    const props = findProps(tree, TimezoneCard)
    expect(props).not.toBeNull()
    expect(props?.current).toBe('America/Los_Angeles')
  })
})

describe('Settings categories and rules', () => {
  // The delete-category dialog says how many transactions would move. On 2026-10-05 the household
  // had 1,366, and an unpaged read counted 1,000 of them (#69). readTransactionsForCounts pages (its
  // own test covers that); this pins that Settings counts every row it returns.
  it('counts every transaction, past the 1,000-row cap', async () => {
    results.categories = { data: [{ id: 'c1', name: 'Groceries', pfc_primary: 'FOOD_AND_DRINK', sort_order: 0 }], error: null }
    results.transactions = {
      data: txnRows(1366, '2025-10-18', { merchant_name: null, user_category: 'Groceries', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null }),
      error: null,
    }
    const props = findProps(await SettingsPage(), CategoryManager) as { usage: Record<string, { txns: number }> }
    expect(props.usage.Groceries.txns).toBe(1366)
  })

  it('hands the delete dialog what a delete would move', async () => {
    results.categories = { data: [FOOD, GROCERY], error: null }
    results.category_rules = { data: [SAFEWAY_RULE], error: null }
    results.transactions = { data: [{ id: 't1', date: '2026-09-10', merchant_name: 'Safeway', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null }], error: null }
    const props = findProps(await SettingsPage(), CategoryManager) as { usage: Record<string, { impact: unknown }> }
    expect(props.usage.Grocery.impact).toMatchObject({ moved: [{ name: 'Food & Drink', count: 1 }], rulesRemoved: 1 })
  })

  // #28 spec §8.3: each rule with what it does — the rows it relabels, and the merchant's
  // hand-picked rows it leaves alone.
  it('shows each rule with its counts', async () => {
    const TRAVEL = { id: 'c-travel', name: 'Travel', pfc_primary: 'TRAVEL', sort_order: 2 }
    const INCOME = { id: 'c-income', name: 'Income', pfc_primary: 'INCOME', sort_order: 3 }
    const TRANSFER_IN = { id: 'c-tin', name: 'Transfer In', pfc_primary: 'TRANSFER_IN', sort_order: 4 }
    results.categories = { data: [FOOD, GROCERY, TRAVEL, INCOME, TRANSFER_IN], error: null }
    results.category_rules = { data: [SAFEWAY_RULE], error: null }
    results.transactions = {
      data: [
        { id: 't1', date: '2026-09-10', merchant_name: 'Safeway', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
        { id: 't2', date: '2026-09-11', merchant_name: 'Safeway', user_category: 'Travel', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null },
      ],
      error: null,
    }
    const props = findProps(await SettingsPage(), CategoryRulesCard) as { rules: unknown; categories: unknown }
    expect(props.rules).toEqual([
      expect.objectContaining({ id: 'r-safeway', merchantLabel: 'Safeway', categoryName: 'Grocery', changed: 1, pickedByHand: 1, matching: 2 }),
    ])
    // Each category's kind decides which a rule may move to, so it must be the totals' kind.
    expect(props.categories).toEqual([
      { id: 'c-food', name: 'Food & Drink', kind: 'spending' },
      { id: 'c-grocery', name: 'Grocery', kind: 'spending' },
      { id: 'c-travel', name: 'Travel', kind: 'spending' },
      { id: 'c-income', name: 'Income', kind: 'income' },
      { id: 'c-tin', name: 'Transfer In', kind: 'transfer' },
    ])
  })

  // #28 spec §14.6/§14.7: the Jev line counts the rows Jev relabels, and is hidden with the switch off.
  describe('Jev line', () => {
    const suggestedRows = () => {
      const fp = catalogFingerprint([FOOD, GROCERY])
      const toGrocery = { category_id: 'c-grocery', confidence: 0.99, catalog_fingerprint: fp }
      return [
        { id: 't1', date: '2026-09-10', merchant_name: 'Whole Foods', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, suggestion: toGrocery },
        { id: 't2', date: '2026-09-11', merchant_name: 'Trader Joes', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, suggestion: toGrocery },
        { id: 't3', date: '2026-09-12', merchant_name: 'Deli', user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: null, suggestion: null },
      ]
    }

    it('passes the count of Jev-filed transactions when suggestions are on', async () => {
      results.categories = { data: [FOOD, GROCERY], error: null }
      results.transactions = { data: suggestedRows(), error: null }
      const props = findProps(await SettingsPage(), CategoryRulesCard) as { suggestedCount: unknown }
      expect(props.suggestedCount).toBe(2)
    })

    it('passes null when suggestions are off', async () => {
      switchState.suggestionsOn = false
      results.categories = { data: [FOOD, GROCERY], error: null }
      results.transactions = { data: suggestedRows(), error: null }
      const props = findProps(await SettingsPage(), CategoryRulesCard) as { suggestedCount: unknown }
      expect(props.suggestedCount).toBeNull()
    })
  })

  // Settings is the only place a bank can be reconnected (spec §7.3), so a failed categories,
  // rules, transactions or budgets read must not take the page down. It must not render as "no
  // categories" either (#46), which would offer to create the defaults again.
  it.each([
    ['categories', () => (results.categories = { data: null, error: { message: 'boom' } })],
    ['rules', () => (results.category_rules = { data: null, error: { message: 'boom' } })],
    ['transactions', () => (results.transactions = { data: null, error: { message: 'boom' } })],
    ['budgets', () => (results.budgets = { data: null, error: { message: 'boom' } })],
  ])('keeps Banks usable and shows an alert when the %s read fails', async (_name, fail) => {
    fail()
    const tree = await SettingsPage()
    expect(findProps(tree, BankList)).not.toBeNull()
    expect(findProps(tree, CategoryManager)).toBeNull()
    expect(findProps(tree, CategoryRulesCard)).toBeNull()
    expect(alertText(tree)).toContain("Couldn't load categories and rules.")
  })

  // The logged message carries the error code, as the categories and rules reads' do.
  it.each([
    ['with a code', { message: 'boom', code: '42P01' }, 'could not read budgets: 42P01 boom'],
    ['without a code', { message: 'boom' }, 'could not read budgets: boom'],
  ])('logs a failed budgets read %s', async (_name, error, message) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    results.budgets = { data: null, error }
    await SettingsPage()
    expect(log).toHaveBeenCalledWith('[settings] could not load categories and rules', new Error(message))
    expect((log.mock.calls[0][1] as Error).message).toBe(message)
    log.mockRestore()
  })

  // No data and no error is not "no budgets" (#46): read so, the delete dialog would show every
  // budget as absent.
  it('shows the alert when the budgets read returns no data and no error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    results.budgets = { data: null, error: null }
    const tree = await SettingsPage()
    expect(findProps(tree, BankList)).not.toBeNull()
    expect(findProps(tree, CategoryManager)).toBeNull()
    expect(alertText(tree)).toContain("Couldn't load categories and rules.")
    expect((log.mock.calls[0][1] as Error).message).toBe('could not read budgets: read returned no data and no error')
    log.mockRestore()
  })
})
