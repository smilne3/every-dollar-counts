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
const CLOCK_ALLOWED = new Map([
  ['app/(app)/dashboard/page.tsx', 'Fixed by #73 — see its plan, Task 7.'],
  ['app/(app)/budgets/page.tsx', 'Fixed by #73 — see its plan, Task 8.'],
  ['lib/dashboard.ts', 'Fixed by #73 — lastNMonths moves to a day string, Task 6.'],
  ['lib/budget.ts', 'Fixed by #73 — lastCompleteMonths moves to a day string, Task 5.'],
])

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
// 3. Every unbounded `transactions` read is ordered.
//
// #69. PostgREST truncates at 1,000 rows with a 200 OK and no error. Without an ORDER BY, Postgres
// may return a DIFFERENT 1,000 rows on successive requests — so past the cap the numbers would move
// between refreshes with no input having changed and nothing to say why.
// ---------------------------------------------------------------------------
const TXN_READS_ALLOWED = new Map([
  ['app/(app)/settings/page.tsx', '#69 — unbounded and growing; wants a grouped count, not an order.'],
  ['app/(app)/breakdown/[metric]/page.tsx', '#69'],
  ['app/(app)/transactions/page.tsx', 'Ranged and ordered already; the .range() call carries it.'],
  ['app/(app)/dashboard/page.tsx', '#69'],
  ['app/(app)/trends/page.tsx', '#69'],
  ['app/(app)/budgets/page.tsx', '#69'],
  ['lib/ingest.ts', 'Writes and cursor-driven pulls, not a page read.'],
  ['app/api/reimbursable/route.ts', 'Single row by id.'],
  ['app/api/transactions/categorize/route.ts', 'Single row by id.'],
])

for (const { path, text } of files) {
  if (TXN_READS_ALLOWED.has(path)) continue
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (!/\.from\(['"]transactions['"]\)/.test(line)) return
    // Walk forward while the statement is still chaining, and see whether it selects rows at all
    // and whether it ever bounds itself. A write — .update(), .delete() — reads nothing and cannot
    // truncate, so only a chain containing .select() is in scope.
    let bounded = false
    let reads = false
    for (let j = i; j < Math.min(i + 14, lines.length); j++) {
      const l = lines[j].trim()
      if (/\.select\(/.test(l)) reads = true
      if (/\.(update|upsert|insert|delete)\(/.test(l)) reads = false
      if (/\.(order|limit|range)\(/.test(l)) bounded = true
      if (j > i && l && !l.startsWith('.') && !l.startsWith('//')) break
    }
    if (reads && !bounded) {
      report(
        'unordered-txn-read',
        path,
        i + 1,
        'reads transactions with no .order(), .limit() or .range(). PostgREST truncates at 1,000 ' +
          'rows with a 200 OK, and without an order the truncated set can differ between ' +
          'requests (#69).'
      )
    }
  })
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
