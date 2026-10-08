// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  checkCategoryReads,
  checkRulesReads,
  checkUserCategoryWrites,
  checkBrandCasts,
} from '../../scripts/check-invariants.mjs'

// Tripwire 4 (#28 spec §7.4): a page that reads categories or rules on its own, a write of
// user_category outside the two routes allowed it, or a cast that fakes a branded context.
// Fixtures are inline; none lives under app/, lib/ or components/.
const file = (path: string, text: string) => [{ path, text }]
const checks = (r: { check: string }[]) => r.map((f) => f.check)

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
