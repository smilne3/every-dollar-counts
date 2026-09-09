# The Household's Clock — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-09-02
- **Closes:** #73
- **Status:** Approved design, ready for implementation plan
- **One line:** The household stores its own timezone, and every calendar decision in the app is derived from that rather than from the server's clock — which means the date layer stops taking `Date` objects and starts taking `'YYYY-MM-DD'` strings.

---

## 1. Why this exists

At 8:10pm on Wednesday 2 September the dashboard read:

> **Good morning**
> Thursday, September 3 — here's where your money stands

Both halves wrong, both for one reason: every date comes from `new Date()` evaluated on the server, which is UTC on Vercel. The household is in US Eastern, four hours behind.

The server's calendar day differs from the household's for **18.1% of the year** — every evening from 8pm EDT / 7pm EST until local midnight.

**The greeting is the symptom. The month is the defect.** At 8:10pm on 31 August the server believes it is 1 September, so *Spent in September* shows a fresh month at roughly $0 while August is still running, *Saved this month* resets with it, and every Budgets bar empties. For four hours at the end of every month the app reports the wrong month's money, and nothing looks broken.

**Success looks like:** the app's notion of "now" is the household's, everywhere, and the server's zone becomes irrelevant to what any page displays.

## 2. The model

**One column is the authority: `households.timezone`.** Everything else derives from it.

```
households.timezone  ──►  todayIn(tz) ──►  'YYYY-MM-DD'  ──►  every window, key and label
                     └─►  hourIn(tz)  ──►  0-23          ──►  the greeting
```

Two rules hold the design together:

1. **`Intl` meets a real instant in exactly one module.** `lib/clock.ts` is the only place that converts "now" into a calendar value. Nothing else calls `new Date()` to ask what day it is.
2. **Below that boundary, dates are strings.** Every function that reasons about days or months takes `'YYYY-MM-DD'` (or `'YYYY-MM'`) and never constructs a `Date` from an instant.

### 2.1 Why strings, rather than passing a better `Date`

`lastCompleteMonths(now: Date)` and `lastNMonths(now: Date, n)` already take `now` as a parameter, which looks like the fix is only at the callers. It is not. Both bodies call `now.getFullYear()` / `now.getMonth()`, which project the instant through the **runtime's** zone. An instant carries no zone, so any `Date` passed at `2026-09-01T00:10Z` reports September on a UTC server regardless of who passed it.

The alternative — passing a "shifted" `Date` whose local parts happen to equal the household's wall clock — works and is a trick every future reader has to re-derive.

Strings are also not an invention here. They are **the pattern this repo already proved**: `monthKey`, `inRange`, `shortDate`, `monthLabel`, `spendByCategory` and `monthlyFlows` all take a `'YYYY-MM-DD'` string, index by digits, never construct a `Date`, and are all immune to this bug today. `lib/format.ts:41-46` documents the reasoning. This change extends that boundary upward to the two functions that were left behind, rather than teaching five call sites about timezones.

## 3. Storage

### 3.1 The column

```sql
alter table households
  add column if not exists timezone text not null default 'America/New_York';
```

Defaulted rather than backfilled: the default is correct for the only household that exists, and it keeps every existing row working with no data migration.

**No `check` constraint on the value.** Postgres cannot validate an IANA name without consulting `pg_timezone_names`, which a column check cannot reliably do. Validation belongs at the write boundary (§5.2), where `Intl` can answer authoritatively.

### 3.2 RLS — the trap that has to be closed

`households` currently has exactly one policy, `for select` (`006_rls_policies.sql:12-15`). **There is no update policy.** An `UPDATE` issued through the RLS-scoped client therefore matches zero rows and returns **no error** — Supabase reports success.

Saving a timezone that way would appear to work, refresh, and show the old value forever, with nothing in the logs. That is the same silent-failure shape as the unchecked reads fixed in #68, as a write.

So the migration adds one:

```sql
drop policy if exists "update your household" on households;
create policy "update your household" on households
  for update to authenticated
  using ( id in (select private.household_ids()) )
  with check ( id in (select private.household_ids()) );
```

This also makes `households.name` writable, which is harmless — there is no name editor today, and if one is ever added this is the policy it would need.

**The route must still check `error` and verify the row was updated.** A policy makes the write possible; it does not make an unchecked write safe.

## 4. `lib/clock.ts` — the boundary

```ts
// The household's wall clock. The only module that turns a real instant into a calendar value.
export function todayIn(timeZone: string, now?: Date): string   // 'YYYY-MM-DD'
export function hourIn(timeZone: string, now?: Date): number    // 0-23
export function isValidTimeZone(timeZone: string): boolean
```

- `now` is injectable so the behaviour is testable at a fixed instant; production always omits it.
- Both use `Intl.DateTimeFormat(...).formatToParts()` with an explicit `timeZone`, reading named parts rather than parsing a formatted string — locale ordering is not a contract.
- `hourIn` normalises the `hour12: false` midnight case, which some implementations render as `24`.
- `isValidTimeZone` constructs an `Intl.DateTimeFormat` with the zone and catches `RangeError`. That is the only authoritative validator available.
- An unknown zone **throws** rather than silently falling back to UTC. A silent fallback is precisely this bug wearing a different hat.

## 5. Reading and writing the timezone

### 5.1 `lib/household.ts`

`households` is read in two places today (`layout.tsx:12`, `settings/page.tsx:17`), duplicated inline, and **`budgets` and `trends` do not query it at all**. Four pages now need it, so one accessor:

```ts
export async function householdTimezone(): Promise<string>
```

RLS-scoped read, wrapped in React `cache()` so repeated calls within one request cost one query. On a read error it **throws** — per #46's rule, a failed read must not silently become a default that changes what the numbers mean.

### 5.2 `POST /api/household/timezone`

Follows `app/api/manual-assets/route.ts` closely, which is the nearest precedent:

- resolve the household server-side from `memberships` (the client sends only `timezone`);
- reject an invalid zone with 400 before touching the database;
- check `error` **and** that a row was affected;
- log the database's words, do not show them — return a written message, as `manual-assets` does.

No environment guard: a timezone is not Plaid-environment-sensitive.

## 6. The date layer becomes string-based

| Before | After |
| --- | --- |
| `lastCompleteMonths(now: Date)` | `lastCompleteMonths(today: string)` |
| `lastNMonths(now: Date, n)` | `lastNMonths(today: string, n)` |
| private `isoDay(d: Date)` — reads **local** parts | removed; windows built from parsed digits |

Month arithmetic goes through `Date.UTC(...)` construction paired with `getUTC*` reads, which is zone-proof in both directions. `isoDay` is deleted rather than adapted: it is correct today only because its inputs are synthetic local-midnight `Date`s, and it becomes a silent UTC-parts reader the moment anything hands it a real instant. Its DST comment is accurate and moves with the arithmetic.

The existing invalid-input guard survives the signature change: `lastCompleteMonths('nonsense')` must throw, as `lastCompleteMonths(new Date('nonsense'))` does now.

## 7. Call sites

Six, across four pages. `greeting(hour: number)` needs no change — only its argument.

| Site | Derives | Becomes |
| --- | --- | --- |
| `dashboard:72,197` `greeting(now.getHours())` | hour | `greeting(hourIn(tz))` |
| `dashboard:63-67` `dateStr` | weekday + month + day | `longDate(today)` |
| `dashboard:95` `lastNMonths(now, 6)` | month keys | `lastNMonths(today, 6)` |
| `dashboard:120` `thisMonthLabel` | month name | `monthNameLong(thisMonthKey)` |
| `budgets:13-16` `monthStart` / `nextMonthStart` | month bounds | derived from `today` |
| `breakdown:123-125` `lastNMonths(now, 6)` | month key | `lastNMonths(today, 6)` |
| `trends:21` `lastCompleteMonths(new Date())` | two windows | `lastCompleteMonths(today)` |

**`dashboard:120` is a fifth site not in #73's table, and it matters.** `thisMonthLabel` is derived independently of `thisMonthKey` at `:128`, so fixing one and not the other would let the tile's label and its number name different months — worse than the bug. Both now derive from the same key.

**The dashboard's early return uses the greeting too.** `accounts.length === 0` returns at `:69` with its own `<PageHeader title={greeting(...)} subtitle={dateStr} />` at `:72`. The timezone must therefore be resolved *before* that branch, not between it and the main render. Membership is already read at `:49`, so there is room; the constraint is only that the new read goes above `:60`, not below `:69`.

**`breakdown` propagates.** It embeds its month into outbound hrefs (`:145`, `:159`, `:166` — `/transactions?…&month=${thisKey}`), so a wrong month leaks into the transactions page's query string. Fixing the producer fixes the consumer; `transactions/page.tsx` needs no change, as its month parsing is already pure string arithmetic.

Two new formatters in `lib/format.ts`, both taking strings, both matching the existing zone-proof style:

```ts
export function longDate(date: string): string      // '2026-09-02' -> 'Wednesday, September 2'
export function monthNameLong(key: string): string  // '2026-09'    -> 'September'
```

Note the module will then hold two input shapes: `shortDate` and `monthLabel` take a full `'YYYY-MM-DD'`, while `monthNameLong` takes a `'YYYY-MM'` key because that is what `lastNMonths` returns and what the tile already has in hand. Both are named for what they emit, and each returns its input unchanged when it cannot parse it, so a shape mismatch is visible rather than rendering `undefined`.

## 8. Settings

A `TimezoneCard` client component in the Household section, following `HomeValueCard`'s shape: current value, a control, a save button, `router.refresh()` on success, server-supplied error text on failure.

The control is a native `<select className={selectClass}>` populated from `Intl.supportedValuesOf('timeZone')` — roughly 420 zones, supplied by the browser, so nothing needs maintaining and travelling or moving is handled. Where that API is unavailable, fall back to a short list of US zones plus the currently-stored value, so the control can always at least render what is set.

The stored value is always included in the options even if the browser does not list it, so an unrecognised zone is visible rather than silently replaced.

## 9. Testing

**Unit**

- `lib/clock.ts` — `todayIn` and `hourIn` at a fixed instant across several zones, including the reported case: `2026-09-03T00:10Z` in `America/New_York` is `2026-09-02`, hour `20`. Invalid zone throws. `isValidTimeZone` accepts a real zone and rejects nonsense.
- `lastCompleteMonths(today)` / `lastNMonths(today, n)` — the existing cases ported to strings, **including the seven-year property sweep**. That test currently rebuilds "today" from server-local parts as its own oracle (`budget.test.ts:251-253`); the oracle moves to string arithmetic in lockstep, or its "behind today" assertions drift.
- `longDate`, `monthNameLong` — including the UTC-midnight trap the existing `shortDate` / `monthLabel` tests already pin.

**Route** — `POST /api/household/timezone`: 401 unauthenticated, 400 on an invalid zone with no write attempted, success writes, and a failed write is reported rather than swallowed. Follows `tests/unit/manual-assets-env.test.ts`.

**Page** — the regression test for #73 itself: with `households.timezone` set to a zone several hours from the server's, the dashboard's greeting, date string and month key must all follow the **stored** zone, not the runtime's. `tests/unit/trends-page.test.tsx`'s Supabase stub currently implements only `select/order/eq/gte/lte` and seeds only `categories` and `transactions`; it needs `limit`/`single` and a household row.

**Timezone matrix** — CI already runs the suite twice, at `Asia/Tokyo` (default) and `America/New_York` (`VITEST_TZ`), added in #71 because the two date failure modes need opposite zones. Both must pass. The sharper point: a fix that stores `America/New_York` should be scrutinised under the **Tokyo** run, because that is where a residual `now.getMonth()` still reads the runtime zone and disagrees with the stored one.

## 10. Out of scope

- **`components/HomeValueCard.tsx:56`** formats `updatedAt` client-side with `toLocaleDateString()`, i.e. in the viewer's browser zone. It renders correctly today and labels a home-value edit, not money. Left alone deliberately; noted here because it is the one place a calendar day still comes from a clock other than the household's.
- **`app/(app)/reimbursements/page.tsx:16-21`** has a private `monthLabel` shadowing the exported one, with a different input and output. Correct as written (`Date.UTC` + `timeZone: 'UTC'`), and not a file this change touches.
- **Per-user timezones.** The household is the unit everywhere else in this app; two partners in different zones is not a problem anyone has.
- **Detecting the zone from the browser on sign-in.** Considered and rejected: it is wrong-and-unfixable if the first sign-in happens while travelling. The default plus an explicit control is honest.
