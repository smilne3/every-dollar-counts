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
// #69. PostgREST truncates at 1,000 rows with a 200 OK and no error, so a read that matches more
// renders the first 1,000 as though they were all of it. By 2026-10-05 Settings was counting 1,000
// of 1,366 transactions, and the dashboard's six-month window held 908.
//
// An earlier version of this check accepted .order() as enough. Ordering only makes the truncated
// set the same on every request; it is still truncated. So a read passes only if it is capped
// (.limit, .range, a single row, a count) or goes through lib/read-all.ts's readAllRows, which
// pages past the cap.
// ---------------------------------------------------------------------------
const TXN_READS_ALLOWED = new Map([
  [
    'app/(app)/reimbursements/page.tsx',
    'Marked rows only, ordered, and documented as deliberately unbounded: a household marks a ' +
      'handful a month. Revisit if that changes.',
  ],
  ['lib/receivable.ts', 'Marked rows only, as reimbursements/page.tsx.'],
  ['lib/ingest.ts', 'Writes and cursor-driven pulls, not a page read.'],
])

for (const { path, text } of files) {
  if (TXN_READS_ALLOWED.has(path)) continue
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (!/\.from\(['"]transactions['"]\)/.test(line)) return
    // readAllRows(() => supabase.from('transactions')...) pages the read itself. The call opens on
    // this line or within the two before it.
    const opener = lines.slice(Math.max(0, i - 2), i + 1).join('\n')
    if (/readAllRows\(/.test(opener)) return
    // Walk forward while the statement is still chaining, and see whether it selects rows at all
    // and whether it ever bounds itself. A write (.update(), .delete()) reads nothing and cannot
    // truncate, so only a chain containing .select() is in scope.
    // `depth` counts open parentheses, so a line inside a multi-line argument (a long select list)
    // does not read as the end of the chain.
    let bounded = false
    let reads = false
    let depth = 0
    for (let j = i; j < Math.min(i + 14, lines.length); j++) {
      const l = lines[j].trim()
      if (j > i && depth <= 0 && l && !l.startsWith('.') && !l.startsWith(')') && !l.startsWith('//')) break
      if (/\.select\(/.test(l)) reads = true
      if (/\.(update|upsert|insert|delete)\(/.test(l)) reads = false
      if (/\.(limit|range|single|maybeSingle)\(/.test(l) || /head:\s*true/.test(l)) bounded = true
      depth += (l.match(/\(/g) ?? []).length - (l.match(/\)/g) ?? []).length
    }
    if (reads && !bounded) {
      report(
        'unbounded-txn-read',
        path,
        i + 1,
        'reads transactions with no .limit(), .range() or single-row bound. PostgREST truncates ' +
          'at 1,000 rows with a 200 OK and no error, and .order() alone does not stop that (#69). ' +
          'Wrap the query in readAllRows (lib/read-all.ts), or bound it.'
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
