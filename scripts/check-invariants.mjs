#!/usr/bin/env node
// Tripwires for the defect classes this repo has shipped, and one (4) it measured before it could.
//
// These are greps, not proofs. They cannot understand the code — they can only notice a shape that
// has been wrong before. That is deliberate: each one exists because a real bug reached production
// and a person had to find it by reading. A tripwire that catches the next instance of a defect we
// have already paid for is worth more than a clever analysis of one we have not.
//
// Every known violation is ALLOWED BY NAME below, with a reason and an issue number. The allowlist
// is the outstanding debt, written down. Adding to it should feel like a decision; removing from it
// is how the debt gets paid.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

// ---------------------------------------------------------------------------
// 1. Every read checks `error`: anywhere in app/, pages and routes alike, and in lib/.
//
// #46, and again in #68, and again in #77. A Supabase read that fails sets `data` to null, and
// `?? []` turns that into an empty array — so "the query failed" and "you have no data" render
// identically. On the dashboard that was not even an empty state: with the categories read failing,
// income stopped being excluded from spending and the tiles read -$1,530.90 and +$1,530.90 against
// a truth of $2,846.20 and $1,530.90 (illustrative figures). A number the reader would act on.
//
// #91 found six unchecked reads this check could not see while it matched `const { data` one line at
// a time in app/(app)/ only: two lib/ helpers whose empty lists dropped the house from net worth and
// hid the "isn't syncing" banner, an array destructure of two reads in a Promise.all, and a
// `const { count }`. A destructure split across lines was invisible to it too. So it reads code, not
// lines. Comments and strings are blanked first (views(), under check 3), and each destructure is
// read whole, however many lines it spans. It fires when an object pattern binds `data` or `count`
// and not `error`: `const { data } = …`, or each object of an array pattern on its own, as in
// `const [{ data: a }, { data: b }] = await Promise.all(…)`.
//
// Scanned: all of app/, and lib/. Until #241 only app/(app)/ and lib/ were, and the categories route
// took five failed reads for no row: it answered "unauthorized" or "not found", or saved a new
// category near the top instead of last, and logged nothing. Once those checked their error, nothing
// else in app/ fired. A route (route.ts) has no error page, so it's told to log and answer with an
// error instead of throwing.
// Not counted: a destructure of `auth.getUser()`. A failed auth check reads as signed out, a
// different defect (#143). Nor one of a Plaid call's response: Plaid's client rejects a failed call,
// so there is no `error` to check, and the failure reaches the caller as a throw (#91).
// app/(app)/layout.tsx is held to it too, though it logs its failed read rather than throwing, because it
// sits above app/(app)/error.tsx (#202).
// ---------------------------------------------------------------------------
const READS_ALLOWED = new Map([])
const READ_SCOPES = ['app/', 'lib/']
const isRoute = (path) => /(^|\/)route\.tsx?$/.test(path)

// Index of the bracket that closes the one opening at `open`, in blanked source.
function closeBracket(code, open) {
  let depth = 0
  for (let k = open; k < code.length; k++) {
    if ('{[('.includes(code[k])) depth++
    else if ('}])'.includes(code[k]) && --depth === 0) return k
  }
  return code.length
}

// The top-level, comma-separated parts of a pattern's inside, e.g. `data: a, error` -> two parts.
function parts(inside) {
  const out = []
  let depth = 0
  let from = 0
  for (let k = 0; k < inside.length; k++) {
    if ('{[('.includes(inside[k])) depth++
    else if ('}])'.includes(inside[k])) depth--
    else if (inside[k] === ',' && depth === 0) {
      out.push(inside.slice(from, k))
      from = k + 1
    }
  }
  out.push(inside.slice(from))
  return out.map((p) => p.trim()).filter(Boolean)
}

// What an object pattern leaves unchecked: `data` or `count` bound without `error`, else null.
function uncheckedIn(pattern) {
  const keys = new Set(parts(pattern.slice(1, -1)).map((p) => /^[A-Za-z_$][\w$]*/.exec(p)?.[0]))
  if (keys.has('error')) return null
  return ['data', 'count'].find((k) => keys.has(k)) ?? null
}

export function checkUncheckedReads(files) {
  const out = []
  for (const { path, text } of files) {
    if (!READ_SCOPES.some((scope) => path.startsWith(scope))) continue
    if (READS_ALLOWED.has(path)) continue
    const { code } = views(text)
    for (const at of findAll(/\bconst\s*[{[]/g, code)) {
      const open = at + code.slice(at).search(/[{[]/)
      const close = closeBracket(code, open)
      // `= await supabase.auth.getUser()`, the awaited call named up to its first parenthesis.
      const callee = /^\s*=\s*await\s+([^(;]*)\(/.exec(code.slice(close + 1))?.[1] ?? ''
      if (/\bauth\s*\.\s*getUser\s*$/.test(callee)) continue
      if (/^\s*plaidClient\s*\./.test(callee)) continue
      const pattern = code.slice(open, close + 1)
      const objects = pattern[0] === '{' ? [pattern] : parts(pattern.slice(1, -1)).filter((p) => p[0] === '{')
      for (const object of objects) {
        const name = uncheckedIn(object)
        if (!name) continue
        out.push({
          check: 'unchecked-read',
          file: path,
          line: lineOf(text, at),
          message: isRoute(path)
            ? `destructures \`${name}\` without \`error\`. A failed read must not be taken for no row ` +
              '(#241) — check `error`, log it, and answer with an error.'
            : `destructures \`${name}\` without \`error\`. A failed read must not render identically to no ` +
              'data (#46, #91) — check `error` and throw, so app/(app)/error.tsx can show a retryable message.',
        })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 2. No calendar value is read off the runtime clock.
//
// #73. `new Date()` on the server is UTC on Vercel while the household is in US Eastern, so for
// about 18% of the year the server's calendar day is not the household's — the app said "Good
// morning" at 8pm, and for four hours at every month end the money tiles reported the wrong month.
//
// getUTC* paired with a Date.UTC construction is fine: the two cancel and no local zone is involved.
// ---------------------------------------------------------------------------
const CLOCK_ALLOWED = new Map([])

export function checkRuntimeClock(files) {
  const out = []
  for (const { path, text } of files) {
    if (CLOCK_ALLOWED.has(path)) continue
    text.split('\n').forEach((line, i) => {
      const match = line.match(/\.get(Hours|Month|FullYear|Date|Day)\(\)/)
      if (!match || /getUTC/.test(line)) return
      out.push({
        check: 'runtime-clock',
        file: path,
        line: i + 1,
        message:
          `reads .get${match[1]}() off the runtime clock, which is UTC on Vercel and not the ` +
          "household's zone (#73). Resolve the day through lib/clock.ts, or construct with Date.UTC " +
          'and read it back with getUTC*.',
      })
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 3. Every `transactions` read is bounded, or reads every page.
//
// #69. PostgREST truncates each response at the project's max-rows (1,000) with a 200 OK and no
// error, so a read that matches more renders the first 1,000 as though they were all of it. On
// 2026-10-05 Settings counted 1,000 of 1,366 transactions, and the dashboard's six-month window
// held 908, set to pass 1,000 around the 20th of the month.
//
// A read passes if it goes through lib/read-all.ts's readAllRows, which pages past the cap, or if
// it bounds itself at or under the cap: .limit(n) or .range(a, b) (a literal over 1,000 is no
// bound, since the server caps it anyway), .single()/.maybeSingle(), or a count-only select
// (`head: true` in the .select() options). .order() alone does not pass: it makes the truncated
// set the same on every request, and it is still truncated.
//
// This reads code, not lines. Comments and string contents are blanked out first, the query chain
// is followed by matching its own parentheses, and the readAllRows exemption applies only to a read
// INSIDE that call's parentheses. A line-based version passed reads that merely sat near a bounded
// call, or under a comment that mentioned one.
// ---------------------------------------------------------------------------
const TXN_READS_ALLOWED = new Map([
  [
    'app/(app)/reimbursements/page.tsx',
    'Reads marked rows only (reimbursable_amount not null), all-time because the FIFO allocation ' +
      'needs every one. They accumulate at a handful a month, so 1,000 is years away. Not paged, ' +
      'and not protected by its .order(): wrap it in readAllRows if the marked count nears the cap.',
  ],
  ['lib/receivable.ts', 'The same marked-rows read as reimbursements/page.tsx, for the same reason.'],
  ['lib/ingest.ts', 'Writes and cursor-driven pulls, not a page read.'],
])
const PAGE_CAP = 1000

// Two views of the source, each the same length with newlines kept, so an index into either is an
// index into the original:
// - `text`: comments blanked out, strings intact (to find `.from('transactions')` and read args);
// - `code`: string contents blanked too, so a parenthesis inside a string cannot unbalance anything.
function views(src) {
  const text = src.split('')
  const code = src.split('')
  const blank = (arr, from, to) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const line = src[i + 1] === '/'
      const end = src.indexOf(line ? '\n' : '*/', i + 2)
      const stop = end === -1 ? src.length : line ? end : end + 2
      blank(text, i, stop)
      blank(code, i, stop)
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      blank(code, i + 1, j)
      i = j + 1
    } else i++
  }
  return { text: text.join(''), code: code.join('') }
}

// Index of the parenthesis that closes the one opening at `open`, in blanked source.
function closeOf(code, open) {
  let depth = 0
  for (let k = open; k < code.length; k++) {
    if (code[k] === '(') depth++
    else if (code[k] === ')' && --depth === 0) return k
  }
  return code.length
}

// The calls chained onto `.from(...)`, in order: [{ name, args, codeArgs, close }], with `args`
// taken from the comment-free source so string arguments survive, `codeArgs` from the blanked
// source, and `close` the index of the call's closing parenthesis.
function chainAfter(code, text, from) {
  const calls = []
  let k = closeOf(code, code.indexOf('(', from)) + 1
  for (;;) {
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(k))
    if (!m) return calls
    const open = k + m[0].length - 1
    const close = closeOf(code, open)
    calls.push({ name: m[1], args: text.slice(open + 1, close), codeArgs: code.slice(open + 1, close), close })
    k = close + 1
  }
}

// True if the index sits inside the parentheses of a readAllRows( call.
function insideReadAllRows(code, at) {
  let depth = 0
  for (let k = at - 1; k >= 0; k--) {
    if (code[k] === ')') depth++
    else if (code[k] === '(') {
      if (depth > 0) depth--
      else if (/readAllRows\s*$/.test(code.slice(Math.max(0, k - 40), k))) return true
    }
  }
  return false
}

const lineOf = (text, at) => text.slice(0, at).split('\n').length

const literalInts = (args) => args.split(',').map((a) => (/^\s*\d+\s*$/.test(a) ? Number(a) : null))

function boundsItself(calls) {
  return calls.some(({ name, args }) => {
    if (name === 'single' || name === 'maybeSingle') return true
    if (name === 'select') return /\bhead\s*:\s*true\b/.test(args)
    if (name === 'limit') {
      const [n] = literalInts(args)
      return n === null || n <= PAGE_CAP
    }
    if (name === 'range') {
      const [a, b] = literalInts(args)
      return a === null || b === null || b - a + 1 <= PAGE_CAP
    }
    return false
  })
}

export function checkTxnReads(files) {
  const out = []
  for (const { path, text } of files) {
    if (TXN_READS_ALLOWED.has(path)) continue
    const { text: commentFree, code } = views(text)
    const fromRe = /\.from\(\s*(['"])transactions\1\s*\)/g
    let match
    while ((match = fromRe.exec(commentFree))) {
      const at = match.index
      if (insideReadAllRows(code, at)) continue
      const calls = chainAfter(code, commentFree, at)
      const names = calls.map((c) => c.name)
      const reads = names.includes('select') && !names.some((n) => /^(update|upsert|insert|delete)$/.test(n))
      if (!reads || boundsItself(calls)) continue
      out.push({
        check: 'unbounded-txn-read',
        file: path,
        line: lineOf(text, at),
        message:
          'reads transactions with no bound at or under 1,000 rows. PostgREST truncates at 1,000 with ' +
          'a 200 OK and no error, and .order() alone does not stop that (#69). Wrap the query in ' +
          'readAllRows (lib/read-all.ts), or bound it.',
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 4. Categories and rules are read in one place, and only one route writes user_category.
//
// #28. A category name comes from resolveCategory (lib/category-rules.ts), over a context only
// fetchCategoryContext (lib/category-context.ts) can produce. A page that read categories itself
// and built its own map would compile, ignore every rule, and show Safeway under Food & Drink on
// one page and Grocery on the next. And a rule must never write user_category: any value there on
// a card payment re-enters it into every total. With illustrative figures, on a $6,412.58 autopay (#59),
// one pick would take September's spending from $3,210.47 to -$3,202.11.
//
// Renaming or deleting a category moves picks too, but inside the database, in rename_category and
// delete_category (db/migrations/023), so that no failure partway can strand them (#100). The
// categories route itself writes no transactions.
// ---------------------------------------------------------------------------
const CATEGORY_READS_ALLOWED = new Map([
  ['lib/category-context.ts', 'The one read every page goes through.'],
  ['app/api/categories/route.ts', 'Manages categories.'],
  ['app/api/transactions/categorize/route.ts', 'Validates a pick against the whole category list, and builds the kind gate for learning from it.'],
  ['app/api/category-rules/route.ts', 'Validates a Change: the target must count the same way.'],
])
const PFC_TO_NAME_ALLOWED = new Set(['lib/categories.ts', 'lib/category-rules.ts'])
const RULES_READS_ALLOWED = new Map([
  ['lib/category-context.ts', 'The one read every page goes through.'],
  ['app/api/transactions/categorize/route.ts', 'Learns a rule from a first pick (spec §6.1 step 8).'],
  ['app/api/category-rules/route.ts', 'Change and Remove.'],
])
const USER_CATEGORY_WRITERS = new Map([
  ['app/api/transactions/categorize/route.ts', 'Sets a pick on one transaction, with guards (spec §6.1).'],
])
const VARIABLE_PAYLOADS_ALLOWED = new Map([
  ['lib/ingest.ts', 'Its upserts come from transactionUpsertRow, which never carries user_category (tests/unit/ingest-reimbursable.test.ts).'],
  ['scripts/seed-sandbox-bank.mjs', 'Sandbox rows, never a user_category.'],
])
const BRAND_PRODUCERS = new Set(['lib/category-rules.ts', 'lib/category-context.ts', 'lib/spend-context.ts'])

function findAll(re, src) {
  const at = []
  let m
  while ((m = re.exec(src))) at.push(m.index)
  return at
}

export function checkCategoryReads(files) {
  const out = []
  for (const { path, text } of files) {
    const { text: commentFree, code } = views(text)
    if (!CATEGORY_READS_ALLOWED.has(path)) {
      for (const at of findAll(/\.from\(\s*(['"])categories\1\s*\)/g, commentFree)) {
        out.push({ check: 'category-read', file: path, line: lineOf(text, at), message:
          'reads categories directly. Use fetchCategoryContext (lib/category-context.ts), so rules apply (#28).' })
      }
    }
    if (!PFC_TO_NAME_ALLOWED.has(path)) {
      for (const at of findAll(/\bpfcToName\s*\(/g, code)) {
        out.push({ check: 'category-read', file: path, line: lineOf(text, at), message:
          'builds its own Plaid-to-name map, which ignores rules. Resolve through resolveCategory (#28).' })
      }
    }
  }
  return out
}

export function checkRulesReads(files) {
  const out = []
  for (const { path, text } of files) {
    if (RULES_READS_ALLOWED.has(path)) continue
    for (const at of findAll(/\.from\(\s*(['"])category_rules\1\s*\)/g, views(text).text)) {
      out.push({ check: 'rules-read', file: path, line: lineOf(text, at), message:
        'reads category_rules outside lib/category-context.ts and the two routes allowed to (#28).' })
    }
  }
  return out
}

// The first top-level argument of a call, from its blanked source.
function firstArg(codeArgs) {
  let depth = 0
  for (let k = 0; k < codeArgs.length; k++) {
    const c = codeArgs[k]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) return codeArgs.slice(0, k)
  }
  return codeArgs
}

export function checkUserCategoryWrites(files) {
  const out = []
  for (const { path, text } of files) {
    const { text: commentFree, code } = views(text)
    for (const at of findAll(/\.from\(\s*(['"])transactions\1\s*\)/g, commentFree)) {
      const calls = chainAfter(code, commentFree, at)
      const write = calls.find((c) => /^(update|upsert|insert)$/.test(c.name))
      if (!write) continue
      const line = lineOf(text, at)
      const chain = commentFree.slice(at, calls[calls.length - 1].close + 1)
      if (/\buser_category\b/.test(chain) && !USER_CATEGORY_WRITERS.has(path)) {
        out.push({ check: 'user-category-write', file: path, line, message:
          'writes user_category outside the categorize route. A rule must never write it, any value on a ' +
          'card payment re-enters it into every total (#28, #59), and a rename or delete moves picks in the ' +
          'database, all or nothing (#100).' })
        continue
      }
      const payload = firstArg(write.codeArgs).trim()
      if ((!payload.startsWith('{') || payload.includes('...')) && !VARIABLE_PAYLOADS_ALLOWED.has(path)) {
        out.push({ check: 'user-category-write', file: path, line, message:
          'writes transactions with a payload this check cannot read (a variable or a spread), so it cannot ' +
          'tell whether user_category is in it. Write an inline object literal, or allowlist the file with a reason (#28).' })
      }
    }
  }
  return out
}

// Jev's suggestions (#28 spec §14.9) have one writer, the job in lib/category-suggest.ts, which
// stamps every row with the catalogue fingerprint and the model. A write from anywhere else could
// store a suggestion no gate checked; reads are free, since every page embeds them.
const SUGGESTION_WRITER = 'lib/category-suggest.ts'

export function checkSuggestionWrites(files) {
  const out = []
  for (const { path, text } of files) {
    if (path === SUGGESTION_WRITER) continue
    const { text: commentFree, code } = views(text)
    for (const at of findAll(/\.from\(\s*(['"])category_suggestions\1\s*\)/g, commentFree)) {
      const calls = chainAfter(code, commentFree, at)
      if (!calls.some((c) => /^(insert|upsert|update|delete)$/.test(c.name))) continue
      out.push({ check: 'suggestion-write', file: path, line: lineOf(text, at), message:
        'writes category_suggestions outside lib/category-suggest.ts, the one writer (#28 spec §14.9).' })
    }
  }
  return out
}

export function checkBrandCasts(files) {
  const out = []
  for (const { path, text } of files) {
    if (BRAND_PRODUCERS.has(path)) continue
    for (const at of findAll(/\bas\s+(CategoryData|KindContext|CategoryContext|SpendContext)\b/g, views(text).code)) {
      out.push({ check: 'brand-cast', file: path, line: lineOf(text, at), message:
        'casts to a branded category type. Build it through its producer, so the rules cannot be left out (#28).' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 5. A control shown on a phone is a 44px tap target.
//
// #122. Spec §7 asks for a 44px minimum tap height on a phone. Stage 5 of the phone pass met it by
// raising the shared control classes, which reach only the controls that use them. #122 named eight
// text links and text buttons with classes of their own, 16-20px tall on a phone, two of them added
// by the pass itself, for phones; the sweep that followed found 19. The phone header's sign-out, at
// 36px, was #121. So every raw <a>, <button> and next/link <Link> in app/ and components/ carries the
// 44px rule in classes it has in every state, written outside any condition and under no variant:
// - one of the shared classes (SHARED_CLASSES, below): tapTargetClass, inputClass or selectClass,
//   imported from components/ui/styles, or buttonClass(…), imported from components/ui/Button; or
// - min-h-[44px] itself, beside md:min-h-0 so that the desktop layout is untouched, on a <button>,
//   which is inline-block, or with a display that min-height applies to (inline-flex, block, flex…).
//   An <a> is inline, and min-height does nothing on an inline box.
// Beside the floor, no other min-h class and no display that min-height does nothing on may apply
// below md, in any branch: Tailwind orders its CSS by its own rules, not by the attribute, so either
// could win. Nor may a spread come after the classes, where it could replace them.
//
// It parses the TSX with the TypeScript compiler, because an attribute can hold `=>` and a pattern
// that reads a tag to its first `>` stops inside the onClick. A file that does not parse fails: the
// parser recovers and goes on, so the controls it finds in such a file cannot be trusted.
//
// A component that hands its className straight to a raw control is named in PASS_THROUGH, and is
// checked where it is rendered, by the classes written there: a tag with its name, or ending in it
// (`S.SignOutButton`), from any module, and any name its module is imported under. A reference the
// check cannot follow to a tag fails: a re-export, import(), require(), or the component as a value.
// So does an entry whose file has no control taking exactly `{className}`, or whose file is gone.
//
// A control under an element hidden below md passes: `hidden`, with only an md: or wider variant to
// show it again. Only a DOM element's own class string counts, and only one with no expression in
// it, which nothing can add a class to; and only for the element's children, as JSX handed to it in
// another attribute may be rendered anywhere. §7 is a phone rule.
//
// Anything that cannot carry the rule is named in TAP_TARGETS_ALLOWED, by its file and its classes,
// with why it is fine. The classes are the name, so changing them asks the question again. An entry
// that names no control in its file fails, and so, when the whole tree is read (main(), below), does
// one whose file is gone: the list cannot outlive its controls. So does an entry whose classes are
// one bare prop (`{className}`): that is a component passing its classes on, which belongs in
// PASS_THROUGH, and the entry would let it through wherever it is rendered. In a name, a template's
// expressions are written `${…}`, and classes that are one expression are written as it, in braces.
// ---------------------------------------------------------------------------
/** @type {{ file: string, classes: string, reason: string }[]} */
export const TAP_TARGETS_ALLOWED = []

// Components whose className goes straight to one raw control: the file that defines each, and the
// name it is exported under. In that file, the control whose classes are exactly `{className}` passes.
export const PASS_THROUGH = [{ file: 'components/SignOutButton.tsx', name: 'SignOutButton' }]

// The shared classes that carry the rule, by the module that exports each, with what each gives its
// element as far as this check reads it: the floor, its release at md, and for two of them a display.
// inputClass and selectClass, made for an <input> and a <select>, have none, so on an <a> their floor
// does nothing. buttonClass is a call, whose third argument is classes of its own.
// tests/unit/check-invariants.test.ts holds `gives` to the real strings.
export const SHARED_CLASSES = [
  { module: 'components/ui/styles', name: 'tapTargetClass', gives: 'inline-flex min-h-[44px] md:min-h-0' },
  { module: 'components/ui/styles', name: 'inputClass', gives: 'min-h-[44px] md:min-h-0' },
  { module: 'components/ui/styles', name: 'selectClass', gives: 'min-h-[44px] md:min-h-0' },
  { module: 'components/ui/Button', name: 'buttonClass', call: true, gives: 'inline-flex min-h-[44px] md:min-h-0' },
]

const PARSE_OPTIONS = { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest }
const FLOOR = 'min-h-[44px]'

// Tailwind's display utilities, by the display each sets; and the displays min-height applies to.
const DISPLAYS = new Map([
  ['hidden', 'none'],
  ...'block inline-block inline flex inline-flex grid inline-grid contents flow-root list-item table inline-table table-caption table-cell table-column table-column-group table-footer-group table-header-group table-row-group table-row'
    .split(' ')
    .map((d) => [d, d]),
])
const SIZED = new Set('block inline-block flex inline-flex grid inline-grid flow-root list-item table inline-table'.split(' '))

const words = (s) => s.split(/\s+/).filter(Boolean)
const SLOT = '\u0000'

// A class split into its variants and its utility, at the colons outside brackets: `md:min-h-0` is
// md and min-h-0, and `[display:none]` is one utility. Tailwind's important mark, a `!` before the
// utility (v3) or after it (v4), is not part of the utility's name.
function parseClass(token) {
  const variants = []
  let depth = 0
  let from = 0
  for (let k = 0; k < token.length; k++) {
    if ('[('.includes(token[k])) depth++
    else if ('])'.includes(token[k])) depth--
    else if (token[k] === ':' && depth === 0) {
      variants.push(token.slice(from, k))
      from = k + 1
    }
  }
  return { variants, utility: token.slice(from).replace(/^!|!$/g, '') }
}

// The display a utility sets, if it sets one: `hidden` sets none, and `[display:…]` what it says.
const displayOf = (utility) => /^\[display:(.+)\]$/.exec(utility)?.[1].replaceAll('_', ' ') ?? DISPLAYS.get(utility)

// Whether a class can apply below md: none of its variants is md or wider. A class applies only
// where all its variants hold, so one of those keeps it to md and up.
const belowMd = ({ variants }) => !variants.some((v) => /^(md|lg|xl|2xl)$/.test(v))

// A module's repo path, as an import names it: without its extension, and a folder's index.tsx by the
// folder. So '@/components/X', '../X' from a file in components/ui/, and components/X.tsx all name
// 'components/X'.
const modulePath = (path) => path.replace(/\.(tsx?|jsx?|mjs)$/, '').replace(/\/index$/, '')

// The module an import names from the file at `from`, or null for a package.
function moduleOf(specifier, from) {
  if (!specifier.startsWith('@/') && !specifier.startsWith('.')) return null
  return modulePath(specifier.startsWith('@/') ? posix.normalize(specifier.slice(2)) : posix.join(posix.dirname(from), specifier))
}

// The classes an expression gives in every state: a string's text, a template's text, and what a
// shared class gives as the whole expression or in a template's slot. Never a branch of a condition.
// A token a template's expression runs into keeps the SLOT, so it matches no class. `shared` maps the
// names this file reaches the shared classes by.
function fixedOf(e, shared) {
  if (ts.isParenthesizedExpression(e)) return fixedOf(e.expression, shared)
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return words(e.text)
  if (ts.isTemplateExpression(e)) {
    const text = [e.head.text, ...e.templateSpans.map((s) => SLOT + s.literal.text)].join('')
    return [...words(text), ...e.templateSpans.flatMap((s) => givenBy(s.expression, shared))]
  }
  return givenBy(e, shared)
}

function givenBy(e, shared) {
  if (ts.isParenthesizedExpression(e)) return givenBy(e.expression, shared)
  const call = ts.isCallExpression(e)
  const name = ts.isIdentifier(e) ? e.text : call && ts.isIdentifier(e.expression) ? e.expression.text : null
  const s = shared.get(name)
  return s && Boolean(s.call) === call ? words(s.gives) : []
}

// An element's className, read four ways: `name`, to match the allowlist by; `fixed`, the classes it
// has in every state (fixedOf); `any`, every class it may have in some state: those, and each string
// and template text anywhere in it, buttonClass(…)'s own classes among them; and `plain`, whether it
// is one string with no expression in it.
function classesOf(opening, sf, shared) {
  const attr = opening.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'className')
  const e = attr?.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr?.initializer
  if (!e) return { attr, name: '', fixed: [], any: [], plain: false }
  const fixed = fixedOf(e, shared)
  const any = [...fixed]
  const texts = [ts.isStringLiteral, ts.isNoSubstitutionTemplateLiteral, ts.isTemplateHead, ts.isTemplateMiddle, ts.isTemplateTail]
  const collect = (n) => {
    if (texts.some((is) => is(n))) any.push(...words(n.text))
    ts.forEachChild(n, collect)
  }
  collect(e)
  const plain = ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
  const name = plain
    ? fixed.join(' ')
    : ts.isTemplateExpression(e)
      ? words([e.head.text, ...e.templateSpans.map((s) => '${…}' + s.literal.text)].join('')).join(' ')
      : `{${words(e.getText(sf)).join(' ')}}`
  return { attr, name, fixed, any, plain }
}

// Whether classes hide their element below md in every state: `hidden` (or [display:none]) under no
// variant, and no other display that can apply below md. `hidden sm:block` shows it from 640px, a
// state variant such as `group-open:block` shows it on a tap, and `hidden flex` may show it at all.
function hiddenBelowMd(tokens) {
  const displays = tokens
    .map(parseClass)
    .filter(belowMd)
    .map((c) => ({ ...c, display: displayOf(c.utility) }))
    .filter((c) => c.display)
  return displays.some((c) => c.variants.length === 0 && c.display === 'none') && displays.every((c) => c.display === 'none')
}

// Why a control's classes do not make it a 44px tap target below md, or null if they do.
function problemOf(tag, { fixed, any }) {
  const now = fixed.map(parseClass).filter((c) => c.variants.length === 0)
  if (!now.some((c) => c.utility === FLOOR)) return { rule: 'none' }
  if (!fixed.map(parseClass).some((c) => c.variants.join(':') === 'md' && c.utility === 'min-h-0')) return { rule: 'release' }
  if (tag !== 'button' && !now.some((c) => SIZED.has(displayOf(c.utility)))) return { rule: 'display' }
  for (const token of any) {
    const c = parseClass(token)
    if (!belowMd(c)) continue
    if (c.utility.startsWith('min-h-') && c.utility !== FLOOR) return { rule: 'cancelled', token }
    const display = displayOf(c.utility)
    if (!display || display === 'none') continue
    // A <button> lays out an inline display as inline-block; only `contents` leaves it no box.
    if (tag === 'button' ? display === 'contents' : !SIZED.has(display)) return { rule: 'outshone', token }
  }
  return null
}

const SHARED = 'tapTargetClass (a text link or text button) or buttonClass(…)'

function messageOf(tag, { rule, token }) {
  if (rule === 'none') {
    return (
      `<${tag}> has no 44px rule in its classes. On a phone §7 asks for a 44px tap target, and controls ` +
      `with classes of their own were left 16-20px tall (#122). Give it ${SHARED}, or if neither fits ` +
      '`inline-flex min-h-[44px] md:min-h-0`. A component that hands its className to a control belongs ' +
      'in PASS_THROUGH, which checks it where it is rendered. TAP_TARGETS_ALLOWED is only for a control ' +
      'that cannot carry the rule, with why.'
    )
  }
  if (rule === 'release') {
    return (
      `<${tag}> has min-h-[44px] without md:min-h-0, so the floor reaches the desktop layout too (#122). ` +
      `Add md:min-h-0, or use ${SHARED}.`
    )
  }
  if (rule === 'display') {
    return (
      `<${tag}> has a 44px floor and no display that min-height applies to. An <a> is inline, and ` +
      'min-height does nothing on an inline box; only a <button> is inline-block by itself (#122). Add ' +
      `inline-flex, or block or flex, beside the floor, or use ${SHARED}.`
    )
  }
  const what = rule === 'cancelled' ? 'another min-height' : 'a display that min-height does nothing on'
  return (
    `<${tag}> has \`${token}\` beside its 44px floor: ${what}, which may apply below md, and could win ` +
    "there, since Tailwind's CSS does not follow the order of the classes (#122). Remove it, or put it " +
    'under md:.'
  )
}

// Whether a node is part of a type, as `typeof SignOutButton` in ComponentProps<…> is. A type renders
// nothing.
function inType(node) {
  for (let n = node.parent; n; n = n.parent) if (ts.isTypeNode(n)) return true
  return false
}

// Whether a node is the tag of the JSX element it is in.
const isTag = (node) =>
  (ts.isJsxOpeningElement(node.parent) || ts.isJsxSelfClosingElement(node.parent) || ts.isJsxClosingElement(node.parent)) &&
  node.parent.tagName === node

// `wholeTree`: `files` is every file under app/ and components/, as main() reads them, so an entry in
// the allowlist or PASS_THROUGH whose file is not among them names a file deleted or renamed. A caller
// passing some of the files leaves it false, and such an entry is not reported. A diagnostic the
// compiler ties to no file is a problem with `compilerOptions`, not with a file, and is reported once.
/**
 * @param {{ path: string, text: string }[]} files
 * @param {typeof TAP_TARGETS_ALLOWED} [allowed]
 * @param {{ wholeTree?: boolean, passThrough?: typeof PASS_THROUGH, compilerOptions?: import('typescript').CompilerOptions }} [options]
 */
export function checkTapTargets(
  files,
  allowed = TAP_TARGETS_ALLOWED,
  { wholeTree = false, passThrough = PASS_THROUGH, compilerOptions = PARSE_OPTIONS } = {}
) {
  const out = []
  const read = new Set()
  const unparsed = new Set()
  const named = new Set()
  const passing = new Set()
  const passNames = new Set(passThrough.map((p) => p.name))
  const passModules = new Map(passThrough.map((p) => [modulePath(p.file), p]))
  const bare = (entry) => /^\{[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\}$/.test(entry.classes)
  for (const { path, text } of files) {
    if (!/^(app|components)\/.+\.tsx$/.test(path)) continue
    read.add(path)
    const { diagnostics = [] } = ts.transpileModule(text, {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: { ...compilerOptions },
    })
    const setup = diagnostics.find((d) => !d.file)
    if (setup) {
      return [
        {
          check: 'tap-target',
          file: 'scripts/check-invariants.mjs',
          line: 1,
          message:
            `the TypeScript compiler rejected this check's compiler options ` +
            `(${ts.flattenDiagnosticMessageText(setup.messageText, ' ')}), so no file could be read for tap ` +
            'targets (#122). Fix the options checkTapTargets passes it.',
        },
      ]
    }
    const syntax = diagnostics.find((d) => d.file)
    if (syntax) {
      unparsed.add(path)
      out.push({
        check: 'tap-target',
        file: path,
        line: lineOf(text, syntax.start ?? 0),
        message:
          `does not parse as TSX (${ts.flattenDiagnosticMessageText(syntax.messageText, ' ')}), so its ` +
          'controls cannot be checked for a 44px tap target (#122).',
      })
      continue
    }
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const fail = (node, message) => out.push({ check: 'tap-target', file: path, line: lineOf(text, node.getStart(sf)), message })
    const here = modulePath(path)
    const own = passModules.get(here)

    // The names this file reaches next/link's Link by, a PASS_THROUGH component, and the shared
    // classes: what it imports them as, and in the module that defines a shared class, its own name.
    const links = new Set()
    const passLocals = new Set()
    const shared = new Map(SHARED_CLASSES.filter((c) => c.module === here).map((c) => [c.name, c]))
    for (const s of sf.statements) {
      if (!ts.isImportDeclaration(s) || !s.importClause) continue
      const specifier = s.moduleSpecifier.text
      const source = moduleOf(specifier, path)
      const pass = passModules.get(source)
      const { name: local, namedBindings } = s.importClause
      const specifiers = namedBindings && ts.isNamedImports(namedBindings) ? namedBindings.elements : []
      const imported = (el) => (el.propertyName ?? el.name).text
      if (specifier === 'next/link') {
        if (local) links.add(local.text)
        for (const el of specifiers) if (imported(el) === 'default') links.add(el.name.text)
      }
      if (pass) {
        if (local) passLocals.add(local.text)
        for (const el of specifiers) if ([pass.name, 'default'].includes(imported(el))) passLocals.add(el.name.text)
      }
      for (const el of specifiers) {
        const c = SHARED_CLASSES.find((sc) => sc.module === source && sc.name === imported(el))
        if (c) shared.set(el.name.text, c)
      }
    }
    // A shared class's name declared again in the file, as a parameter or a local, may not be the
    // shared class where it is used, so here it counts for nothing.
    const declared = new Map()
    const declare = (node) => {
      const declaration = [ts.isVariableDeclaration, ts.isParameter, ts.isBindingElement, ts.isFunctionDeclaration, ts.isClassDeclaration].some((is) => is(node))
      if (declaration && node.name && ts.isIdentifier(node.name)) declared.set(node.name.text, (declared.get(node.name.text) ?? 0) + 1)
      ts.forEachChild(node, declare)
    }
    declare(sf)
    for (const [local, c] of shared) if ((declared.get(local) ?? 0) > (c.module === here ? 1 : 0)) shared.delete(local)

    // <a> and <button>; Link; a PASS_THROUGH component by any name it is imported under, and any tag
    // with its name or ending in it, from any module.
    const isControl = (tag) =>
      ts.isIdentifier(tag)
        ? ['a', 'button'].includes(tag.text) || links.has(tag.text) || passLocals.has(tag.text) || passNames.has(tag.text)
        : ts.isPropertyAccessExpression(tag) && passNames.has(tag.name.text)
    const unfollowable = (node, what) =>
      fail(
        node,
        `${what}: a component PASS_THROUGH names, which this check cannot follow from here to where it is ` +
          'rendered, to check the classes written there (#122). Import it by name, and render it as a tag.'
      )
    const checkControl = (opening, classes) => {
      const tag = opening.tagName.getText(sf)
      const attributes = opening.attributes.properties
      const spread = classes.attr && attributes.slice(attributes.indexOf(classes.attr) + 1).find(ts.isJsxSpreadAttribute)
      if (spread) {
        fail(
          opening,
          `<${tag}> spreads {...${spread.expression.getText(sf)}} after its className, and what it spreads ` +
            'can replace the classes this check read (#122). Put the spread before className.'
        )
        return
      }
      if (own && classes.name === '{className}') {
        passing.add(own)
        return
      }
      const problem = problemOf(tag, classes)
      if (!problem) return
      const entry = allowed.find((a) => !bare(a) && a.file === path && a.classes === classes.name)
      if (entry) named.add(entry)
      else fail(opening, messageOf(tag, problem))
    }
    const visit = (node, hidden) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node
        const classes = classesOf(opening, sf, shared)
        const dom = ts.isIdentifier(opening.tagName) && /^[a-z]/.test(opening.tagName.text)
        const hides = hidden || (dom && classes.plain && hiddenBelowMd(classes.fixed))
        if (!hides && isControl(opening.tagName)) checkControl(opening, classes)
        // Its tag and attributes as where it sits; its children as inside it.
        ts.forEachChild(opening, (child) => visit(child, hidden))
        if (ts.isJsxElement(node)) {
          for (const child of node.children) visit(child, hides)
          visit(node.closingElement, hidden)
        }
        return
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const pass = passModules.get(moduleOf(node.moduleSpecifier.text, path))
        if (pass) unfollowable(node, `re-exports from ${pass.file}, where ${pass.name} is`)
      }
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const how =
          node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? 'import()'
            : ts.isIdentifier(node.expression) && node.expression.text === 'require'
              ? 'require()'
              : null
        const pass = how && passModules.get(moduleOf(node.arguments[0].text, path))
        if (pass) unfollowable(node, `loads ${pass.file} with ${how}, and ${pass.name} with it`)
      }
      if (ts.isIdentifier(node) && passLocals.has(node.text)) {
        const member = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
        const binding = ts.isImportClause(node.parent) || ts.isImportSpecifier(node.parent)
        if (!isTag(node) && !member && !binding && !inType(node)) unfollowable(node, `uses ${node.text} other than as a tag`)
      }
      if (ts.isPropertyAccessExpression(node) && passNames.has(node.name.text) && !isTag(node) && !inType(node)) {
        unfollowable(node, `uses ${node.getText(sf)} other than as a tag`)
      }
      ts.forEachChild(node, (child) => visit(child, hidden))
    }
    visit(sf, false)
  }
  for (const entry of allowed) {
    if (bare(entry)) {
      out.push({
        check: 'tap-target',
        file: entry.file,
        line: 1,
        message:
          `TAP_TARGETS_ALLOWED names a control here by "${entry.classes}", one bare prop: a component handing ` +
          'its className on, which the entry would let through wherever it is rendered. Name the component ' +
          'in PASS_THROUGH instead, which checks the classes written where it is rendered (#122).',
      })
      continue
    }
    if (named.has(entry) || unparsed.has(entry.file)) continue
    if (!read.has(entry.file)) {
      if (!wholeTree) continue
      out.push({
        check: 'tap-target',
        file: entry.file,
        line: 1,
        message:
          'TAP_TARGETS_ALLOWED names this file, and there is no such file under app/ or components/. ' +
          'Remove the entry, or, if the file moved, check its control is still 44px tall on a phone and ' +
          'name it by its new path (#122).',
      })
      continue
    }
    out.push({
      check: 'tap-target',
      file: entry.file,
      line: 1,
      message:
        `TAP_TARGETS_ALLOWED names a control here with the classes "${entry.classes}", and no control ` +
        'in this file that fails the 44px rule has them. Remove the entry, or, if the classes changed, ' +
        'check the control is still 44px tall on a phone and name it by its new ones (#122).',
    })
  }
  for (const entry of passThrough) {
    if (passing.has(entry) || unparsed.has(entry.file)) continue
    if (!read.has(entry.file)) {
      if (!wholeTree) continue
      out.push({
        check: 'tap-target',
        file: entry.file,
        line: 1,
        message:
          'PASS_THROUGH names this file, and there is no such file under app/ or components/. Remove the ' +
          'entry, or name the file it moved to (#122).',
      })
      continue
    }
    out.push({
      check: 'tap-target',
      file: entry.file,
      line: 1,
      message:
        `PASS_THROUGH names ${entry.name} here, and no control in this file takes its classes as exactly ` +
        '{className}, which is what lets the check read them where it is rendered instead. Give the ' +
        'control className={className}, or remove the entry (#122).',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 6. No class switches at sm.
//
// #123. Below md the app has one layout, the phone's, and md is where it switches to the desktop's.
// Classes that switched at sm (640px) gave 640-767px a piece of the desktop layout inside the phone's:
// two goals or accounts across, a narrowed search field, Trends' heading rows. So no string or
// template in app/ or components/ holds a class with the sm: variant, or max-sm:, which splits the
// phone's range the same way. Comments are not read, and nor are names: buttonClass's `sm` size is a
// property, and its value has no sm: class.
// ---------------------------------------------------------------------------
export function checkSmBreakpoint(files) {
  const out = []
  const texts = [ts.isStringLiteral, ts.isNoSubstitutionTemplateLiteral, ts.isTemplateHead, ts.isTemplateMiddle, ts.isTemplateTail]
  for (const { path, text } of files) {
    if (!/^(app|components)\/.+\.tsx?$/.test(path)) continue
    const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
    const visit = (node) => {
      if (texts.some((is) => is(node))) {
        for (const token of words(node.text)) {
          if (!parseClass(token).variants.some((v) => v === 'sm' || v === 'max-sm')) continue
          out.push({
            check: 'sm-breakpoint',
            file: path,
            line: lineOf(text, node.getStart(sf)),
            message:
              `has \`${token}\`, a class that switches at sm (640px), inside the phone layout's range. ` +
              'Below md the app has one layout, so 640-767px would get a piece of the desktop one (#123). ' +
              'Switch at md, where the app changes between its phone and desktop layouts.',
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return out
}

// ---------------------------------------------------------------------------

function walk(dir, out = [], ext = /\.tsx?$/) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out, ext)
    else if (ext.test(full)) out.push(full)
  }
  return out
}

function main() {
  const ROOT = process.cwd()
  const read = (f) => ({ path: relative(ROOT, f), text: readFileSync(f, 'utf8') })
  const files = ['app', 'lib', 'components'].flatMap((d) => walk(join(ROOT, d))).map(read)
  // No scripts/ directory in the scratch trees of tests/unit/check-invariants-txn-reads.test.ts.
  // Any other failure to read it throws: passing with scripts/ unscanned would be a false "ok".
  const scripts = existsSync(join(ROOT, 'scripts'))
    ? walk(join(ROOT, 'scripts'), [], /\.mjs$/)
        .map(read)
        .filter((f) => f.path !== 'scripts/check-invariants.mjs')
    : []
  const failures = [
    ...checkUncheckedReads(files),
    ...checkRuntimeClock(files),
    ...checkTxnReads(files),
    ...checkCategoryReads(files),
    ...checkRulesReads(files),
    ...checkUserCategoryWrites([...files, ...scripts]),
    ...checkSuggestionWrites([...files, ...scripts]),
    ...checkBrandCasts(files),
    // Every file under app/ and components/ is in `files`, so an entry for one that is not is stale.
    ...checkTapTargets(files, TAP_TARGETS_ALLOWED, { wholeTree: true }),
    ...checkSmBreakpoint(files),
  ]
  if (failures.length) {
    console.error(`\ncheck:invariants — ${failures.length} problem(s):\n`)
    console.error(failures.map((f) => `  ${f.file}:${f.line}\n      [${f.check}] ${f.message}`).join('\n\n'))
    console.error(
      '\nEach of these is a shape that has shipped a real bug here. Fix it, or, where its check has an ' +
        'allowlist in scripts/check-invariants.mjs, add it there with a reason and an issue number.\n'
    )
    process.exit(1)
  }
  console.log('invariants ok')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
