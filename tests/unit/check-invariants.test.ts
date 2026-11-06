// @vitest-environment node
import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import {
  checkUncheckedReads,
  checkCategoryReads,
  checkRulesReads,
  checkUserCategoryWrites,
  checkSuggestionWrites,
  checkBrandCasts,
  checkTapTargets,
  checkSmBreakpoint,
  TAP_TARGETS_ALLOWED,
  PASS_THROUGH,
  SHARED_CLASSES,
} from '../../scripts/check-invariants.mjs'
import { inputClass, selectClass, tapTargetClass } from '@/components/ui/styles'
import { buttonClass } from '@/components/ui/Button'

// Tripwires 1, 4, 5 and 6, called directly. Fixtures are inline; none lives under app/, lib/ or
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

  // Plaid's client rejects a failed call, so its response has no `error` to check (#91). Skipped by
  // what each destructure calls, not by file, so a Supabase read beside one is still checked.
  it('allows a Plaid response, and still checks a Supabase read in the same file', () => {
    expect(checkUncheckedReads(file('lib/sync.ts', `const { data } = await plaidClient.transactionsSync({ access_token, cursor: next })`))).toEqual([])
    expect(checkUncheckedReads(file('app/api/plaid/exchange-public-token/route.ts', `const { data: ex } = await plaidClient.itemPublicTokenExchange({ public_token })`))).toEqual([])
    const supabaseThenPlaid = `const { data: item } = await supabaseAdmin.from('plaid_items').select('cursor')
const { data } = await plaidClient.transactionsSync({ access_token, cursor: next })`
    expect(lines(checkUncheckedReads(file('lib/sync.ts', supabaseThenPlaid)))).toEqual([1])
    const plaidThenSupabase = `const { data } = await plaidClient.transactionsSync({ access_token, cursor: next })
const { data: item } = await supabaseAdmin.from('plaid_items').select('cursor')`
    expect(lines(checkUncheckedReads(file('lib/sync.ts', plaidThenSupabase)))).toEqual([2])
  })

  // #241: the categories route took a failed read for no row, and answered "unauthorized" or "not
  // found", or saved a new category near the top instead of last. A route has no error page, so the
  // advice differs from a page's.
  it.each(['app/api/categories/route.ts', 'app/auth/confirm/route.ts'])('fires in a route, %s, with advice for a route', (path) => {
    const found = checkUncheckedReads(file(path, `const { data: cat } = await supabase.from('categories').select('name').eq('id', id).maybeSingle()`))
    expect(checks(found)).toEqual(['unchecked-read'])
    expect(found[0].message).toContain('answer with an error')
    expect(found[0].message).not.toContain('error.tsx')
    expect(checkUncheckedReads(file(path, `const { data: cat, error: catError } = await supabase.from('categories').select('name').eq('id', id).maybeSingle()`))).toEqual([])
  })

  // All of app/ is scanned, so a page outside app/(app)/, such as one under app/auth/, is checked
  // too, and as a page.
  it.each([PAGE, 'app/auth/try-again/page.tsx', 'app/login/page.tsx'])('still gives a page the advice to throw: %s', (path) => {
    const found = checkUncheckedReads(file(path, `const { data: goals } = await supabase.from('goals').select('id')`))
    expect(checks(found)).toEqual(['unchecked-read'])
    expect(found[0].message).toContain('app/(app)/error.tsx')
  })

  // The layout logs its failed read, since on most pages nothing else says why a hung one held the page
  // up (#202), so the check covers it like any other read.
  it("fires on the layout's display-name read if it stops binding its error", () => {
    expect(checkUncheckedReads(file('app/(app)/layout.tsx', `const { data: households } = await supabase.from('households').select('id, name').limit(1)`))).toHaveLength(1)
    expect(checkUncheckedReads(file('app/(app)/layout.tsx', `const { data: households, error: householdError } = await supabase.from('households').select('id, name').limit(1)`))).toEqual([])
  })
})

// Tripwire 4 (#28 spec §7.4): a page that reads categories or rules on its own, a write of
// user_category outside the one route allowed it, or a cast that fakes a branded context.
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
  it('fires on clearing picks outside the allowed route', () => {
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
  it('allows the categorize route, and variable payloads in ingest and the sandbox seed', () => {
    expect(checkUserCategoryWrites(file('app/api/transactions/categorize/route.ts', `supabase.from('transactions').update({ user_category: picked.name }, { count: 'exact' })`))).toEqual([])
    expect(checkUserCategoryWrites(file('lib/ingest.ts', `supabase.from('transactions').upsert(upserts, { onConflict: 'plaid_transaction_id' })`))).toEqual([])
    expect(checkUserCategoryWrites(file('scripts/seed-sandbox-bank.mjs', `db.from('transactions').insert(rows)`))).toEqual([])
  })
  it('passes an inline write that does not touch user_category', () => {
    expect(checkUserCategoryWrites(file('app/api/reimbursable/route.ts', `supabase.from('transactions').update({ reimbursable_amount: 5 }, { count: 'exact' })`))).toEqual([])
  })
  // A rename or a delete moves picks in the database, all or nothing (#100). Done from the route,
  // as three requests, a failure partway stranded them.
  it('fires in the categories route, whose rename and delete move picks in the database', () => {
    expect(checks(checkUserCategoryWrites(file('app/api/categories/route.ts', `supabase.from('transactions').update({ user_category: null }).eq('user_category', name)`)))).toEqual(['user-category-write'])
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

// Tripwire 5 (#122): a raw <a>, <Link> or <button> whose classes do not make it a 44px tap target
// below md. Stage 5 of the phone pass raised the shared control classes, and controls with classes
// of their own stayed 16-20px tall on a phone: #122 named eight, and the sweep that followed found
// 19. Each fixture passes its own allowlist, empty unless the test is about one, and the real
// PASS_THROUGH unless it is about another.
describe('tap-target', () => {
  const C = 'components/X.tsx'
  const LINK = `import Link from 'next/link'\n`
  const STYLES = `import { tapTargetClass, inputClass, selectClass } from '@/components/ui/styles'\n`
  const BUTTON = `import { buttonClass } from '@/components/ui/Button'\n`
  type Entry = { file: string; classes: string; reason: string }
  const tap = (src: string, allowed: Entry[] = []) => checkTapTargets(file(C, src), allowed)

  it('fires on a text link with classes of its own, on the line its tag opens', () => {
    const src = `export function X() {
  return (
    <p className="text-sm">
      To rename one, use <a href="/settings" className="text-emerald">Settings</a>.
    </p>
  )
}`
    expect(tap(src).map((f) => [f.check, f.file, f.line])).toEqual([['tap-target', C, 4]])
  })

  // The way to meet the rule, and not the allowlist round it: the allowlist used to be offered for
  // a control "44px tall already", and a control like that still carries the rule itself.
  it('says how to meet the rule, and where a component that passes its classes on goes', () => {
    const [found] = tap('<a href="/x" className="text-emerald">x</a>')
    for (const part of ['tapTargetClass', 'buttonClass', '`inline-flex min-h-[44px] md:min-h-0`', 'PASS_THROUGH', 'TAP_TARGETS_ALLOWED']) {
      expect(found.message).toContain(part)
    }
    expect(found.message).not.toContain('tall already')
  })

  // Why it parses rather than matches: an attribute can hold `=>`, and a pattern that reads a tag to
  // its first `>` stops inside the onClick, before the classes.
  it('reads past a `=>` in an attribute to the classes after it', () => {
    expect(checks(tap('<button type="button" onClick={() => setOpen((v) => !v)} className="text-sm text-emerald">Show all</button>'))).toEqual(['tap-target'])
    expect(tap(STYLES + '<button type="button" onClick={() => setOpen((v) => !v)} className={`${tapTargetClass} text-sm text-emerald`}>Show all</button>')).toEqual([])
  })

  it("fires on next/link's Link, under whatever name it is imported as", () => {
    expect(checks(tap(`${LINK}const v = <Link href="/transactions" className="text-xs">View all</Link>`))).toEqual(['tap-target'])
    expect(checks(tap(`import NextLink from 'next/link'\nconst v = <NextLink href="/transactions">View all</NextLink>`))).toEqual(['tap-target'])
    expect(checks(tap(`import { default as L } from 'next/link'\nconst v = <L href="/transactions">View all</L>`))).toEqual(['tap-target'])
  })

  it('leaves alone a component that is not a control', () => {
    expect(tap('<Card className="p-5"><span className="text-xs">Learned</span></Card>')).toEqual([])
  })

  // SignOutButton hands its className straight to its <button>, so each place it is rendered is a
  // control, checked where its classes are written. However it is reached: a tag with its name is
  // one, from any module, and so is any name its module is imported under. A way of reaching it the
  // check cannot follow fails rather than going unchecked.
  describe('SignOutButton call sites', () => {
    const IMPORT = `import { SignOutButton } from '@/components/SignOutButton'\n`

    it('fires on one whose classes carry no 44px rule', () => {
      expect(checks(tap(`${IMPORT}const out = <SignOutButton className="text-sm text-coral" />`))).toEqual(['tap-target'])
    })

    it('passes one with buttonClass', () => {
      expect(tap(`${IMPORT}${BUTTON}const out = <SignOutButton showLabel={false} className={buttonClass('ghost', 'sm', 'min-w-[44px]')} />`)).toEqual([])
    })

    it('passes one under an element hidden below md', () => {
      expect(tap(`${IMPORT}<aside className="fixed hidden w-64 md:flex"><div><SignOutButton className="mt-1 flex w-full px-3 py-2 text-sm" /></div></aside>`)).toEqual([])
    })

    it('follows it under another name, from a relative path', () => {
      expect(checks(tap(`import { SignOutButton as Out } from './SignOutButton'\nconst out = <Out className="text-sm" />`))).toEqual(['tap-target'])
    })

    it("follows its module's default export", () => {
      expect(checks(tap(`import Out from '@/components/SignOutButton'\nconst out = <Out className="text-sm" />`))).toEqual(['tap-target'])
      expect(checks(tap(`import { default as Out } from '../components/SignOutButton'\nconst out = <Out className="text-sm" />`))).toEqual(['tap-target'])
    })

    it('treats a tag with its name as one, from any module, and a tag ending in it', () => {
      expect(checks(tap(`import { SignOutButton } from 'some-kit'\nconst out = <SignOutButton className="text-sm" />`))).toEqual(['tap-target'])
      expect(checks(tap(`import * as S from '@/components/SignOutButton'\nconst out = <S.SignOutButton className="text-sm" />`))).toEqual(['tap-target'])
      // Imported by name as well, the name after `S.` is still the namespace's, not a value taken.
      expect(tap(`${IMPORT}import * as S from '@/components/SignOutButton'\n${BUTTON}const out = <S.SignOutButton className={buttonClass('ghost', 'sm')} />`)).toEqual([])
    })

    it('reads past imports with no names, or a namespace', () => {
      const src = `import './globals.css'\nimport * as React from 'react'\n${IMPORT}const out = <SignOutButton className="text-sm" />`
      expect(checks(tap(src))).toEqual(['tap-target'])
    })

    it.each([
      ['a re-export', `export { SignOutButton } from '@/components/SignOutButton'`],
      ['a re-export of everything', `export * from './SignOutButton'`],
      ['an import()', `const M = await import('@/components/SignOutButton')`],
      ['a require()', `const M = require('./SignOutButton')`],
      ['the component taken as a value', `${IMPORT}const Out = SignOutButton`],
      ['the component in an object', `${IMPORT}const parts = { SignOutButton }`],
      ['the component exported under its import', `${IMPORT}export { SignOutButton as Out }`],
      ["a namespace's member taken as a value", `import * as S from '@/components/SignOutButton'\nconst Out = S.SignOutButton`],
    ])('fails %s, which it cannot follow to where it is rendered', (_name, src) => {
      const found = tap(src)
      expect(checks(found)).toEqual(['tap-target'])
      expect(found[0].message).toContain('PASS_THROUGH')
    })

    it('leaves alone a type that names it, and the same forms for any other module', () => {
      expect(tap(`${IMPORT}type P = ComponentProps<typeof SignOutButton>`)).toEqual([])
      expect(tap(`export { Card } from './Card'\nconst M = await import('./Chart')\nconst R = require('./Other')`)).toEqual([])
    })
  })

  // A component in PASS_THROUGH is named by its file. There, the control whose classes are exactly
  // the className it was given passes, as its call sites are checked instead; any other control in
  // the file is checked as usual.
  describe('PASS_THROUGH', () => {
    const WRAP = 'components/Wrap.tsx'
    const passThrough = [{ file: WRAP, name: 'Wrap' }]

    it('passes the control in its file that takes the classes it was given, and checks the rest', () => {
      const src = `export function Wrap({ className }: { className: string }) {
  return <button type="button" className={className}>x</button>
}
export function Other() {
  return <a href="/x" className="text-sm">y</a>
}
`
      expect(checkTapTargets(file(WRAP, src), [], { passThrough }).map((f) => [f.check, f.file, f.line])).toEqual([['tap-target', WRAP, 5]])
    })

    it('checks its call sites, and only for a component it names', () => {
      const src = `import { Wrap } from '@/components/Wrap'\nconst w = <Wrap className="text-sm" />`
      expect(checks(checkTapTargets(file(C, src), [], { passThrough }))).toEqual(['tap-target'])
      expect(checkTapTargets(file(C, src), [])).toEqual([])
    })

    // A folder's index.tsx is imported by the folder's name.
    it('follows a component whose file is a folder index', () => {
      const indexed = [{ file: 'components/Wrap/index.tsx', name: 'Wrap' }]
      const src = `import { Wrap as W } from '@/components/Wrap'\nconst w = <W className="text-sm" />`
      expect(checks(checkTapTargets(file(C, src), [], { passThrough: indexed }))).toEqual(['tap-target'])
    })

    it('reports an entry whose file has no control taking the classes it was given', () => {
      const src = 'export function Wrap({ className }: { className: string }) {\n  return <span className={className} />\n}\n'
      const found = checkTapTargets(file(WRAP, src), [], { passThrough })
      expect(found.map((f) => [f.check, f.file, f.line])).toEqual([['tap-target', WRAP, 1]])
      expect(found[0].message).toContain('PASS_THROUGH')
      expect(found[0].message).toContain('{className}')
    })

    it('reports an entry whose file is gone, when told it was given the whole tree', () => {
      const gone = [{ file: 'components/Gone.tsx', name: 'Gone' }]
      expect(checkTapTargets(file(C, 'export const a = 1\n'), [], { passThrough: gone })).toEqual([])
      const found = checkTapTargets(file(C, 'export const a = 1\n'), [], { passThrough: gone, wholeTree: true })
      expect(found.map((f) => [f.check, f.file])).toEqual([['tap-target', 'components/Gone.tsx']])
      expect(found[0].message).toContain('no such file')
    })

    it('does not report an entry because its file did not parse', () => {
      const found = checkTapTargets(file(WRAP, '<button className={className}>x</button'), [], { passThrough })
      expect(checks(found)).toEqual(['tap-target'])
      expect(found[0].message).toMatch(/^does not parse as TSX/)
    })

    it('names each real component by its file and its export', () => {
      expect(PASS_THROUGH.length).toBeGreaterThan(0)
      for (const p of PASS_THROUGH) {
        expect(p.file).toMatch(/^(app|components)\/.+\.tsx$/)
        expect(p.name).toMatch(/^[A-Z][A-Za-z0-9]*$/)
      }
    })
  })

  // The shared classes count only as themselves: tapTargetClass, inputClass and selectClass imported
  // from components/ui/styles, and buttonClass(…) from components/ui/Button, under any name.
  it.each([
    ['tapTargetClass, in a template', STYLES + '<a href="/x" className={`${tapTargetClass} text-sm`}>x</a>'],
    ['tapTargetClass, alone', STYLES + '<a href="/x" className={tapTargetClass}>x</a>'],
    ['tapTargetClass, under another name from a relative path', `import { tapTargetClass as tap } from './ui/styles'\n<a href="/x" className={tap}>x</a>`],
    ['buttonClass', BUTTON + `<a href="/x" className={buttonClass('secondary', 'md')}>x</a>`],
    ['buttonClass, in a template', BUTTON + '<button className={`${buttonClass("ghost", "sm")} w-full`}>x</button>'],
    ['buttonClass, with classes of its own', BUTTON + `<a href="/x" className={buttonClass('ghost', 'sm', 'w-full justify-start')}>x</a>`],
    ['inputClass, on a button', STYLES + '<button className={inputClass}>x</button>'],
    ['min-h-[44px] of its own, on a button, which is inline-block', '<button className="min-h-[44px] text-sm md:min-h-0">⋮</button>'],
    ['min-h-[44px] of its own, with inline-flex', '<a href="/x" className="inline-flex min-h-[44px] min-w-[44px] md:min-h-0 md:h-6">x</a>'],
    ['min-h-[44px] in the text of a template', "<a href=\"/x\" className={`${active ? 'text-emerald' : 'text-faint'} inline-flex min-h-[44px] md:min-h-0`}>x</a>"],
    ['a display and a floor written with !, either side', '<a href="/x" className="!inline-flex min-h-[44px]! md:min-h-0">x</a>'],
    ['a display written [display:…]', '<a href="/x" className="[display:flex] min-h-[44px] md:min-h-0">x</a>'],
    ['other display and min-h classes from md up', '<a href="/x" className="inline-flex min-h-[44px] md:min-h-0 md:inline lg:min-h-8">x</a>'],
  ])('passes a control with %s', (_name, src) => {
    expect(tap(src)).toEqual([])
  })

  // min-height applies to a box with any of these displays, and not to an inline one.
  it.each(['block', 'flex', 'grid', 'inline-block', 'inline-flex', 'inline-grid', 'flow-root', 'list-item', 'table', 'inline-table'])(
    'passes min-h-[44px] on an <a> that is %s',
    (display) => {
      expect(tap(`<a href="/x" className="${display} min-h-[44px] md:min-h-0">x</a>`)).toEqual([])
    }
  )

  it.each([
    ['no classes at all', '<a href="/x">x</a>'],
    ['44px only under a condition', `<a href="/x" className={open ? 'min-h-[44px]' : ''}>x</a>`],
    ['44px only from md', '<a href="/x" className="md:min-h-[44px]">x</a>'],
    ['classes from a prop', '<button className={className}>x</button>'],
    ['a tapTargetClass of its own', `const tapTargetClass = 'text-sm'\nexport const v = <a href="/x" className={tapTargetClass}>x</a>`],
    ['tapTargetClass from another module', `import { tapTargetClass } from '@/lib/classes'\n<a href="/x" className={tapTargetClass}>x</a>`],
    [
      'tapTargetClass declared again inside the file',
      STYLES + `function X() {\n  const tapTargetClass = 'text-sm'\n  return <a href="/x" className={tapTargetClass}>x</a>\n}`,
    ],
    ['buttonClass not imported', `<a href="/x" className={buttonClass('ghost', 'sm')}>x</a>`],
    ['buttonClass not called', BUTTON + '<a href="/x" className={buttonClass}>x</a>'],
    ['buttonClass from another module', `import { buttonClass } from 'some-kit'\n<a href="/x" className={buttonClass('ghost', 'sm')}>x</a>`],
    ['labelClass, which carries no rule', `import { labelClass } from '@/components/ui/styles'\n<a href="/x" className={labelClass}>x</a>`],
    ['tapTargetClass under a condition', STYLES + `<a href="/x" className={open ? tapTargetClass : 'text-sm'}>x</a>`],
  ])('fires on a control with %s', (_name, src) => {
    const found = tap(src)
    expect(checks(found)).toEqual(['tap-target'])
    expect(found[0].message).toContain('has no 44px rule')
  })

  // A floor of its own works only where min-height does, and only on a phone. min-height does nothing
  // on an inline box (an <a>, or a <Link>, which renders one), so a raw floor needs a display that
  // takes it, unless the control is a <button>, which is inline-block. It needs md:min-h-0 beside it,
  // or it reaches the desktop layout. And it must be the only min-h class and display that apply below
  // md, in any branch: Tailwind orders its CSS by its own rules, not by the order in the attribute,
  // and a variant comes after it, so another can win.
  it.each([
    ['is on an <a>, which is inline', '<a href="/x" className="min-h-[44px] text-sm md:min-h-0">x</a>', 'inline box'],
    ['is on a <Link>, which is inline', LINK + '<Link href="/x" className="min-h-[44px] md:min-h-0">x</Link>', 'inline box'],
    ['has its display only under a variant', '<a href="/x" className="hover:inline-flex min-h-[44px] md:min-h-0">x</a>', 'inline box'],
    ['is inputClass, on an <a>', STYLES + '<a href="/x" className={inputClass}>x</a>', 'inline box'],
    ['is not released at md', '<a href="/x" className="inline-flex min-h-[44px]">x</a>', 'without md:min-h-0'],
    ['is released only from lg', '<a href="/x" className="inline-flex min-h-[44px] lg:min-h-0">x</a>', 'without md:min-h-0'],
    ['has another min-h class beside it', '<a href="/x" className="inline-flex min-h-[44px] min-h-0 md:min-h-0">x</a>', '`min-h-0`'],
    ['has sm:min-h-0 beside it', STYLES + '<a href="/x" className={`${tapTargetClass} sm:min-h-0`}>x</a>', '`sm:min-h-0`'],
    ['has max-md:min-h-0 beside it', STYLES + '<a href="/x" className={`${tapTargetClass} max-md:min-h-0`}>x</a>', '`max-md:min-h-0`'],
    ['has min-h-0 in a branch', STYLES + "<a href=\"/x\" className={`${tapTargetClass} ${open ? 'min-h-0' : ''}`}>x</a>", '`min-h-0`'],
    ["has min-h-0 in buttonClass's own classes", BUTTON + `<a href="/x" className={buttonClass('ghost', 'sm', 'min-h-0')}>x</a>`, '`min-h-0`'],
    ['has an inline display beside it', STYLES + '<a href="/x" className={`${tapTargetClass} inline`}>x</a>', '`inline`'],
    ['has [display:inline] beside it', '<a href="/x" className="inline-flex [display:inline] min-h-[44px] md:min-h-0">x</a>', '`[display:inline]`'],
    ['is on a <button> that is display:contents', '<button className="contents min-h-[44px] md:min-h-0">x</button>', '`contents`'],
  ])('fires on a floor that %s', (_name, src, says) => {
    const found = tap(src)
    expect(checks(found)).toEqual(['tap-target'])
    expect(found[0].message).toContain(says)
  })

  // Whatever comes after the classes may replace them, and this check reads only the classes.
  it('fires on a spread after the classes, and passes one before them', () => {
    const found = tap(STYLES + '<a href="/x" className={tapTargetClass} {...rest}>x</a>')
    expect(checks(found)).toEqual(['tap-target'])
    expect(found[0].message).toContain('{...rest}')
    expect(tap(STYLES + '<a {...rest} href="/x" className={tapTargetClass}>x</a>')).toEqual([])
  })

  // In its own module buttonClass is its own name; Button's spread came after its classes, and goes
  // before them now, where it can no longer replace them.
  it('reads buttonClass in the module that defines it, spread and all', () => {
    const B = 'components/ui/Button.tsx'
    const button = (attrs: string) =>
      `export function buttonClass(variant = 'primary', size = 'md', extra = '') {\n  return ''\n}\nexport function Button({ className = '', ...props }) {\n  return <button ${attrs} />\n}\n`
    expect(checkTapTargets(file(B, button('{...props} className={buttonClass(variant, size, className)}')), [])).toEqual([])
    expect(checks(checkTapTargets(file(B, button('className={buttonClass(variant, size, className)} {...props}')), []))).toEqual(['tap-target'])
  })

  // Controls shown only from md up are not a phone's, and §7's 44px is a phone rule.
  it('passes a control under an element hidden below md', () => {
    const sidebar = `${LINK}<aside className="fixed inset-y-0 hidden w-64 md:flex">
  <nav>{NAV.map((n) => <Link key={n} href={n} className="px-3 py-2 text-sm">{n}</Link>)}</nav>
</aside>`
    expect(tap(sidebar)).toEqual([])
    expect(tap('<td className="hidden md:table-cell"><button className="text-xs">x</button></td>')).toEqual([])
    expect(tap('<a href="/x" className="hidden text-xs md:inline">x</a>')).toEqual([])
    expect(tap('<div className={`hidden md:block`}>{open && <button className="text-sm">x</button>}</div>')).toEqual([])
    expect(tap('<div className="[display:none] md:block"><button className="text-sm">x</button></div>')).toEqual([])
    expect(tap('<div className="!hidden md:!block"><button className="text-sm">x</button></div>')).toEqual([])
  })

  // `hidden` counts only where nothing can be added to it: a DOM element's class string with no
  // expression in it. A component's className is its own to use or drop, and an expression can add
  // a class that shows the element. And it counts for the element's children, not for JSX handed to
  // it in another attribute, which may be rendered anywhere.
  it.each([
    ['hidden from md up', '<div className="md:hidden"><button className="text-sm">Show all</button></div>'],
    ['shown from sm', '<div className="hidden sm:block"><button className="text-sm">x</button></div>'],
    ['shown below md by a variant', '<div className="hidden max-md:block"><button className="text-sm">x</button></div>'],
    ['shown by a display beside it', '<div className="hidden flex md:block"><button className="text-sm">x</button></div>'],
    ['hidden only under a condition', `<div className={open ? 'contents' : 'hidden md:contents'}><button className="text-sm">x</button></div>`],
    ['hidden in a template with an expression', "<div className={`hidden md:block ${open ? 'max-md:block' : ''}`}><button className=\"text-sm\">x</button></div>"],
    ["hidden in a component's className", '<Card className="hidden md:block"><button className="text-sm">x</button></Card>'],
    ["hidden in a Link's own className", LINK + '<Link href="/x" className="hidden md:inline">x</Link>'],
    ['handed to a hidden element in another attribute', '<div className="hidden md:block" data-slot={<button className="text-sm">x</button>}>y</div>'],
  ])('still fires on a control %s', (_name, src) => {
    expect(checks(tap(src))).toEqual(['tap-target'])
  })

  it('passes a control the allowlist names by its file and classes, and no other', () => {
    const allowed = [{ file: C, classes: 'block px-4 py-3 text-sm', reason: '46px tall' }]
    expect(tap('<a href="/x" className="block px-4 py-3 text-sm">x</a>', allowed)).toEqual([])
    // However the class string is spaced or broken over lines.
    expect(tap('<a href="/x" className={`block px-4\n      py-3  text-sm`}>x</a>', allowed)).toEqual([])
    expect(checks(checkTapTargets(file('components/Y.tsx', '<a href="/x" className="block px-4 py-3 text-sm">x</a>'), allowed))).toEqual(['tap-target'])
  })

  // The allowlist names a template's expressions `${…}`, and classes that are one expression by it.
  it('names a control whose classes are not one string', () => {
    const allowed = [
      { file: C, classes: 'flex flex-col py-2 ${…}', reason: '53px tall' },
      { file: C, classes: "{cn('flex', className)}", reason: 'tall' },
    ]
    const src = `<nav>
  <a href="/x" className={\`flex flex-col py-2 \${active ? 'text-emerald' : 'text-faint'}\`}>x</a>
  <button className={cn('flex', className)}>y</button>
</nav>`
    expect(tap(src, allowed)).toEqual([])
  })

  // An entry for a control whose classes are one bare prop names a component passing its classes on.
  // It would switch the check off at every place that component is rendered; PASS_THROUGH checks
  // them instead. The entry fails, and so does the control it would have passed.
  it.each(['{className}', '{props.className}'])('fails an entry that names a control by one bare prop, %s', (classes) => {
    const src = `<button className=${classes}>y</button>`
    const found = tap(src, [{ file: C, classes, reason: "the caller's classes" }])
    expect(checks(found)).toEqual(['tap-target', 'tap-target'])
    expect(found[0].message).toContain('has no 44px rule')
    expect(found[1].message).toContain('PASS_THROUGH')
  })

  // Changing an allowlisted control's classes asks the question again, and the entry for the old
  // classes fails too, so the list cannot go on naming a control that is gone.
  it('fires on a changed control, and on the entry that named it before', () => {
    const allowed = [{ file: C, classes: 'block px-4 py-3 text-sm', reason: '46px tall' }]
    const found = tap('<a href="/x" className="block px-4 py-2 text-sm">x</a>', allowed)
    expect(checks(found)).toEqual(['tap-target', 'tap-target'])
    expect(found[1].message).toContain('"block px-4 py-3 text-sm"')
  })

  it('does not call an entry stale when its file was not read', () => {
    const allowed = [{ file: 'components/Other.tsx', classes: 'block', reason: 'tall' }]
    expect(tap(STYLES + '<a href="/x" className={tapTargetClass}>x</a>', allowed)).toEqual([])
  })

  it('reads .tsx files in app/ and components/ only', () => {
    expect(checkTapTargets(file('lib/x.tsx', '<a href="/x">x</a>'), [])).toEqual([])
    expect(checkTapTargets(file('components/x.ts', 'export const a = 1'), [])).toEqual([])
    expect(checks(checkTapTargets(file('app/(app)/x/page.tsx', '<a href="/x">x</a>'), []))).toEqual(['tap-target'])
  })

  // The compiler's parser recovers from a syntax error and goes on, so the controls of a file that
  // does not parse cannot be trusted to be found. The file fails, on the line of the first error.
  it('fails a file whose TSX does not parse, naming it', () => {
    const found = checkTapTargets(file(C, 'export function X() {\n  return <a href="/x">x</a\n}\n'), [])
    expect(found.map((f) => [f.check, f.file, f.line])).toEqual([['tap-target', C, 3]])
    expect(found[0].message).toMatch(/^does not parse as TSX/)
  })

  it('does not call an entry stale because its file did not parse', () => {
    const allowed = [{ file: C, classes: 'block', reason: 'tall' }]
    expect(checks(checkTapTargets(file(C, '<a href="/x" className="block">x</a'), allowed))).toEqual(['tap-target'])
  })

  // Given every file in the tree, as main() is, an entry for a file that is not among them names a
  // file deleted or renamed, and fails. Given some of the files, as the tests above are, it does not.
  it('reports an entry whose file is gone, when told it was given the whole tree', () => {
    const allowed = [{ file: 'components/Gone.tsx', classes: 'block', reason: 'tall' }]
    const src = STYLES + '<a href="/x" className={tapTargetClass}>x</a>'
    expect(checkTapTargets(file(C, src), allowed)).toEqual([])
    const found = checkTapTargets(file(C, src), allowed, { wholeTree: true, passThrough: [] })
    expect(found.map((f) => [f.check, f.file])).toEqual([['tap-target', 'components/Gone.tsx']])
    expect(found[0].message).toContain('no such file')
  })

  // Empty is the aim, and where it is now: a control that can carry the rule carries it, and the one
  // entry there was, SignOutButton's `{className}`, is PASS_THROUGH's to check. So this holds each
  // entry to its shape, if there are any, rather than requiring that there be some.
  it('holds every entry on the real allowlist to a file, classes that are not one bare prop, and a reason', () => {
    for (const e of TAP_TARGETS_ALLOWED) {
      expect(e.file).toMatch(/^(app|components)\/.+\.tsx$/)
      expect(e.classes).not.toMatch(/^\{[\w$.]+\}$/)
      expect(e.reason.length).toBeGreaterThan(20)
    }
  })

  // What the check takes each shared class to give is what the class gives: the floor, its release,
  // and for tapTargetClass and buttonClass a display. Read off the real strings, so the two cannot
  // drift apart.
  it('takes each shared class to give what it does', () => {
    const real: Record<string, string[]> = {
      tapTargetClass: [tapTargetClass],
      inputClass: [inputClass],
      selectClass: [selectClass],
      buttonClass: (['primary', 'secondary', 'ghost', 'danger'] as const).flatMap((v) =>
        (['sm', 'md'] as const).map((s) => buttonClass(v, s))
      ),
    }
    expect(SHARED_CLASSES.map((s) => s.name).sort()).toEqual(Object.keys(real).sort())
    for (const s of SHARED_CLASSES) {
      for (const value of real[s.name]) expect(value.split(/\s+/)).toEqual(expect.arrayContaining(s.gives.split(' ')))
    }
  })

  // The compiler reads identifiers by the language version it targets: below ES2015 a letter beyond
  // the Basic Multilingual Plane is an invalid character, and a valid file would fail as unparseable.
  it('parses as the latest language version does', () => {
    expect(checkTapTargets(file(C, 'export const 𐐀 = 1\n'), [])).toEqual([])
  })

  // A problem with the compiler options is no file's fault. It is reported once, as the check's own,
  // not as every file failing to parse.
  it("reports a problem with its own compiler options once, as the check's", () => {
    const files = [
      { path: C, text: 'export const a = 1\n' },
      { path: 'components/Y.tsx', text: 'export const b = 2\n' },
    ]
    const found = checkTapTargets(files, [], { compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: '!!!' } })
    expect(found.map((f) => [f.check, f.file, f.line])).toEqual([['tap-target', 'scripts/check-invariants.mjs', 1]])
    expect(found[0].message).toContain('compiler options')
    expect(found[0].message).not.toContain('does not parse')
  })
})

// Tripwire 6 (#123): no `sm:` class in app/ or components/. Below md the app has one layout, the
// phone's, and a class that switched at sm (640px) gave 640-767px a piece of the desktop layout
// inside it.
describe('sm-breakpoint', () => {
  it('fires on an sm: class, on its line, naming it', () => {
    const found = checkSmBreakpoint(file('components/X.tsx', 'export function X() {\n  return <div className="grid gap-4 sm:grid-cols-2" />\n}\n'))
    expect(found.map((f) => [f.check, f.file, f.line])).toEqual([['sm-breakpoint', 'components/X.tsx', 2]])
    expect(found[0].message).toContain('`sm:grid-cols-2`')
  })

  it.each([
    ['a class string in a .ts module', 'components/ui/x.ts', `export const big = 'text-xl sm:text-2xl'`],
    ['a template', 'app/(app)/x/page.tsx', 'const c = `flex ${a} sm:flex-row`'],
    ['a branch', 'components/X.tsx', `const c = open ? 'sm:block' : 'hidden'`],
    ['sm: after another variant', 'components/X.tsx', `const c = 'hover:sm:underline'`],
    ['sm: before another variant', 'components/X.tsx', `const c = 'sm:hover:underline'`],
    ['max-sm:', 'components/X.tsx', `const c = 'max-sm:hidden'`],
  ])('fires on %s', (_name, path, text) => {
    expect(checks(checkSmBreakpoint(file(path, text)))).toEqual(['sm-breakpoint'])
  })

  it.each([
    ['md: and wider', `const c = 'md:grid-cols-2 lg:grid-cols-3'`],
    ["Button's size names", `const sizes = { sm: 'min-h-[44px] md:h-8' }\nconst b = buttonClass('ghost', 'sm')`],
    ['a comment', `// was sm:grid-cols-2 (#123)\nconst c = 'grid'`],
    ['a container query', `const c = '@sm:flex-row'`],
  ])('passes %s', (_name, text) => {
    expect(checkSmBreakpoint(file('components/X.tsx', text))).toEqual([])
  })

  it('reads app/ and components/ only', () => {
    expect(checkSmBreakpoint(file('lib/x.ts', `const c = 'sm:block'`))).toEqual([])
    expect(checkSmBreakpoint(file('scripts/x.mjs', `const c = 'sm:block'`))).toEqual([])
    expect(checks(checkSmBreakpoint(file('app/x.tsx', `const c = 'sm:block'`)))).toEqual(['sm-breakpoint'])
  })
})
