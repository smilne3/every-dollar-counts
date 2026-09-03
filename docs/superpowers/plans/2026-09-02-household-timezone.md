# Household Timezone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every calendar decision in the app derives from a timezone stored on the household, not from the server's clock.

**Architecture:** One column, `households.timezone`, is the authority. `lib/clock.ts` is the only module that turns a real instant into a calendar value; below it every date function takes a `'YYYY-MM-DD'` (or `'YYYY-MM'`) string and never constructs a `Date` from an instant. That is why `lastCompleteMonths` and `lastNMonths` change signature rather than being handed a better `Date`: their bodies read `now.getMonth()`, which projects through the runtime's zone, and an instant carries no zone.

**Tech Stack:** Next.js 16 App Router (Server Components), Supabase/Postgres with RLS, TypeScript, Vitest + Testing Library, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-09-02-household-timezone-design.md`

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing Next.js code.** Per `AGENTS.md`, this version has breaking changes from training data.
- **Plaid sign convention:** `amount > 0` is money OUT, `amount < 0` is money IN.
- **Never reintroduce #31, #8 or #27:** credit-card payments stay excluded from spending and income; refunds net against their category; reimbursable amounts net off.
- **Never reintroduce #46:** a failed read must not render identically to "you have no data". Check `error` on every query and throw.
- **TDD is mandatory:** write the failing test, watch it fail, then implement. A test that passes the moment you write it has proven nothing.
- **Below `lib/clock.ts`, no function may call `new Date()` to ask what day it is.** Constructing a `Date` from explicit `Date.UTC(...)` parts and reading it back with `getUTC*` is fine and is the house pattern for month arithmetic.
- **The default timezone string is exactly `America/New_York`**, in the migration and in `lib/household.ts`.
- Verification commands: `npx vitest run`, `VITEST_TZ=America/New_York npx vitest run`, `npx tsc --noEmit`, `npx eslint`, `npm run build`.
- The suite has **277 passing tests** at this branch's base. No existing assertion may be weakened to make new code pass.
- **Both timezone runs must pass.** CI runs the suite at `Asia/Tokyo` (default) and again at `America/New_York`. A fix that stores `America/New_York` needs its hardest scrutiny under the **Tokyo** run, because that is where a residual `now.getMonth()` still reads the runtime zone and disagrees with what is stored.

---

### Task 1: The migration — timezone column and an update policy

**Files:**
- Create: `db/migrations/019_household_timezone.sql`
- Modify: `README.md` (the migration run order list)

**Interfaces:**
- Produces: `households.timezone text not null default 'America/New_York'`, and RLS policy `"update your household"` on `households`.

There is no migration runner in this repo and no test harness for SQL, so this task has no red/green cycle. Its deliverable is reviewed by reading. **A human must apply it to Supabase before Task 3's code will work against a real database**; the tests mock Supabase and do not need it.

- [ ] **Step 1: Write the migration**

```sql
-- The household's own clock (#73).
--
-- Every date in the app came from `new Date()` on the server, which is UTC on Vercel while this
-- household is in US Eastern. The dashboard said "Good morning / Thursday, September 3" at 8:10pm
-- on Wednesday 2 September, and — the half that actually matters — for four hours at the end of
-- every month the money tiles reported the wrong month: "Spent in September" showing a fresh ~$0
-- month while August was still running.
--
-- Defaulted rather than backfilled: the default is correct for the only household that exists, and
-- every existing row keeps working with no data migration.
--
-- No check constraint on the value. Postgres cannot validate an IANA name without consulting
-- pg_timezone_names, which a column check cannot reliably do; validation lives at the write
-- boundary in app/api/household/timezone/route.ts, where Intl can answer authoritatively.
alter table households
  add column if not exists timezone text not null default 'America/New_York';

-- households had exactly ONE policy before this — "read your households", for select (006). With
-- no update policy, an UPDATE through the RLS-scoped client matches zero rows and returns NO
-- ERROR: Supabase reports success. Saving a timezone that way would appear to work, refresh, and
-- show the old value forever, with nothing in the logs. That is #46's silent-read failure wearing
-- a write's clothes.
--
-- This also makes households.name writable, which is harmless: there is no name editor today, and
-- if one is ever added this is the policy it would need.
drop policy if exists "update your household" on households;
create policy "update your household" on households
  for update to authenticated
  using ( id in (select private.household_ids()) )
  with check ( id in (select private.household_ids()) );
```

- [ ] **Step 2: Add it to the README's run order**

Find the migration list in `README.md` (it currently ends at `017`, and `018` was never added). Replace the end of that list so it reads through `019`. Run this to see the exact line:

```bash
grep -n "017" README.md
```

Then edit that line to include `018_plaid_slot_ledger.sql` and `019_household_timezone.sql` in order.

- [ ] **Step 3: Verify nothing else broke**

```bash
npx vitest run && npx tsc --noEmit && npx eslint
```
Expected: 277 passing, no type errors, no lint errors. (No code changed yet; this is a baseline check.)

- [ ] **Step 4: Commit**

```bash
git add db/migrations/019_household_timezone.sql README.md
git commit -m "feat: store the household's timezone (#73)

Adds households.timezone, defaulted to America/New_York, and the update policy
the table has never had. households had only a select policy, so an update
through the RLS client matched zero rows and reported success — the write-side
twin of the unchecked reads in #46."
```

---

### Task 2: `lib/clock.ts` — the only place Intl meets an instant

**Files:**
- Create: `lib/clock.ts`
- Test: `tests/unit/clock.test.ts`

**Interfaces:**
- Produces: `todayIn(timeZone: string, now?: Date): string` returning `'YYYY-MM-DD'`; `hourIn(timeZone: string, now?: Date): number` returning 0–23; `isValidTimeZone(timeZone: string): boolean`.
- `now` is injectable for tests only; production always omits it.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/clock.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { todayIn, hourIn, isValidTimeZone } from '@/lib/clock'

// The exact moment from the #73 screenshot: 8:10pm on Wednesday 2 September in US Eastern, which
// is already Thursday 3 September in UTC. The server said "Good morning, Thursday September 3".
const REPORTED = new Date('2026-09-03T00:10:00Z')

describe('todayIn', () => {
  it('gives the household its own calendar day, not the server\'s', () => {
    expect(todayIn('America/New_York', REPORTED)).toBe('2026-09-02')
    expect(todayIn('UTC', REPORTED)).toBe('2026-09-03')
  })

  it('works east of UTC as well as west', () => {
    // 9:10am on the 3rd in Tokyo — a day ahead of New York at the same instant.
    expect(todayIn('Asia/Tokyo', REPORTED)).toBe('2026-09-03')
  })

  it('zero-pads, so string comparison against a database date stays chronological', () => {
    expect(todayIn('UTC', new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05')
  })

  it('refuses an unknown zone rather than silently falling back to UTC', () => {
    expect(() => todayIn('Mars/Olympus_Mons', REPORTED)).toThrow(/unknown time zone/)
  })
})

describe('hourIn', () => {
  it('gives the household its own hour', () => {
    expect(hourIn('America/New_York', REPORTED)).toBe(20)
    expect(hourIn('UTC', REPORTED)).toBe(0)
  })

  // Some engines render midnight as "24" under hour12: false. A greeting keyed on `hour < 12`
  // would then say "Good evening" at midnight.
  it('reports midnight as 0, never 24', () => {
    expect(hourIn('UTC', new Date('2026-09-03T00:00:00Z'))).toBe(0)
  })

  it('refuses an unknown zone', () => {
    expect(() => hourIn('Nowhere/Special', REPORTED)).toThrow(/unknown time zone/)
  })
})

describe('isValidTimeZone', () => {
  it('accepts a real IANA zone', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
  })

  it('rejects anything Intl does not know', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('America/New York')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/clock.test.ts
```
Expected: FAIL — `Failed to resolve import "@/lib/clock"`.

- [ ] **Step 3: Implement**

Create `lib/clock.ts`:

```ts
// The household's wall clock, and the ONLY module in the app that turns a real instant into a
// calendar value. Everything below this boundary takes a 'YYYY-MM-DD' string.
//
// This exists because `new Date()` on the server is UTC on Vercel while the household is in US
// Eastern, so for about 18% of the year — every evening from 8pm until local midnight — the
// server's calendar day is not the household's (#73).

// `now` is injectable so behaviour can be pinned at a fixed instant in tests. Production omits it.

function formatterFor(timeZone: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone })
  } catch {
    // Falling back to UTC here would be this whole bug wearing a different hat: a wrong day,
    // rendered confidently, with nothing to indicate it.
    throw new Error(`unknown time zone: ${timeZone}`)
  }
}

// The calendar day in `timeZone`, as 'YYYY-MM-DD'.
//
// Read out of formatToParts rather than by parsing a formatted string — locale part ordering is
// not a contract, and 'en-US' would otherwise hand back 9/2/2026.
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = formatterFor(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

// The hour of day in `timeZone`, 0-23.
export function hourIn(timeZone: string, now: Date = new Date()): number {
  const parts = formatterFor(timeZone, { hour: '2-digit', hour12: false }).formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  // Some implementations render midnight as 24 under hour12: false, which would read as evening.
  return hour % 24
}

// Whether Intl recognises this zone. The only authoritative validator available — Postgres cannot
// check an IANA name from a column constraint, so this guards the write instead.
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run the test in both timezone directions**

```bash
npx vitest run tests/unit/clock.test.ts && VITEST_TZ=America/New_York npx vitest run tests/unit/clock.test.ts
```
Expected: PASS both times. These assertions must be independent of the runtime zone — that is the point of the module.

- [ ] **Step 5: Commit**

```bash
git add lib/clock.ts tests/unit/clock.test.ts
git commit -m "feat: lib/clock.ts, the one place Intl meets a real instant (#73)

todayIn and hourIn resolve a moment into the household's calendar day and hour.
An unknown zone throws rather than falling back to UTC, because a silent
fallback is the bug this module exists to remove."
```

---

### Task 3: `lib/household.ts` — read the stored timezone

**Files:**
- Create: `lib/household.ts`
- Test: `tests/unit/household.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DEFAULT_TIMEZONE: string` (`'America/New_York'`) and `householdTimezone(): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/household.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/manual-assets-env.test.ts: the static import below
// is linked before this file's body runs, firing the mock factory.
const { result } = vi.hoisted(() => ({
  result: {} as { data: unknown; error: { message: string } | null },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        limit: () => ({
          maybeSingle: async () => result,
        }),
      }),
    }),
  }),
}))

import { householdTimezone, DEFAULT_TIMEZONE } from '@/lib/household'

beforeEach(() => {
  result.data = { timezone: 'America/Chicago' }
  result.error = null
})

describe('householdTimezone', () => {
  it('returns what the household has stored', async () => {
    await expect(householdTimezone()).resolves.toBe('America/Chicago')
  })

  // #46's rule as it applies here: a failed read must not quietly become a default, because the
  // default silently changes which month the money tiles report.
  it('throws on a read error rather than falling back to the default', async () => {
    result.data = null
    result.error = { message: 'permission denied' }
    await expect(householdTimezone()).rejects.toThrow(/could not read the household timezone/)
  })

  // Distinct from a failure: a signed-in user with no household row yet is a real state, and the
  // default is the honest answer for it.
  it('falls back to the default when there is no household row', async () => {
    result.data = null
    result.error = null
    await expect(householdTimezone()).resolves.toBe(DEFAULT_TIMEZONE)
  })

  it('falls back to the default when the column is null', async () => {
    result.data = { timezone: null }
    await expect(householdTimezone()).resolves.toBe(DEFAULT_TIMEZONE)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/household.test.ts
```
Expected: FAIL — `Failed to resolve import "@/lib/household"`.

- [ ] **Step 3: Implement**

Create `lib/household.ts`:

```ts
import { cache } from 'react'
import { createClient } from './supabase/server'

// The zone this household is assumed to be in until it says otherwise. Matches the column default
// in db/migrations/019_household_timezone.sql — change both together.
export const DEFAULT_TIMEZONE = 'America/New_York'

// The household's timezone, for the four pages that need to know what day it is.
//
// Wrapped in React's cache() so a page reading it more than once during a single render costs one
// query. Before #73 the households row was read in only two places and never by a money page;
// four now need it, which is why this exists rather than another inline select.
export const householdTimezone = cache(async (): Promise<string> => {
  const supabase = await createClient()
  const { data, error } = await supabase.from('households').select('timezone').limit(1).maybeSingle()
  // A failed read must not quietly become the default: the default decides which month the tiles
  // report, so guessing here would produce a confident wrong number (#46).
  if (error) throw new Error(`could not read the household timezone: ${error.message}`)
  // No row, or a null column, is a different thing from a failure — a household that has not set
  // one yet. The default is the honest answer.
  return (data?.timezone as string | null | undefined) ?? DEFAULT_TIMEZONE
})
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run tests/unit/household.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/household.ts tests/unit/household.test.ts
git commit -m "feat: read the household's stored timezone (#73)

One cached accessor, because four money pages now need to know what day it is
and two of them never queried households at all. A read error throws; a missing
row falls back to the default, which are deliberately different cases."
```

---

### Task 4: `longDate` and `monthNameLong` in `lib/format.ts`

**Files:**
- Modify: `lib/format.ts`
- Test: `tests/unit/format.test.ts`

**Interfaces:**
- Produces: `longDate(date: string): string` — `'2026-09-02'` → `'Wednesday, September 2'`; `monthNameLong(key: string): string` — `'2026-09'` → `'September'`.

Note the module will then hold two input shapes: `shortDate` and `monthLabel` take a full `'YYYY-MM-DD'`, `monthNameLong` takes a `'YYYY-MM'` key because that is what `lastNMonths` returns and what the dashboard tile already has in hand.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/format.test.ts` (and add `longDate, monthNameLong` to the existing import from `@/lib/format`):

```ts
describe('longDate', () => {
  it('names the weekday, month and day of a calendar date', () => {
    expect(longDate('2026-09-02')).toBe('Wednesday, September 2')
    expect(longDate('2026-01-01')).toBe('Thursday, January 1')
  })

  // The whole point: built from the string's own digits through Date.UTC, so it cannot render the
  // day before west of Greenwich the way `new Date('2026-09-02')` would.
  it('does not drift to the previous day', () => {
    expect(longDate('2026-03-01')).toBe('Sunday, March 1')
    expect(longDate('2026-12-31')).toBe('Thursday, December 31')
  })

  it('returns the input unchanged when it cannot be read', () => {
    expect(longDate('not-a-date')).toBe('not-a-date')
    expect(longDate('2026-13-01')).toBe('2026-13-01')
  })
})

describe('monthNameLong', () => {
  it('names the month of a YYYY-MM key', () => {
    expect(monthNameLong('2026-09')).toBe('September')
    expect(monthNameLong('2026-01')).toBe('January')
  })

  // It is handed keys from lastNMonths, which are 'YYYY-MM'; a full date must still work rather
  // than silently returning the input, because the two shapes are easy to mix up.
  it('accepts a full date too', () => {
    expect(monthNameLong('2026-09-02')).toBe('September')
  })

  it('returns the input unchanged when it cannot be read', () => {
    expect(monthNameLong('nope')).toBe('nope')
    expect(monthNameLong('2026-99')).toBe('2026-99')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/format.test.ts
```
Expected: FAIL — `longDate is not a function`.

- [ ] **Step 3: Implement**

Append to `lib/format.ts`:

```ts
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// 'YYYY-MM-DD' -> 'Wednesday, September 2'.
//
// The weekday comes from a Date built with Date.UTC and read back with getUTCDay, so the
// construction and the read are in the same zone and cancel out. `new Date('2026-09-02')` would
// be UTC midnight and render as 1 September for anyone west of Greenwich.
export function longDate(date: string): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  if (!y || !m || m > 12 || !d || d > 31) return date
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${weekday}, ${MONTH_NAMES[m - 1]} ${d}`
}

// 'YYYY-MM' (or 'YYYY-MM-DD') -> 'September', for a tile that names the month in full.
export function monthNameLong(key: string): string {
  const m = Number(key.slice(5, 7))
  if (!m || m > 12) return key
  return MONTH_NAMES[m - 1]
}
```

- [ ] **Step 4: Run the tests in both directions**

```bash
npx vitest run tests/unit/format.test.ts && VITEST_TZ=America/New_York npx vitest run tests/unit/format.test.ts
```
Expected: PASS both times.

- [ ] **Step 5: Commit**

```bash
git add lib/format.ts tests/unit/format.test.ts
git commit -m "feat: longDate and monthNameLong, built from digits not Dates (#73)

Both follow shortDate and monthLabel: parse the string's own digits, never
construct a Date from an instant. longDate needs a weekday, so it goes through
Date.UTC and getUTCDay, which cancel out."
```

---

### Task 5: `lastCompleteMonths` takes a day string, and Trends passes the household's

**Files:**
- Modify: `lib/budget.ts` (`lastCompleteMonths`, delete private `isoDay`)
- Modify: `app/(app)/trends/page.tsx:1-21`
- Test: `tests/unit/budget.test.ts`, `tests/unit/trends-view.test.ts`, `tests/unit/trends-page.test.tsx`

**Interfaces:**
- Consumes: `todayIn` from `lib/clock.ts`, `householdTimezone` from `lib/household.ts`.
- Produces: `lastCompleteMonths(today: string): { current: DateWindow; previous: DateWindow }`.

- [ ] **Step 1: Change the tests to the new signature**

In `tests/unit/budget.test.ts`, the `lastCompleteMonths` describe block currently builds `Date` objects. Replace every construction with a day string, and replace the whole `everyDay` helper — **it currently rebuilds "today" from server-local parts as its own oracle, which must move in lockstep or its "behind today" assertion drifts.**

Replace the existing `const w = lastCompleteMonths(new Date(2026, 8, 2))` with:

```ts
const w = lastCompleteMonths('2026-09-02')
```

Replace the four other point cases:

```ts
  it('does not treat the current month as complete on its last day', () => {
    expect(lastCompleteMonths('2026-09-30').current).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    })
  })

  it('knows how long February is', () => {
    expect(lastCompleteMonths('2024-03-10').current.to).toBe('2024-02-29') // leap
    expect(lastCompleteMonths('2026-03-10').current.to).toBe('2026-02-28')
  })

  it('crosses a year boundary correctly', () => {
    const jan = lastCompleteMonths('2026-01-05')
    expect(jan.current).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(jan.previous).toEqual({ from: '2025-11-01', to: '2025-11-30' })
  })

  it('refuses a malformed day instead of building a NaN window', () => {
    expect(() => lastCompleteMonths('nonsense')).toThrow(/expected 'YYYY-MM-DD'/)
    expect(() => lastCompleteMonths('2026-13-01')).toThrow(/expected 'YYYY-MM-DD'/)
  })
```

Replace the `everyDay` helper so its oracle is a string, not local `Date` parts:

```ts
  // Sweeps every day from 2024-01-01 to 2030-12-31 as a STRING. The previous version rebuilt
  // "today" from now.getFullYear()/getMonth()/getDate(), which is exactly the server-clock read
  // #73 removed — an oracle that would have had to be wrong in the same way as the code to agree
  // with it.
  const everyDay = (fn: (today: string) => string | null): string[] => {
    const bad: string[] = []
    const cursor = new Date(Date.UTC(2024, 0, 1))
    const stop = Date.UTC(2031, 0, 1)
    while (cursor.getTime() < stop) {
      const today = cursor.toISOString().slice(0, 10)
      const complaint = fn(today)
      if (complaint) bad.push(complaint)
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return bad
  }
```

Then update the three property tests to take `today` instead of `now`:

```ts
  it('always stays contiguous, non-overlapping, and behind today', () => {
    const nextDay = (s: string) => {
      const d = new Date(`${s}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + 1)
      return d.toISOString().slice(0, 10)
    }
    const bad = everyDay((today) => {
      const { current, previous } = lastCompleteMonths(today)
      if (nextDay(previous.to) !== current.from) return `${today}: not contiguous`
      if (!(current.to < today)) return `${today}: current window is not finished`
      if (current.from.slice(8) !== '01' || previous.from.slice(8) !== '01') {
        return `${today}: a window does not start on the 1st`
      }
      return null
    })
    expect(bad).toEqual([])
  })
```

In the two bill-cadence tests (`holds exactly one occurrence of a bill %s` and `is still fooled by a bill that posts outside its own calendar month`) change only the callback parameter, from `(now) => { const { current, previous } = lastCompleteMonths(now); ... }` to `(today) => { const { current, previous } = lastCompleteMonths(today); ... }`. Their `postings()` fixture is unchanged — it synthesises bill dates and is a fixture, not an oracle.

In `tests/unit/trends-view.test.ts`, replace lines 47-48:

```ts
const NOW = '2026-09-02'
const windows = lastCompleteMonths(NOW)
```

and change the import on line 2 from `lastCompleteMonths` staying as-is (the name does not change).

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run tests/unit/budget.test.ts tests/unit/trends-view.test.ts
```
Expected: FAIL — the implementation still reads `now.getTime()`, so passing a string throws or produces `NaN` windows.

- [ ] **Step 3: Implement the new signature**

In `lib/budget.ts`, replace the `lastCompleteMonths` function and delete the private `isoDay` below it. Keep the long explanatory comment above the function exactly as it is — it explains the calendar-month choice and is still accurate — and add the paragraph below about why the input is a string.

```ts
// Takes the household's own calendar day (see lib/clock.ts), not a Date. A Date cannot carry the
// answer: this function has to read a year and a month, and reading them off an instant projects
// it through the RUNTIME's zone — UTC on Vercel — which is the bug in #73. A 'YYYY-MM-DD' string
// has already been resolved in the household's zone and cannot be re-interpreted.
export function lastCompleteMonths(today: string): { current: DateWindow; previous: DateWindow } {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  // A malformed day would build a 'NaN-NaN-NaN' window and reach the database as a filter. Fail
  // here, where the cause is legible.
  if (!year || !month || month > 12) {
    throw new Error(`lastCompleteMonths: expected 'YYYY-MM-DD', got '${today}'`)
  }
  // Constructed in UTC and read back in UTC, so the two cancel and no local zone is involved.
  // Day 0 of a month is the last day of the one before it, which is how each window learns its
  // own length without anyone hard-coding 28, 30 or 31.
  const monthWindow = (monthsBack: number): DateWindow => ({
    from: utcDay(new Date(Date.UTC(year, month - 1 - monthsBack, 1))),
    to: utcDay(new Date(Date.UTC(year, month - monthsBack, 0))),
  })
  return { current: monthWindow(1), previous: monthWindow(2) }
}

// A Date's UTC calendar day as 'YYYY-MM-DD'. Only ever given Dates this module built from
// Date.UTC parts, so the round trip is exact. Replaces the previous isoDay, which read LOCAL
// parts — correct for its synthetic inputs and a silent UTC-parts reader the moment anything
// handed it a real instant.
function utcDay(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${m}-${day}`
}
```

- [ ] **Step 4: Wire the Trends page**

In `app/(app)/trends/page.tsx`, add two imports and replace line 21.

Add after the existing `import { trendsView } from '@/lib/trends'`:

```ts
import { todayIn } from '@/lib/clock'
import { householdTimezone } from '@/lib/household'
```

Replace `const windows = lastCompleteMonths(new Date())` with:

```ts
  // The household's day, not the server's: at 8pm US Eastern the server is already tomorrow, and
  // on the last evening of a month that moved this page forward a whole month early (#73).
  const windows = lastCompleteMonths(todayIn(await householdTimezone()))
```

- [ ] **Step 5: Seed the household row in the Trends page test**

In `tests/unit/trends-page.test.tsx`, the Supabase stub implements only `select/order/eq/gte/lte` and seeds only `categories` and `transactions`. Add the two chained methods the household read uses, and seed the row.

Replace the `chainFor` method list line with:

```ts
  for (const method of ['select', 'order', 'eq', 'gte', 'lte', 'limit']) chain[method] = () => chain
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
```

Replace the `beforeEach` body with:

```ts
beforeEach(() => {
  results.categories = ok
  results.transactions = ok
  results.households = { data: { timezone: 'America/New_York' }, error: null }
})
```

- [ ] **Step 6: Run everything in both directions**

```bash
npx vitest run && VITEST_TZ=America/New_York npx vitest run && npx tsc --noEmit && npx eslint
```
Expected: all green in both runs.

- [ ] **Step 7: Commit**

```bash
git add lib/budget.ts "app/(app)/trends/page.tsx" tests/unit/budget.test.ts tests/unit/trends-view.test.ts tests/unit/trends-page.test.tsx
git commit -m "feat: lastCompleteMonths takes the household's day, not a Date (#73)

A Date cannot carry the answer — reading a month off an instant projects it
through the runtime's zone, which is the bug. The property sweep's oracle moved
from local Date parts to strings in the same commit, since it would otherwise
have had to be wrong in the same way as the code to keep agreeing with it.

isoDay is deleted rather than adapted: it read LOCAL parts, which was correct
only because its inputs were synthetic local-midnight Dates."
```

---

### Task 6: `lastNMonths` takes a day string, and Breakdown passes the household's

**Files:**
- Modify: `lib/dashboard.ts` (`lastNMonths`)
- Modify: `app/(app)/breakdown/[metric]/page.tsx:123-125`
- Test: `tests/unit/dashboard.test.ts`

**Interfaces:**
- Consumes: `todayIn`, `householdTimezone`.
- Produces: `lastNMonths(today: string, n: number): { key: string; label: string }[]`.

- [ ] **Step 1: Change the tests to the new signature**

In `tests/unit/dashboard.test.ts`, find the two `lastNMonths` calls and replace them:

```ts
    expect(lastNMonths('2026-07-15', 6).map((m) => m.key)).toEqual([
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
    ])
```

and

```ts
    expect(lastNMonths('2026-01-10', 3).map((m) => m.key)).toEqual(['2025-11', '2025-12', '2026-01'])
```

Then add a guard case in the same describe block:

```ts
  it('refuses a malformed day instead of returning NaN keys', () => {
    expect(() => lastNMonths('nonsense', 6)).toThrow(/expected 'YYYY-MM-DD'/)
  })
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/unit/dashboard.test.ts
```
Expected: FAIL — string input produces `NaN` keys from `now.getFullYear()`.

- [ ] **Step 3: Implement**

In `lib/dashboard.ts`, replace `lastNMonths`:

```ts
// The last `n` months (chronological), each as { key: 'YYYY-MM', label: 'Jul' }.
//
// Takes the household's own calendar day (see lib/clock.ts). It used to take a Date and read
// now.getFullYear()/getMonth() off it, which projects the instant through the RUNTIME's zone —
// so on a UTC server it rolled to a new month four hours early for a US Eastern household, and
// the dashboard's "Spent in September" tile showed a fresh ~$0 month while August was still
// running (#73).
export function lastNMonths(today: string, n: number): { key: string; label: string }[] {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  if (!year || !month || month > 12) {
    throw new Error(`lastNMonths: expected 'YYYY-MM-DD', got '${today}'`)
  }
  const out: { key: string; label: string }[] = []
  for (let i = n - 1; i >= 0; i--) {
    // Constructed in UTC and read back in UTC, so the two cancel and no local zone is involved.
    const d = new Date(Date.UTC(year, month - 1 - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    out.push({ key, label: MONTH_LABELS[d.getUTCMonth()] })
  }
  return out
}
```

- [ ] **Step 4: Wire the Breakdown page**

In `app/(app)/breakdown/[metric]/page.tsx`, add the imports alongside the existing `lib` imports:

```ts
import { todayIn } from '@/lib/clock'
import { householdTimezone } from '@/lib/household'
```

Replace lines 123-124:

```ts
    // The household's day, not the server's — this month key is also embedded in the outbound
    // /transactions?...&month= links below, so a wrong month here propagates (#73).
    const months = lastNMonths(todayIn(await householdTimezone()), 6)
```

(Delete the now-unused `const now = new Date()` line above it.)

- [ ] **Step 5: Run everything in both directions**

```bash
npx vitest run && VITEST_TZ=America/New_York npx vitest run && npx tsc --noEmit && npx eslint
```
Expected: all green. `npx tsc --noEmit` will still flag `app/(app)/dashboard/page.tsx` — it calls `lastNMonths(now, 6)` and is fixed in Task 7. **If that is the only error, that is expected at this step; do not commit until it is resolved.** To keep this task independently green, apply the dashboard's `lastNMonths` call now as a one-line change:

In `app/(app)/dashboard/page.tsx`, add the same two imports and replace `const months = lastNMonths(now, 6)` with:

```ts
  const months = lastNMonths(todayIn(await householdTimezone()), 6)
```

Leave the greeting, `dateStr` and `thisMonthLabel` alone — Task 7 handles them.

Re-run:

```bash
npx vitest run && VITEST_TZ=America/New_York npx vitest run && npx tsc --noEmit && npx eslint
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add lib/dashboard.ts "app/(app)/breakdown/[metric]/page.tsx" "app/(app)/dashboard/page.tsx" tests/unit/dashboard.test.ts
git commit -m "feat: lastNMonths takes the household's day, not a Date (#73)

Same reason as lastCompleteMonths: the body reads getFullYear/getMonth, which
project through the runtime's zone. Breakdown embeds this month key into its
outbound /transactions?month= links, so a wrong month propagated."
```

---

### Task 7: The dashboard's remaining four sites

**Files:**
- Modify: `app/(app)/dashboard/page.tsx:60-72`, `:120`, `:197-198`
- Test: `tests/unit/dashboard-page.test.tsx` (create)

**Interfaces:**
- Consumes: `todayIn`, `hourIn`, `householdTimezone`, `longDate`, `monthNameLong`.

This is the regression test for #73 itself. The dashboard has five calendar sites; one was fixed in Task 6, and **`thisMonthLabel` at `:120` is derived independently of `thisMonthKey` at `:128`, so fixing one without the other lets the tile's label and its number name different months** — worse than the original bug.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dashboard-page.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/trends-page.test.tsx: the static page import below
// is linked before this file's body runs.
const { results, tz } = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  tz: { value: 'America/New_York' },
}))

const chainFor = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq', 'gte', 'lte', 'limit', 'not']) chain[m] = () => chain
  chain.single = async () => results[table] ?? { data: null, error: null }
  chain.maybeSingle = async () => results[table] ?? { data: null, error: null }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => chainFor(table) }),
}))
vi.mock('@/lib/household', () => ({
  DEFAULT_TIMEZONE: 'America/New_York',
  householdTimezone: async () => tz.value,
}))
vi.mock('@/lib/plaid-items', () => ({ listItemsForHousehold: async () => [] }))
vi.mock('@/lib/manual-assets', () => ({ listManualAssets: async () => [] }))
vi.mock('@/lib/receivable', () => ({ fetchReceivable: async () => 0 }))

import DashboardPage from '@/app/(app)/dashboard/page'

// The exact moment from the #73 screenshot: 8:10pm on Wednesday 2 September in US Eastern, which
// is already Thursday 3 September in UTC.
const REPORTED = new Date('2026-09-03T00:10:00Z')

// Walk the returned element tree and collect every string, so assertions do not depend on where
// in the JSX a given piece of copy sits.
function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const el = node as { props?: { children?: unknown; title?: unknown; subtitle?: unknown; label?: unknown } }
  if (!el.props) return ''
  return [el.props.title, el.props.subtitle, el.props.label, el.props.children].map(textOf).join(' ')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(REPORTED)
  tz.value = 'America/New_York'
  results.accounts = { data: [], error: null }
  results.memberships = { data: { household_id: 'hh-1' }, error: null }
  results.categories = { data: [], error: null }
  results.transactions = { data: [], error: null }
  results.budgets = { data: [], error: null }
})

describe('Dashboard clock', () => {
  // The reported bug, exactly.
  it('greets by the household\'s hour, not the server\'s', async () => {
    const text = textOf(await DashboardPage({ searchParams: Promise.resolve({}) }))
    expect(text).toContain('Good evening')
    expect(text).not.toContain('Good morning')
  })

  it('dates the page by the household\'s day, not the server\'s', async () => {
    const text = textOf(await DashboardPage({ searchParams: Promise.resolve({}) }))
    expect(text).toContain('Wednesday, September 2')
    expect(text).not.toContain('September 3')
  })

  // The half that actually matters: at 8pm on 31 August the server is already in September, so
  // the tile would name a fresh month while August was still running.
  it('names the household\'s month on the spending tile', async () => {
    vi.setSystemTime(new Date('2026-09-01T00:10:00Z')) // 8:10pm on 31 August in New York
    const text = textOf(await DashboardPage({ searchParams: Promise.resolve({}) }))
    expect(text).toContain('Spent in August')
    expect(text).not.toContain('Spent in September')
  })

  it('follows the stored zone rather than a hardcoded one', async () => {
    tz.value = 'Asia/Tokyo' // 9:10am on the 3rd
    const text = textOf(await DashboardPage({ searchParams: Promise.resolve({}) }))
    expect(text).toContain('Good morning')
    expect(text).toContain('Thursday, September 3')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/dashboard-page.test.tsx
```
Expected: FAIL — the greeting reads `now.getHours()` on a UTC runtime, so the first test finds "Good morning".

- [ ] **Step 3: Implement**

In `app/(app)/dashboard/page.tsx`, add the imports:

```ts
import { todayIn, hourIn } from '@/lib/clock'
import { householdTimezone } from '@/lib/household'
import { longDate, monthNameLong } from '@/lib/format'
```

(`money` is already imported from `@/lib/format`; extend that import rather than adding a second one.)

Replace lines 60-67. The `now` binding stays, because `homeStale` genuinely wants an instant:

```ts
  // Two different questions, two different sources. `now` is an INSTANT, and homeStale below
  // measures elapsed milliseconds between two instants — correct in any zone. `today` and the
  // greeting are CALENDAR values, which only mean anything in a stated zone (#73).
  const now = new Date()
  const tz = await householdTimezone()
  const today = todayIn(tz)
  const homeStale =
    home != null && now.getTime() - new Date(home.updated_at).getTime() > 30 * 24 * 60 * 60 * 1000
  const dateStr = longDate(today)
```

Replace both `greeting(now.getHours())` occurrences (the empty-state header at `:72` and the main header at `:197`) with:

```tsx
greeting(hourIn(tz))
```

The timezone must be resolved above the `accounts.length === 0` early return, which the placement in the block above satisfies.

Replace `const months = lastNMonths(todayIn(await householdTimezone()), 6)` (added in Task 6) with the now-available local:

```ts
  const months = lastNMonths(today, 6)
```

Replace line 120:

```ts
  // Derived from the same key as the number beside it. These used to be computed independently,
  // so a partial fix could have had the label and the amount naming different months.
  const thisMonthLabel = monthNameLong(months[months.length - 1].key)
```

Note `thisMonthKey` at `:128` already reads `months[months.length - 1].key`; leave it as is.

- [ ] **Step 4: Run the tests in both directions**

```bash
npx vitest run && VITEST_TZ=America/New_York npx vitest run && npx tsc --noEmit && npx eslint
```
Expected: all green in both runs. If the Tokyo run passes but New York fails (or vice versa), a calendar value is still being read off the runtime.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/dashboard/page.tsx" tests/unit/dashboard-page.test.tsx
git commit -m "feat: the dashboard runs on the household's clock (#73)

Greeting, date line and month label all derive from the stored zone. thisMonthLabel
now comes from the same month key as the number beside it — they were computed
independently, so a partial fix could have had the tile's label and its amount
naming different months.

`now` survives for homeStale, which measures elapsed milliseconds between two
instants and is correct in any zone."
```

---

### Task 8: The Budgets page

**Files:**
- Modify: `app/(app)/budgets/page.tsx:13-16`
- Test: `tests/unit/budgets-page.test.tsx` (create)

**Interfaces:**
- Consumes: `todayIn`, `householdTimezone`, `lastNMonths` is not used here — the month bounds are built inline.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/budgets-page.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { calls, tz } = vi.hoisted(() => ({
  calls: { gte: [] as string[], lt: [] as string[] },
  tz: { value: 'America/New_York' },
}))

// Record the date bounds the page asks the database for — that is the whole behaviour under test.
const chainFor = () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'order', 'eq']) chain[m] = () => chain
  chain.gte = (_col: string, v: string) => {
    calls.gte.push(v)
    return chain
  }
  chain.lt = (_col: string, v: string) => {
    calls.lt.push(v)
    return chain
  }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => chainFor() }) }))
vi.mock('@/lib/household', () => ({
  DEFAULT_TIMEZONE: 'America/New_York',
  householdTimezone: async () => tz.value,
}))

import BudgetsPage from '@/app/(app)/budgets/page'

beforeEach(() => {
  vi.useFakeTimers()
  calls.gte = []
  calls.lt = []
  tz.value = 'America/New_York'
})

describe('Budgets month window', () => {
  // At 8:10pm on 31 August the server is already in September, so every bar emptied four hours
  // early (#73).
  it('uses the household\'s month, not the server\'s', async () => {
    vi.setSystemTime(new Date('2026-09-01T00:10:00Z'))
    await BudgetsPage()
    expect(calls.gte).toContain('2026-08-01')
    expect(calls.lt).toContain('2026-09-01')
  })

  it('rolls over when the household\'s month actually changes', async () => {
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z')) // 8am on 1 September in New York
    await BudgetsPage()
    expect(calls.gte).toContain('2026-09-01')
    expect(calls.lt).toContain('2026-10-01')
  })

  it('crosses a year boundary correctly', async () => {
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'))
    await BudgetsPage()
    expect(calls.gte).toContain('2026-12-01')
    expect(calls.lt).toContain('2027-01-01')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/budgets-page.test.tsx
```
Expected: FAIL — the first case gets `2026-09-01` / `2026-10-01`, because the server is in September.

- [ ] **Step 3: Implement**

In `app/(app)/budgets/page.tsx`, add the imports:

```ts
import { todayIn } from '@/lib/clock'
import { householdTimezone } from '@/lib/household'
```

Replace lines 13-16:

```ts
  // The household's month, not the server's: at 8pm US Eastern the server is already tomorrow, so
  // on the last evening of a month every bar on this page emptied four hours early (#73).
  const today = todayIn(await householdTimezone())
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const monthStart = `${today.slice(0, 7)}-01`
  // Constructed in UTC and read back in UTC, so the two cancel and December rolls to January
  // without any local zone involved.
  const next = new Date(Date.UTC(year, month, 1))
  const nextMonthStart = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`
```

- [ ] **Step 4: Run the tests in both directions**

```bash
npx vitest run && VITEST_TZ=America/New_York npx vitest run && npx tsc --noEmit && npx eslint
```
Expected: all green in both runs.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/budgets/page.tsx" tests/unit/budgets-page.test.tsx
git commit -m "feat: Budgets uses the household's month (#73)

At 8pm US Eastern on the last day of a month, the server was already in the next
one, so every bar read empty four hours early."
```

---

### Task 9: `POST /api/household/timezone`

**Files:**
- Create: `app/api/household/timezone/route.ts`
- Test: `tests/unit/household-timezone-route.test.ts`

**Interfaces:**
- Consumes: `isValidTimeZone` from `lib/clock.ts`.
- Produces: `POST /api/household/timezone` accepting `{ timezone: string }`, returning `{ ok: true }` or `{ error: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/household-timezone-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted for the same reason as tests/unit/manual-assets-env.test.ts: the static route import
// below is linked before this file's body runs.
const { state } = vi.hoisted(() => ({
  state: {
    user: { id: 'u-1' } as { id: string } | null,
    membership: { data: { household_id: 'hh-1' }, error: null } as {
      data: { household_id: string } | null
      error: { message: string } | null
    },
    updateResult: { error: null, count: 1 } as { error: { message: string } | null; count: number },
    updated: [] as unknown[],
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) =>
      table === 'memberships'
        ? { select: () => ({ limit: () => ({ single: async () => state.membership }) }) }
        : {
            update: (patch: unknown) => {
              state.updated.push(patch)
              return { eq: async () => state.updateResult }
            },
          },
  }),
}))

import { POST } from '@/app/api/household/timezone/route'

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/household/timezone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

beforeEach(() => {
  state.user = { id: 'u-1' }
  state.membership = { data: { household_id: 'hh-1' }, error: null }
  state.updateResult = { error: null, count: 1 }
  state.updated = []
})

describe('POST /api/household/timezone', () => {
  it('rejects an unauthenticated caller', async () => {
    state.user = null
    const res = await post({ timezone: 'America/Chicago' })
    expect(res.status).toBe(401)
    expect(state.updated).toEqual([])
  })

  // Validated before the database is touched: Postgres cannot check an IANA name, so this is the
  // only place it can be checked at all.
  it('rejects a zone Intl does not know, without writing', async () => {
    const res = await post({ timezone: 'Mars/Olympus_Mons' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'That is not a timezone we recognise.' })
    expect(state.updated).toEqual([])
  })

  it('rejects a missing timezone', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(state.updated).toEqual([])
  })

  it('writes a valid zone', async () => {
    const res = await post({ timezone: 'America/Chicago' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(state.updated).toEqual([{ timezone: 'America/Chicago' }])
  })

  // households had no update policy before #73's migration. If it is ever missing again, the
  // update matches zero rows and Supabase reports SUCCESS — so a silent no-op has to be caught
  // here rather than shown to the user as a save that worked.
  it('reports a write that changed nothing rather than claiming success', async () => {
    state.updateResult = { error: null, count: 0 }
    const res = await post({ timezone: 'America/Chicago' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/could not be saved/i)
  })

  it('reports a failed write without leaking the database\'s words', async () => {
    state.updateResult = { error: { message: 'permission denied for table households' }, count: 0 }
    const res = await post({ timezone: 'America/Chicago' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('permission denied')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/household-timezone-route.test.ts
```
Expected: FAIL — `Failed to resolve import "@/app/api/household/timezone/route"`.

- [ ] **Step 3: Implement**

Create `app/api/household/timezone/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isValidTimeZone } from '@/lib/clock'

// Set the household's timezone. Follows app/api/manual-assets/route.ts: the household is resolved
// server-side from memberships (the client sends only the zone), and the database's own words are
// logged rather than shown.
export async function POST(req: Request) {
  const { timezone } = await req.json().catch(() => ({}) as { timezone?: unknown })
  const tz = typeof timezone === 'string' ? timezone.trim() : ''
  // Validated here because it cannot be validated in the schema: Postgres has no way to check an
  // IANA name from a column constraint, and Intl is the only authority available.
  if (!tz || !isValidTimeZone(tz)) {
    return NextResponse.json({ error: 'That is not a timezone we recognise.' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  if (!m) return NextResponse.json({ error: 'no household' }, { status: 403 })

  const { error, count } = await supabase
    .from('households')
    .update({ timezone: tz }, { count: 'exact' })
    .eq('id', m.household_id)

  // Two failures, and the second is the interesting one. Before #73 households had only a select
  // policy, so an update matched zero rows and Supabase reported SUCCESS — a save that appeared to
  // work, refreshed, and showed the old value forever. Checking the row count is what stops that
  // being invisible if the policy ever goes missing again.
  if (error) {
    console.error('[household/timezone] update failed', error.message)
    return NextResponse.json({ error: "That couldn't be saved. Please try again." }, { status: 500 })
  }
  if (!count) {
    console.error('[household/timezone] update matched no rows — is the update policy present?')
    return NextResponse.json({ error: "That couldn't be saved. Please try again." }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/unit/household-timezone-route.test.ts && npx tsc --noEmit && npx eslint
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/household/timezone/route.ts tests/unit/household-timezone-route.test.ts
git commit -m "feat: POST /api/household/timezone (#73)

Validates through Intl, because Postgres cannot check an IANA name from a column
constraint. Checks the affected row count as well as the error: with no update
policy the write matches zero rows and Supabase reports success, so a missing
policy would otherwise look like a save that worked."
```

---

### Task 10: The Settings control

**Files:**
- Create: `components/TimezoneCard.tsx`
- Modify: `app/(app)/settings/page.tsx` (the Household section, and its `households` select)
- Test: `tests/unit/timezone-card.test.tsx`

**Interfaces:**
- Consumes: `POST /api/household/timezone`.
- Produces: `TimezoneCard({ current }: { current: string })`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/timezone-card.test.tsx`:

```tsx
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TimezoneCard } from '@/components/TimezoneCard'

// Auto-cleanup only registers when vitest runs with globals; this suite does not.
afterEach(cleanup)

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('TimezoneCard', () => {
  it('shows the stored zone as the selected option', () => {
    render(<TimezoneCard current="America/Chicago" />)
    const select = screen.getByLabelText('Time zone') as HTMLSelectElement
    expect(select.value).toBe('America/Chicago')
  })

  // A zone the browser does not enumerate must still be visible rather than silently replaced by
  // whatever happens to sort first.
  it('keeps an unrecognised stored zone in the list', () => {
    render(<TimezoneCard current="Etc/GMT+3" />)
    const select = screen.getByLabelText('Time zone') as HTMLSelectElement
    expect(Array.from(select.options).some((o) => o.value === 'Etc/GMT+3')).toBe(true)
    expect(select.value).toBe('Etc/GMT+3')
  })

  it('offers a real list of zones', () => {
    render(<TimezoneCard current="America/New_York" />)
    const select = screen.getByLabelText('Time zone') as HTMLSelectElement
    expect(select.options.length).toBeGreaterThan(5)
    expect(Array.from(select.options).some((o) => o.value === 'America/New_York')).toBe(true)
  })

  it('shows the server\'s message when saving fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ error: 'That is not a timezone we recognise.' }) }))
    )
    render(<TimezoneCard current="America/New_York" />)
    const select = screen.getByLabelText('Time zone') as HTMLSelectElement
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(select, { target: { value: 'America/Chicago' } })
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'That is not a timezone we recognise.'
    )
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/timezone-card.test.tsx
```
Expected: FAIL — `Failed to resolve import "@/components/TimezoneCard"`.

- [ ] **Step 3: Implement**

Create `components/TimezoneCard.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { selectClass } from '@/components/ui/styles'

// The zone every date in the app is derived from (#73). Saved on change, like CategoryPicker —
// there is one field and nothing to confirm.

// Intl.supportedValuesOf is the browser's own list, so nothing here needs maintaining and moving
// or travelling is handled. Where it is unavailable, a short list keeps the control usable.
const FALLBACK_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
]

function zones(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? (Intl.supportedValuesOf('timeZone') as string[])
      : FALLBACK_ZONES
  // Always include what is stored, even if this browser does not enumerate it — otherwise the
  // control would silently show a different zone from the one in force.
  return supported.includes(current) ? supported : [current, ...supported]
}

export function TimezoneCard({ current }: { current: string }) {
  const router = useRouter()
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function change(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value
    const previous = value
    setValue(next)
    setBusy(true)
    setError(null)
    const res = await fetch('/api/household/timezone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: next }),
    }).catch(() => null)
    setBusy(false)
    if (!res || !res.ok) {
      // Roll the control back, so it never shows a zone that was not saved.
      setValue(previous)
      const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {}
      setError(body.error ?? "That couldn't be saved. Please try again.")
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <select
        value={value}
        onChange={change}
        disabled={busy}
        aria-label="Time zone"
        className={selectClass}
      >
        {zones(value).map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      <p className="text-xs text-faint">
        Every date in the app — the month your budgets cover, what counts as today — is worked out
        in this zone.
      </p>
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Wire it into Settings**

In `app/(app)/settings/page.tsx`, widen the households select on line 17:

```ts
  const { data: households } = await supabase.from('households').select('id, name, timezone').limit(1)
```

Add the import alongside the other component imports:

```ts
import { TimezoneCard } from '@/components/TimezoneCard'
```

Inside the Household `<Card>`, after `<InvitePartnerForm householdId={household.id} />`, add:

```tsx
            <TimezoneCard current={(household.timezone as string) ?? 'America/New_York'} />
```

- [ ] **Step 5: Run everything in both directions**

```bash
npx vitest run && VITEST_TZ=America/New_York npx vitest run && npx tsc --noEmit && npx eslint && npm run build
```
Expected: all green in both runs, and a clean build.

- [ ] **Step 6: Commit**

```bash
git add components/TimezoneCard.tsx "app/(app)/settings/page.tsx" tests/unit/timezone-card.test.tsx
git commit -m "feat: a timezone control in Settings (#73)

Populated from Intl.supportedValuesOf, so the list needs no maintaining and
travelling is handled. The stored zone is always an option even when the browser
does not enumerate it, and the control rolls back on a failed save rather than
showing a zone that was never written."
```

---

### Task 11: Verification sweep

**Files:**
- Modify: `README.md` (if the Trends or dashboard descriptions need it)

- [ ] **Step 1: Prove no calendar value is still read from the runtime**

```bash
grep -rn "new Date()" app lib components | grep -v node_modules
```
Expected: exactly two survivors, both correct and both commented as such — `app/(app)/dashboard/page.tsx` (`now`, feeding `homeStale`'s elapsed-millisecond comparison) and `app/api/manual-assets/route.ts:43` (`updated_at`, an instant in a `timestamptz`). Anything else is a regression.

```bash
grep -rn "getHours()\|getMonth()\|getFullYear()\|getDate()" app lib components | grep -v node_modules | grep -v getUTC
```
Expected: no hits. Every remaining month or day read should be a `getUTC*` paired with a `Date.UTC` construction.

- [ ] **Step 2: Mutation-test the fix**

Each of these must make the suite FAIL. If one survives, a test is missing.

```bash
# The greeting falls back to the server clock
# in app/(app)/dashboard/page.tsx replace  greeting(hourIn(tz))  with  greeting(new Date().getHours())
npx vitest run   # expect FAIL

# The month window falls back to the server clock
# in app/(app)/budgets/page.tsx replace  todayIn(await householdTimezone())  with  new Date().toISOString().slice(0,10)
npx vitest run   # expect FAIL

# The stored zone is ignored in favour of a hardcoded one
# in lib/household.ts replace the returned value with  'UTC'
npx vitest run   # expect FAIL

# The tile label and its number decouple again
# in app/(app)/dashboard/page.tsx replace monthNameLong(months[months.length - 1].key) with monthNameLong(months[0].key)
npx vitest run   # expect FAIL
```

Revert each mutation before the next.

- [ ] **Step 3: Full verification in both timezone directions**

```bash
npx vitest run && VITEST_TZ=America/New_York npx vitest run && npx tsc --noEmit && npx eslint && npm run check:secrets && npm run build
```
Expected: all green. Test count should be 277 + the new tests, with no existing assertion weakened.

- [ ] **Step 4: Check the README still describes the app truthfully**

```bash
grep -n "Trends\|month" README.md | head -20
```
If any line describes a page's window in a way this change made stale, update it. If nothing is stale, skip.

- [ ] **Step 5: Commit anything outstanding and open the PR**

```bash
git add -A -- ':!*.code-workspace'
git commit -m "chore: verification sweep for the household timezone (#73)"
gh pr create --title "Run the app on the household's clock, not the server's (closes #73)" --body-file <(cat <<'BODY'
Closes #73.

At 8:10pm on Wednesday 2 September the dashboard read "Good morning / Thursday,
September 3", because every date came from `new Date()` on the server — UTC on
Vercel — while the household is in US Eastern.

The greeting was the symptom. The defect was that the same clock chose which
month the money tiles reported: at 8:10pm on 31 August the server was already in
September, so "Spent in September" showed a fresh ~$0 month while August was
still running, and every Budgets bar emptied four hours early.

`households.timezone` is now the authority, `lib/clock.ts` is the only module
that turns an instant into a calendar value, and below it every date function
takes a 'YYYY-MM-DD' string.
BODY
)
```

---

## Self-Review

**Spec coverage.** §1 → Task 7's regression test. §2 → Tasks 2, 5, 6. §3.1 → Task 1. §3.2 → Task 1's policy plus Task 9's row-count check. §4 → Task 2. §5.1 → Task 3. §5.2 → Task 9. §6 → Tasks 5, 6. §7 → Tasks 5, 6, 7, 8, plus the two formatters in Task 4. §8 → Task 10. §9 → the test steps throughout, plus Task 11's mutation sweep. §10 (out of scope) → deliberately untouched; Task 11 Step 1's grep confirms `manual-assets` and `homeStale` survive as the two expected `new Date()` uses.

**Placeholders.** None — every code step carries the actual code.

**Type consistency.** `todayIn(timeZone, now?) → string` and `hourIn(timeZone, now?) → number` are used with those exact names and arities in Tasks 5, 6, 7, 8. `householdTimezone(): Promise<string>` is awaited at every call site. `lastCompleteMonths(today: string)` and `lastNMonths(today: string, n)` match their new callers. `longDate(date)` and `monthNameLong(key)` match Task 7's usage. `TimezoneCard({ current })` matches the Settings wiring.

**Known ordering constraint.** Task 6 must apply the dashboard's `lastNMonths` call before committing, or `tsc` fails between Tasks 6 and 7; the task says so explicitly at Step 5.
