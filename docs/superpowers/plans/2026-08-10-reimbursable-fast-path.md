# Reimbursable Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a recurring reimbursable — a work dinner — a one-tap control on the transaction row, by letting the household pin the claims it uses constantly.

**Architecture:** One boolean column on `reimbursement_claims`. A pure helper decides what the row control shows; the control then calls the splits API that already exists. No money math changes, no new API route, no RLS change.

**Tech Stack:** Next.js 16.2.10 App Router, TypeScript, Supabase (Postgres + RLS), Vitest 4, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-07-reimbursable-fast-path-design.md` — read it before starting.

**Branch:** `feat/reimbursable-fast-path`, stacked on `spec/reimbursable-transactions` (PR #40, not yet merged).

## Global Constraints

- **Plaid sign convention:** `amount > 0` is money OUT, `amount < 0` is money IN.
- **This feature changes no money math.** Every number in the app must be identical for a household with nothing pinned. `lib/reimbursements.ts`, `lib/budget.ts`, `lib/dashboard.ts` and `lib/spend-context.ts` must not be modified.
- **Do NOT touch `memberships`.** An earlier draft put a per-user default there; it was rejected. That table is read by `private.household_ids()`, which gates every RLS policy in the app.
- **Do NOT add `plaid_env` scoping** (open bug #23 — new queries match the existing reads exactly).
- **Household scoping is via RLS**, not manual `.eq('household_id')` filters, matching every user-session route in this repo.
- **Migrations are applied by hand** in the Supabase SQL editor; there is no runner. Files must be idempotent.
- **Tests:** Vitest, `tests/unit/**/*.test.ts`, run with `npx vitest run`. Import via the `@/` alias.
- **Accessibility:** this repo fixed missing labels in #10. Every interactive element needs an accessible name.
- The suite is currently **158 tests** and must stay green.

---

### Task 1: Add the `pinned` column

**Files:**
- Create: `db/migrations/013_pin_claims.sql`

**Interfaces:**
- Consumes: `reimbursement_claims` from `012_reimbursements.sql`.
- Produces: `reimbursement_claims.pinned boolean not null default false`.

- [ ] **Step 1: Write the migration**

```sql
-- Phase 8: pin the claims a household reimburses against constantly (work dinners), so a recurring
-- reimbursable is one tap on the transaction row instead of a five-field form.
--
-- Pinning lives on the CLAIM, not on a member: both partners tag each other's expenses, so whose
-- expense it is is a property of the transaction, not of whoever happens to be signed in. A per-user
-- default would silently file one partner's lunch under the other's employer.
alter table reimbursement_claims
  add column if not exists pinned boolean not null default false;

-- Partial index: the fast path only ever asks for pinned claims, and there will be very few.
create index if not exists reimbursement_claims_pinned_idx
  on reimbursement_claims (household_id) where pinned;
```

No RLS change is needed: `reimbursement_claims` already carries a `for all` policy scoped to the household, which covers reading and updating the new column.

- [ ] **Step 2: Verify the SQL is well-formed**

Compare against `db/migrations/012_reimbursements.sql` for conventions. Confirm it is idempotent (`if not exists` on both statements) and that it references only the existing `reimbursement_claims` table.

**You cannot apply this migration** — there is no database access in this environment and no migration runner in this repo. Do not attempt it, do not invent credentials. Report it as deferred-to-human.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/013_pin_claims.sql
git commit -m "feat(db): pin claims for the reimbursable fast path"
```

---

### Task 2: The fast-path state helper

**Files:**
- Create: `lib/fast-path.ts`
- Test: `tests/unit/fast-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PinnedClaim = { id: string; name: string; written_off_on: string | null }`
  - `type FastPathSplit = { id: string; claim_id: string; amount: number }`
  - `type FastPathEntry = { claimId: string; claimName: string; applied: boolean; splitId: string | null; amount: number }`
  - `type FastPathState = { show: boolean; remaining: number; entries: FastPathEntry[] }`
  - `fastPathState(txn: { amount: number }, splits: FastPathSplit[], pinned: PinnedClaim[]): FastPathState`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/fast-path.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fastPathState, type PinnedClaim, type FastPathSplit } from '@/lib/fast-path'

const claim = (id: string, name: string, written_off_on: string | null = null): PinnedClaim => ({
  id,
  name,
  written_off_on,
})
const split = (id: string, claim_id: string, amount: number): FastPathSplit => ({
  id,
  claim_id,
  amount,
})

const acme = claim('c-acme', "Dan's work")
const globex = claim('c-globex', "Sarah's work")

describe('fastPathState', () => {
  it('offers the full amount on an untouched outflow', () => {
    const r = fastPathState({ amount: 78 }, [], [acme])
    expect(r.show).toBe(true)
    expect(r.remaining).toBeCloseTo(78)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      claimId: 'c-acme',
      claimName: "Dan's work",
      applied: false,
      splitId: null,
    })
    expect(r.entries[0].amount).toBeCloseTo(78)
  })

  // The control assigns what is LEFT, not the transaction total — so it composes with the split
  // editor and can never fail the API's cross-row check by exceeding the transaction.
  it('offers only the unsplit remainder on a partly split transaction', () => {
    const r = fastPathState({ amount: 78 }, [split('s1', 'c-friend', 30)], [acme])
    expect(r.remaining).toBeCloseTo(48)
    expect(r.entries[0].amount).toBeCloseTo(48)
    expect(r.entries[0].applied).toBe(false)
  })

  it('shows an applied claim as undoable and offers nothing more', () => {
    const r = fastPathState({ amount: 78 }, [split('s1', 'c-acme', 78)], [acme])
    expect(r.show).toBe(true)
    expect(r.remaining).toBe(0)
    expect(r.entries[0]).toMatchObject({ applied: true, splitId: 's1' })
    expect(r.entries[0].amount).toBe(0)
  })

  // Nothing to add and nothing to undo — rendering a control here would only ever error.
  it('hides entirely when fully split to claims that are not pinned', () => {
    const r = fastPathState({ amount: 78 }, [split('s1', 'c-friend', 78)], [acme])
    expect(r.show).toBe(false)
  })

  it('hides when nothing is pinned', () => {
    expect(fastPathState({ amount: 78 }, [], []).show).toBe(false)
  })

  // A repayment is not reimbursable; it gets tagged through the split editor instead.
  it('hides on an inflow', () => {
    expect(fastPathState({ amount: -250 }, [], [acme]).show).toBe(false)
  })

  it('hides on a zero-amount transaction', () => {
    expect(fastPathState({ amount: 0 }, [], [acme]).show).toBe(false)
  })

  // The splits API refuses a written-off claim, so offering one would be an action the server rejects.
  it('drops written-off claims from the offered set', () => {
    const r = fastPathState({ amount: 78 }, [], [acme, claim('c-old', 'Old job', '2026-07-01')])
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].claimId).toBe('c-acme')
  })

  it('offers every pinned claim when several are pinned', () => {
    const r = fastPathState({ amount: 78 }, [], [acme, globex])
    expect(r.entries.map((e) => e.claimId)).toEqual(['c-acme', 'c-globex'])
    expect(r.entries.every((e) => e.amount === 78)).toBe(true)
  })

  it('mixes applied and offerable entries when several are pinned', () => {
    const r = fastPathState({ amount: 100 }, [split('s1', 'c-acme', 40)], [acme, globex])
    expect(r.entries[0]).toMatchObject({ claimId: 'c-acme', applied: true, splitId: 's1' })
    expect(r.entries[1]).toMatchObject({ claimId: 'c-globex', applied: false })
    expect(r.entries[1].amount).toBeCloseTo(60)
  })

  it('never offers a negative amount even if splits somehow exceed the transaction', () => {
    const r = fastPathState({ amount: 50 }, [split('s1', 'c-friend', 999)], [acme])
    expect(r.remaining).toBe(0)
    expect(r.show).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/fast-path.test.ts`
Expected: FAIL — cannot resolve `@/lib/fast-path`.

- [ ] **Step 3: Write the implementation**

Create `lib/fast-path.ts`:

```ts
// The reimbursable fast path: a household pins the claims it reimburses against constantly (a work
// dinner), and the transaction row offers them in one tap. This module decides ONLY what the control
// should show — creating and deleting the splits is the existing splits API's job.

export type PinnedClaim = {
  id: string
  name: string
  written_off_on: string | null
}

export type FastPathSplit = {
  id: string
  claim_id: string
  amount: number
}

export type FastPathEntry = {
  claimId: string
  claimName: string
  applied: boolean // this claim already has a split on this transaction
  splitId: string | null // the split to remove when applied
  amount: number // what tapping would assign; 0 when already applied
}

export type FastPathState = {
  show: boolean
  remaining: number // the transaction's unsplit remainder
  entries: FastPathEntry[]
}

const HIDDEN: FastPathState = { show: false, remaining: 0, entries: [] }

export function fastPathState(
  txn: { amount: number },
  splits: FastPathSplit[],
  pinned: PinnedClaim[]
): FastPathState {
  // Plaid: amount > 0 is money OUT. A repayment isn't reimbursable — it gets tagged through the
  // split editor, which knows how to apply it against a claim's outstanding.
  if (!(txn.amount > 0)) return HIDDEN

  const assigned = splits.reduce((s, x) => s + x.amount, 0)
  // Clamped so a transaction somehow over-split can never offer a negative amount.
  const remaining = Math.max(0, txn.amount - assigned)

  // A written-off claim is refused by the splits API, so offering it would be an action the server
  // rejects. Drop it rather than render a button that only errors.
  const entries: FastPathEntry[] = pinned
    .filter((c) => c.written_off_on === null)
    .map((c) => {
      const existing = splits.find((s) => s.claim_id === c.id)
      return {
        claimId: c.id,
        claimName: c.name,
        applied: !!existing,
        splitId: existing?.id ?? null,
        amount: existing ? 0 : remaining,
      }
    })

  // Show only if there's something to do: an applied claim to undo, or room left to assign.
  // Fully split to claims that aren't pinned leaves neither, so the control disappears entirely.
  const show = entries.some((e) => e.applied) || (remaining > 0 && entries.length > 0)
  return show ? { show, remaining, entries } : HIDDEN
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/fast-path.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/fast-path.ts tests/unit/fast-path.test.ts
git commit -m "feat: fast-path state helper for pinned reimbursement claims"
```

---

### Task 3: Let the claims API pin and unpin

**Files:**
- Modify: `app/api/reimbursements/claims/route.ts` — `GET` (return `pinned`), `PATCH` (accept `pinned`), `writeOff()` (unpin)

**Interfaces:**
- Consumes: the existing claims route.
- Produces: `PATCH { id, name?, pinned? }` — each field applied only when present. `GET` includes `pinned` on each claim.

- [ ] **Step 1: Widen `PATCH` to accept `pinned`**

Replace the `PATCH` handler (currently at `app/api/reimbursements/claims/route.ts:176-191`) with:

```ts
// Rename and/or pin. Both are independent optional fields so the two operations share one route
// without either becoming mandatory — the pin toggle sends only `pinned`, the rename only `name`.
export async function PATCH(req: Request) {
  const { id, name, pinned } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const patch: { name?: string; pinned?: boolean } = {}
  if (name !== undefined) {
    const clean = String(name).trim()
    if (!clean) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    patch.name = clean
  }
  if (pinned !== undefined) patch.pinned = !!pinned
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // A written-off claim is closed for good and the splits API refuses to file against it, so
  // pinning one would surface an action the server rejects on every tap.
  if (patch.pinned) {
    const { data: claim } = await supabase
      .from('reimbursement_claims')
      .select('written_off_on')
      .eq('id', id)
      .maybeSingle()
    if (!claim) return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (claim.written_off_on) {
      return NextResponse.json({ error: 'a written-off claim cannot be pinned' }, { status: 400 })
    }
  }

  const { error } = await supabase.from('reimbursement_claims').update(patch).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Unpin when a claim is written off**

In `writeOff()`, the final update currently sets only `written_off_on`. Change that one `.update({...})` call to also clear the pin:

```ts
  const { error: markError } = await supabase
    .from('reimbursement_claims')
    // Unpin as part of writing off: the splits API refuses a written-off claim, so leaving it pinned
    // would keep offering a fast-path action that fails on every tap.
    .update({ written_off_on: date, pinned: false })
    .eq('id', id)
```

Read the current file to find the exact call rather than trusting a line number.

- [ ] **Step 3: Return `pinned` from `GET`**

In `GET`, the claims select currently reads `'id, name, written_off_on'`. Add the column:

```ts
    .select('id, name, written_off_on, pinned')
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run lint && npx vitest run && npm run build
```

Expected: all clean, 169 tests (158 existing plus Task 2's 11).

The database migration from Task 1 has NOT been applied, so you cannot exercise these endpoints live. Do not start a dev server. Static verification only.

- [ ] **Step 5: Commit**

```bash
git add app/api/reimbursements/claims/route.ts
git commit -m "feat: pin and unpin claims through the claims API"
```

---

### Task 4: The row control

**Files:**
- Create: `components/ReimbursableButton.tsx`
- Modify: `components/TransactionRow.tsx`
- Modify: `app/(app)/transactions/page.tsx`

**Interfaces:**
- Consumes: `fastPathState`, `type PinnedClaim`, `type FastPathSplit` from `lib/fast-path` (Task 2); `POST`/`DELETE` on `/api/reimbursements/splits`.
- Produces: `<ReimbursableButton transactionId amount splits pinned />`. `TransactionRow` gains a `pinned: PinnedClaim[]` prop.

- [ ] **Step 1: Write the component**

Create `components/ReimbursableButton.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { fastPathState, type FastPathEntry, type FastPathSplit, type PinnedClaim } from '@/lib/fast-path'

export function ReimbursableButton({
  transactionId,
  amount,
  splits,
  pinned,
  label,
}: {
  transactionId: string
  amount: number
  splits: FastPathSplit[]
  pinned: PinnedClaim[]
  label: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const state = fastPathState({ amount }, splits, pinned)
  if (!state.show) return null

  async function apply(entry: FastPathEntry) {
    setBusy(true)
    setError(null)
    try {
      // Applied entries undo; the rest assign whatever is still unsplit.
      const res = entry.applied
        ? await fetch('/api/reimbursements/splits', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: entry.splitId }),
          })
        : await fetch('/api/reimbursements/splits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              transactionId,
              claimId: entry.claimId,
              owedBy: null,
              amount: entry.amount,
            }),
          })
      if (!res.ok) {
        // The splits API's 400s are written to be read by a user (a claim written off in another
        // tab, a delete that would orphan a repayment). Surface them rather than a generic message.
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'That could not be saved.')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const linkClass = 'text-xs font-medium text-emerald hover:text-emerald-600 disabled:opacity-50'

  return (
    <div className="flex flex-col items-end gap-1">
      {state.entries.length === 1 ? (
        <button
          type="button"
          onClick={() => apply(state.entries[0])}
          disabled={busy}
          aria-label={
            state.entries[0].applied
              ? `Remove ${state.entries[0].claimName} from ${label}`
              : `Mark ${label} reimbursable to ${state.entries[0].claimName}`
          }
          className={linkClass}
        >
          {state.entries[0].applied
            ? `Reimbursable ✓`
            : `Reimbursable · ${state.entries[0].claimName}`}
        </button>
      ) : (
        // A native disclosure rather than a positioned popover: it works inside a table cell with no
        // layout maths, and is keyboard-accessible for free.
        <details className="text-right">
          <summary className={`${linkClass} cursor-pointer list-none`}>Reimbursable ▾</summary>
          <div className="mt-1 flex flex-col items-end gap-1">
            {state.entries.map((e) => (
              <button
                key={e.claimId}
                type="button"
                onClick={() => apply(e)}
                disabled={busy}
                aria-label={
                  e.applied
                    ? `Remove ${e.claimName} from ${label}`
                    : `Mark ${label} reimbursable to ${e.claimName}`
                }
                className={linkClass}
              >
                {e.applied ? `${e.claimName} ✓` : e.claimName}
              </button>
            ))}
          </div>
        </details>
      )}
      {error && (
        <span role="alert" className="text-xs text-rose-600">
          {error}
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Render it in the row**

In `components/TransactionRow.tsx`, add the import and the `pinned` prop, then render the control in the existing trailing cell above the Split button. Read the file first — the trailing `<td>` currently contains only the Split toggle.

Add to the imports:

```tsx
import { ReimbursableButton } from './ReimbursableButton'
import type { PinnedClaim } from '@/lib/fast-path'
```

Add `pinned: PinnedClaim[]` to both the destructured params and the prop type. Then, inside the final `<td>`, render the control above the existing Split button, wrapping the two in a column:

```tsx
        <td className="px-4 py-3 text-right">
          <div className="flex flex-col items-end gap-1">
            <ReimbursableButton
              transactionId={t.id}
              amount={t.amount}
              splits={splits}
              pinned={pinned}
              label={label ?? 'transaction'}
            />
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={`Split ${label ?? 'transaction'}`}
              className="text-xs font-medium text-emerald hover:text-emerald-600"
            >
              {assigned > 0 ? 'Splits' : 'Split'}
            </button>
          </div>
        </td>
```

`splits` already has `id`, `claim_id` and `amount`, which satisfies `FastPathSplit` structurally — no mapping needed.

- [ ] **Step 3: Pass the pinned claims from the page**

In `app/(app)/transactions/page.tsx`, the claims query currently selects `'id, name'` and filters `.is('written_off_on', null)`. The control needs `written_off_on` and `pinned`. Change that query to select all four columns, keep the existing `claims` value (`{ id, name }[]`) for `SplitEditor` by mapping it down, and derive the pinned list:

```tsx
  const { data: claimRows } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on, pinned')
    .is('written_off_on', null)
    .order('created_at', { ascending: false })
  const claims = (claimRows ?? []).map((c) => ({ id: c.id as string, name: c.name as string }))
  const pinned = (claimRows ?? [])
    .filter((c) => c.pinned)
    .map((c) => ({
      id: c.id as string,
      name: c.name as string,
      written_off_on: c.written_off_on as string | null,
    }))
```

Then pass `pinned={pinned}` at the `TransactionRow` call alongside the existing props.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run lint && npx vitest run && npm run build
```

Expected: all clean, 169 tests.

Do not start a dev server — the Task 1 migration has not been applied, so `pinned` does not exist in the database yet and the page would error. Static verification only; the manual check is deferred-to-human.

- [ ] **Step 5: Commit**

```bash
git add components/ReimbursableButton.tsx components/TransactionRow.tsx "app/(app)/transactions/page.tsx"
git commit -m "feat: one-tap reimbursable control on the transaction row"
```

---

### Task 5: The pin toggle

**Files:**
- Modify: `components/ClaimList.tsx`
- Modify: `app/(app)/reimbursements/page.tsx`

**Interfaces:**
- Consumes: `PATCH { id, pinned }` from Task 3.
- Produces: `ClaimRow` gains `pinned: boolean`.

- [ ] **Step 1: Carry `pinned` through the page**

In `app/(app)/reimbursements/page.tsx`, two spots change. First the claims query:

```tsx
  const { data: claimRows } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on, pinned')
    .order('created_at', { ascending: false })
```

Then the `.map(...)` that builds each `ClaimRow` — it currently spreads the claim and adds `totals` and `oldestUnpaidDays`. Add `pinned` explicitly so the row's type is satisfied even though the spread already carries the value:

```tsx
    return { ...c, pinned: !!c.pinned, totals, oldestUnpaidDays }
```

Read the file to confirm the exact shape of that `.map(...)` before editing — do not assume line numbers.

- [ ] **Step 2: Add the toggle to `ClaimList`**

In `components/ClaimList.tsx`, add `pinned: boolean` to the exported `ClaimRow` type. Then add a toggle beside the existing Write off / Delete buttons. `ClaimList` already has `busy`, `error` and `router` — reuse them rather than adding new state:

```tsx
  async function togglePin(claim: ClaimRow) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reimbursements/claims', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: claim.id, pinned: !claim.pinned }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'That could not be saved.')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }
```

In the per-claim action row, add this before the existing buttons. Written-off claims get no toggle, because the server refuses to pin them:

```tsx
              {!c.totals.writtenOff && (
                <Button type="button" variant="secondary" disabled={busy} onClick={() => togglePin(c)}>
                  {c.pinned ? 'Unpin' : 'Pin for one-tap'}
                </Button>
              )}
```

- [ ] **Step 3: Explain the pin in the page's empty and header copy**

Pinning is only discoverable here, so the page should say what it does. In `app/(app)/reimbursements/page.tsx`, extend the `PageHeader` subtitle when nothing is pinned yet:

```tsx
        subtitle={
          outstanding > 0
            ? `You're owed ${money(outstanding)}.`
            : 'Money other people owe you, and what has come back.'
        }
```

becomes:

```tsx
        subtitle={
          outstanding > 0
            ? `You're owed ${money(outstanding)}. Pin a claim to mark expenses reimbursable in one tap.`
            : 'Money other people owe you, and what has come back. Pin a claim to mark expenses reimbursable in one tap.'
        }
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run lint && npx vitest run && npm run build
```

Expected: all clean, 169 tests.

- [ ] **Step 5: Commit**

```bash
git add components/ClaimList.tsx "app/(app)/reimbursements/page.tsx"
git commit -m "feat: pin a claim from the reimbursements page"
```

---

## Final verification

- [ ] Full gate, matching CI:

```bash
npx tsc --noEmit && npm run lint && npx vitest run && npm run check:secrets && npm run build
```

- [ ] **Deferred to the human partner** (no database access in the build environment): apply `db/migrations/013_pin_claims.sql`, then walk the flow — pin a claim on `/reimbursements`, confirm `Reimbursable · <name>` appears on outflow rows, tap it and confirm the row's "your share" drops to zero and `/budgets` reflects it, then tap again to undo.

- [ ] Confirm the control does NOT appear on an inflow row, and does not appear on a row already split entirely to unpinned claims.

- [ ] Confirm nothing pinned means nothing changes: with zero pinned claims, the transactions page must look exactly as it did before this feature.
