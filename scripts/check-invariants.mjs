#!/usr/bin/env node
// Tripwires for the three defect classes this repo has actually shipped.
//
// These are greps, not proofs. They cannot understand the code — they can only notice a shape that
// has been wrong before. That is deliberate: each one exists because a real bug reached production
// and a person had to find it by reading. A tripwire that catches the next instance of a defect we
// have already paid for is worth more than a clever analysis of one we have not.
//
// Every known violation is ALLOWED BY NAME below, with a reason and an issue number. The allowlist
// is the outstanding debt, written down. Adding to it should feel like a decision; removing from it
// is how the debt gets paid.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const failures = []

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

const files = ['app', 'lib', 'components']
  .flatMap((d) => walk(join(ROOT, d)))
  .map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, 'utf8') }))

const report = (check, file, line, message) =>
  failures.push(`  ${file}:${line}\n      [${check}] ${message}`)

// ---------------------------------------------------------------------------
// 1. Every read on a page checks `error`.
//
// #46, and again in #68, and again in #77. A Supabase read that fails sets `data` to null, and
// `?? []` turns that into an empty array — so "the query failed" and "you have no data" render
// identically. On the dashboard that was not even an empty state: with the categories read failing,
// income stopped being excluded from spending and the tiles read -$1,796.70 and +$1,796.70 against
// a truth of $3,929.35 and $1,796.70. A number the reader would act on.
// ---------------------------------------------------------------------------
const READS_ALLOWED = new Map([
  [
    'app/(app)/layout.tsx',
    'Sits ABOVE app/(app)/error.tsx, so throwing takes down the whole shell rather than one ' +
      'section. Needs only a display name, and has a fallback for it.',
  ],
])

for (const { path, text } of files) {
  if (!path.startsWith('app/(app)/')) continue
  if (READS_ALLOWED.has(path)) continue
  text.split('\n').forEach((line, i) => {
    if (!/const\s*{\s*data\b/.test(line)) return
    if (/\berror\b/.test(line)) return
    report(
      'unchecked-read',
      path,
      i + 1,
      'destructures `data` without `error`. A failed read must not render identically to no data ' +
        '(#46) — check `error` and throw, so app/(app)/error.tsx can show a retryable message.'
    )
  })
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

for (const { path, text } of files) {
  if (CLOCK_ALLOWED.has(path)) continue
  text.split('\n').forEach((line, i) => {
    const match = line.match(/\.get(Hours|Month|FullYear|Date|Day)\(\)/)
    if (!match || /getUTC/.test(line)) return
    report(
      'runtime-clock',
      path,
      i + 1,
      `reads .get${match[1]}() off the runtime clock, which is UTC on Vercel and not the ` +
        "household's zone (#73). Resolve the day through lib/clock.ts, or construct with Date.UTC " +
        'and read it back with getUTC*.'
    )
  })
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

// The calls chained onto `.from(...)`, in order: [{ name, args }], with `args` taken from the
// comment-free source so string arguments survive.
function chainAfter(code, text, from) {
  const calls = []
  let k = closeOf(code, code.indexOf('(', from)) + 1
  for (;;) {
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(k))
    if (!m) return calls
    const open = k + m[0].length - 1
    const close = closeOf(code, open)
    calls.push({ name: m[1], args: text.slice(open + 1, close) })
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
    report(
      'unbounded-txn-read',
      path,
      text.slice(0, at).split('\n').length,
      'reads transactions with no bound at or under 1,000 rows. PostgREST truncates at 1,000 with ' +
        'a 200 OK and no error, and .order() alone does not stop that (#69). Wrap the query in ' +
        'readAllRows (lib/read-all.ts), or bound it.'
    )
  }
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\ncheck:invariants — ${failures.length} problem(s):\n`)
  console.error(failures.join('\n\n'))
  console.error(
    '\nEach of these is a shape that has shipped a real bug here. Fix it, or add the file to the ' +
      'matching allowlist in scripts/check-invariants.mjs with a reason and an issue number.\n'
  )
  process.exit(1)
}
console.log('invariants ok')
