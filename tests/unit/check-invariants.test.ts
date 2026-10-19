// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  checkUncheckedReads,
  checkCategoryReads,
  checkRulesReads,
  checkUserCategoryWrites,
  checkSuggestionWrites,
  checkBrandCasts,
} from '../../scripts/check-invariants.mjs'

// Tripwires 1 and 4, called directly. Fixtures are inline; none lives under app/, lib/ or
// components/.
const file = (path: string, text: string) => [{ path, text }]
const checks = (r: { check: string }[]) => r.map((f) => f.check)
const lines = (r: { line: number }[]) => r.map((f) => f.line)

// Tripwire 1 (#46, widened in #91): a destructured read that binds `data` or `count` and not
// `error`, so a failed read renders the same as no data. Most fixtures below are a shape the
// line-based version could not see, or one it must not fire on.
describe('unchecked-read', () => {
  const PAGE = 'app/(app)/x/page.tsx'

  it('fires on a page that destructures data without error', () => {
    expect(checks(checkUncheckedReads(file(PAGE, `const { data: goals } = await supabase.from('goals').select('id')`)))).toEqual(['unchecked-read'])
  })

  it('passes a page that binds error', () => {
    expect(checkUncheckedReads(file(PAGE, `const { data: goals, error } = await supabase.from('goals').select('id')`))).toEqual([])
  })

  // #91: lib/manual-assets.ts and lib/plaid-items.ts each swallowed their own read, and the pages
  // that called them could not tell the empty list from none.
  it('fires in lib/, on the line the destructure starts', () => {
    const src = `export async function listManualAssets(householdId) {
  const { data } = await supabaseAdmin
    .from('manual_assets')
    .select('id, name, value, updated_at')
    .eq('household_id', householdId)
  return data ?? []
}`
    const found = checkUncheckedReads(file('lib/manual-assets.ts', src))
    expect(found.map((f) => [f.check, f.file, f.line])).toEqual([['unchecked-read', 'lib/manual-assets.ts', 2]])
  })

  it('reads a destructure whole, however many lines it spans', () => {
    const unchecked = `const {
  data: goals,
} = await supabase.from('goals').select('id')`
    const checked = `const {
  data: goals,
  error: goalsError,
} = await supabase.from('goals').select('id')`
    expect(checks(checkUncheckedReads(file(PAGE, unchecked)))).toEqual(['unchecked-read'])
    expect(checkUncheckedReads(file(PAGE, checked))).toEqual([])
  })

  // #91: Settings read transactions and budgets as const [{ data: catTxns }, { data: budgetRows }].
  // Each read in the array is its own read: one that binds error does not cover its neighbour.
  it('fires on an array destructure for each read in it that binds data without error', () => {
    const src = `const [{ data: catTxns }, { data: budgetRows, error: budgetsError }, { data: goals }] = await Promise.all([
  supabase.from('transactions').select('id'),
  supabase.from('budgets').select('category'),
  supabase.from('goals').select('id'),
])`
    const found = checkUncheckedReads(file(PAGE, src))
    expect(checks(found)).toEqual(['unchecked-read', 'unchecked-read'])
    expect(found.map((f) => f.message)).toEqual([
      expect.stringContaining('destructures `data` without `error`'),
      expect.stringContaining('destructures `data` without `error`'),
    ])
  })

  it('passes an array destructure whose every read binds error', () => {
    const src = `const [{ data: a, error: aError }, { data: b, error: bError }] = await Promise.all([x, y])`
    expect(checkUncheckedReads(file(PAGE, src))).toEqual([])
  })

  it('does not take a bare name in an array pattern for a read', () => {
    expect(checkUncheckedReads(file('lib/crypto.ts', `const [iv, tag, data] = payload.split(':')`))).toEqual([])
  })

  // #91: Settings' const { count } printed "No banks connected yet." when the read failed.
  it.each([
    [`const { count } = await supabase.from('accounts').select('id', { count: 'exact', head: true })`],
    [`const { count: n } = await supabase.from('accounts').select('id', { count: 'exact', head: true })`],
  ])('fires on a count without error: %s', (src) => {
    const found = checkUncheckedReads(file(PAGE, src))
    expect(checks(found)).toEqual(['unchecked-read'])
    expect(found[0].message).toContain('destructures `count` without `error`')
  })

  it('passes a count that binds error', () => {
    const src = `const { count, error } = await supabase.from('accounts').select('id', { count: 'exact', head: true })`
    expect(checkUncheckedReads(file(PAGE, src))).toEqual([])
  })

  // A failed auth check reads as signed out, which is a different defect (#143), not a wrong number.
  it.each([
    ['on one line', 'const { data: { user } } = await supabase.auth.getUser()'],
    ['across lines', 'const {\n  data: { user },\n} = await supabase\n  .auth\n  .getUser()'],
  ])('leaves out an auth.getUser() destructure %s', (_name, src) => {
    expect(checkUncheckedReads(file(PAGE, src))).toEqual([])
  })

  it('still fires on a read right after an auth.getUser() destructure', () => {
    const src = `const { data: { user } } = await supabase.auth.getUser()
const { data: goals } = await supabase.from('goals').select('id')`
    expect(lines(checkUncheckedReads(file(PAGE, src)))).toEqual([2])
  })

  it('ignores a destructure in a comment or a string', () => {
    const src = `// const { data } = await supabase.from('goals').select('id')
const sql = 'const { data } = await supabase.from(goals)'`
    expect(checkUncheckedReads(file(PAGE, src))).toEqual([])
  })

  it("allows the layout's display-name read, and lib/sync.ts's Plaid response", () => {
    expect(checkUncheckedReads(file('app/(app)/layout.tsx', `const { data: households } = await supabase.from('households').select('id, name').limit(1)`))).toEqual([])
    expect(checkUncheckedReads(file('lib/sync.ts', `const { data } = await plaidClient.transactionsSync({ access_token, cursor: next })`))).toEqual([])
  })
})

// Tripwire 4 (#28 spec §7.4): a page that reads categories or rules on its own, a write of
// user_category outside the two routes allowed it, or a cast that fakes a branded context.
describe('category-read', () => {
  it('fires on a page reading categories itself', () => {
    expect(checks(checkCategoryReads(file('app/(app)/x/page.tsx', `supabase.from('categories').select('id')`)))).toEqual(['category-read'])
  })
  it('fires on pfcToName outside lib/categories.ts and lib/category-rules.ts', () => {
    expect(checks(checkCategoryReads(file('lib/x.ts', 'const m = pfcToName(cats)')))).toEqual(['category-read'])
  })
  it('allows the helper and the three routes', () => {
    for (const p of ['lib/category-context.ts', 'app/api/categories/route.ts', 'app/api/transactions/categorize/route.ts', 'app/api/category-rules/route.ts']) {
      expect(checkCategoryReads(file(p, `supabase.from('categories').select('id')`))).toEqual([])
    }
    expect(checkCategoryReads(file('lib/category-rules.ts', 'pfcToName(categories)'))).toEqual([])
  })
  it('ignores a mention in a comment', () => {
    expect(checkCategoryReads(file('lib/x.ts', `// never call .from('categories') here`))).toEqual([])
  })
})

describe('rules-read', () => {
  it('fires outside the helper and the two routes', () => {
    expect(checks(checkRulesReads(file('app/(app)/x/page.tsx', `supabase.from('category_rules').select('id')`)))).toEqual(['rules-read'])
  })
  it('allows the helper and the two routes', () => {
    for (const p of ['lib/category-context.ts', 'app/api/transactions/categorize/route.ts', 'app/api/category-rules/route.ts']) {
      expect(checkRulesReads(file(p, `supabase.from('category_rules').select('id')`))).toEqual([])
    }
  })
})

describe('user-category-write', () => {
  it('fires on clearing picks outside the allowed routes', () => {
    expect(checks(checkUserCategoryWrites(file('lib/x.ts', `await supabase.from('transactions').update({ user_category: null }).eq('id', id)`)))).toEqual(['user-category-write'])
  })
  it('fires on a multi-line update whose third key is user_category', () => {
    const src = `await supabase
      .from('transactions')
      .update({
        removed: false,
        reimbursable_note: null,
        user_category: 'Grocery',
      })
      .eq('id', id)`
    expect(checks(checkUserCategoryWrites(file('app/api/x/route.ts', src)))).toEqual(['user-category-write'])
  })
  it('fires on a payload held in a variable, and on a spread', () => {
    expect(checks(checkUserCategoryWrites(file('lib/x.ts', `await supabase.from('transactions').update(patch).eq('id', id)`)))).toEqual(['user-category-write'])
    expect(checks(checkUserCategoryWrites(file('lib/x.ts', `await supabase.from('transactions').update({ ...patch }).eq('id', id)`)))).toEqual(['user-category-write'])
  })
  it('fires in a scripts/ .mjs file', () => {
    expect(checks(checkUserCategoryWrites(file('scripts/fix.mjs', `await db.from('transactions').update({ user_category: 'x' })`)))).toEqual(['user-category-write'])
  })
  it('does not fire on the isCreditCardPayment argument shape, or a select naming the column', () => {
    expect(checkUserCategoryWrites(file('components/X.tsx', `isCreditCardPayment({ pfc_detailed: p, user_category: c })`))).toEqual([])
    expect(checkUserCategoryWrites(file('lib/x.ts', `supabase.from('transactions').select('id, user_category').eq('removed', false)`))).toEqual([])
  })
  it('allows the categorize and categories routes, and variable payloads in ingest and the sandbox seed', () => {
    expect(checkUserCategoryWrites(file('app/api/transactions/categorize/route.ts', `supabase.from('transactions').update({ user_category: picked.name }, { count: 'exact' })`))).toEqual([])
    expect(checkUserCategoryWrites(file('app/api/categories/route.ts', `supabase.from('transactions').update({ user_category: null }).eq('user_category', name)`))).toEqual([])
    expect(checkUserCategoryWrites(file('lib/ingest.ts', `supabase.from('transactions').upsert(upserts, { onConflict: 'plaid_transaction_id' })`))).toEqual([])
    expect(checkUserCategoryWrites(file('scripts/seed-sandbox-bank.mjs', `db.from('transactions').insert(rows)`))).toEqual([])
  })
  it('passes an inline write that does not touch user_category', () => {
    expect(checkUserCategoryWrites(file('app/api/reimbursable/route.ts', `supabase.from('transactions').update({ reimbursable_amount: 5 }, { count: 'exact' })`))).toEqual([])
  })
  it('covers the suggestion job too (#28 spec §14.9)', () => {
    expect(checks(checkUserCategoryWrites(file('lib/category-suggest.ts', `await supabaseAdmin.from('transactions').update({ user_category: 'x' })`)))).toEqual(['user-category-write'])
  })
})

describe('suggestion-write', () => {
  it.each(['insert', 'upsert', 'update', 'delete'])('fires on .%s() outside lib/category-suggest.ts', (method) => {
    const src = `await supabaseAdmin.from('category_suggestions').${method}(rows, { count: 'exact' })`
    const found = checkSuggestionWrites(file('app/api/x/route.ts', src))
    expect(checks(found)).toEqual(['suggestion-write'])
    expect(found[0].message).toBe('writes category_suggestions outside lib/category-suggest.ts, the one writer (#28 spec §14.9).')
  })
  it('fires on a multi-line chain with a filter before the write', () => {
    const src = `await supabase
      .from("category_suggestions")
      .delete()
      .eq('household_id', id)`
    expect(checks(checkSuggestionWrites(file('lib/x.ts', src)))).toEqual(['suggestion-write'])
  })
  it('allows the job itself', () => {
    expect(checkSuggestionWrites(file('lib/category-suggest.ts', `await supabaseAdmin.from('category_suggestions').upsert(rows, { onConflict: 'transaction_id', count: 'exact' })`))).toEqual([])
  })
  it('does not fire on a read, anywhere', () => {
    expect(checkSuggestionWrites(file('app/(app)/x/page.tsx', `supabase.from('category_suggestions').select('transaction_id', { count: 'exact', head: true })`))).toEqual([])
  })
  it('ignores a mention in a comment', () => {
    expect(checkSuggestionWrites(file('lib/x.ts', `// never .from('category_suggestions').delete() here`))).toEqual([])
  })
})

describe('brand-cast', () => {
  it.each(['as CategoryData', 'as unknown as CategoryContext', 'as KindContext', 'as SpendContext'])('fires on `%s` outside the producers', (cast) => {
    expect(checks(checkBrandCasts(file('app/(app)/x/page.tsx', `const c = x ${cast}`)))).toEqual(['brand-cast'])
  })
  it('allows the three producers', () => {
    for (const p of ['lib/category-rules.ts', 'lib/category-context.ts', 'lib/spend-context.ts']) {
      expect(checkBrandCasts(file(p, 'return x as CategoryData'))).toEqual([])
    }
  })
})
