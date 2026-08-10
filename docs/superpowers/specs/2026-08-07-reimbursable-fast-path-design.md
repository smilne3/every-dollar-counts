# Reimbursable Fast Path — Design Spec

- **Repo:** `smilne3/every-dollar-counts`
- **Date:** 2026-08-07
- **Follows:** #27 (reimbursable transactions, PR #40)
- **Status:** Approved design, ready for implementation plan
- **One line:** Give a recurring reimbursable — a work dinner — a one-tap control on the transaction row, by letting a household pin the claims it uses constantly, while the split editor keeps handling the cases where who-and-how-much actually varies.

---

## 1. Purpose

UAT on PR #40 surfaced the gap. Marking a fully-reimbursable work dinner costs **five actions, three of them typing**: click Split, type a claim name, type a person, type the amount, click Add.

That effort is justified for a vacation rental split three ways, where every field carries a real decision. It is not justified for a work dinner, where all three fields are the same every single time and the only information being expressed is *"work pays for all of this."*

**Success looks like:** a recurring reimbursable takes one tap from the transactions list, and the transaction's contribution to spending drops to zero without a form.

## 2. What's already in place (shrinks the job to almost nothing)

The data model built for #27 needs no new concepts. "100% reimbursable to Acme" is simply a split whose amount equals the transaction's unsplit remainder — `spendableAmount` already reduces that to zero. So this feature is one boolean column plus UI over an API that already exists and already validates.

- `POST /api/reimbursements/splits` already creates a split, validates the cross-row sum, and refuses written-off claims.
- `DELETE` on the same route already guards written-off claims and orphaned repayments.
- `reimbursement_claims` already carries a household-scoped `for all` RLS policy.
- The Reimbursements page already lists every claim — the natural home for a pin toggle.

## 3. Key decision: pinning lives on the claim, not the person

The first draft of this design put a `default_claim_id` on `memberships`, so the fast path would resolve to whichever employer belonged to the signed-in user.

**That was wrong**, and the reason is a fact about the household rather than the code: both partners tag each other's expenses. One does most of the tracking and will sit down and tag the week — his client dinners *and* her conference lunch, all while signed in as himself. A per-user default would file her lunch under his employer, silently and every time.

Whose expense it is turns out to be a property of **the transaction**, not of whoever is doing the tagging. So the fast path must let the tagger say whose, and the thing worth remembering is *which claims this household uses constantly* — a household-level fact.

**This also removed the design's only risky change.** The per-user version required a new UPDATE policy on `memberships`, which is the table `private.household_ids()` reads — the helper that gates every other RLS policy in the app. Pinning on the claim needs no policy change at all, because claims are already fully writable by household members.

## 4. Data model

```sql
alter table reimbursement_claims
  add column if not exists pinned boolean not null default false;
```

That is the entire schema change. No new table, no new policy, no change to `memberships`.

## 5. The control

Rendered on the transaction row beside the existing **Split** link, and driven by how many claims are pinned:

| Pinned claims | Row shows | Tap does |
| --- | --- | --- |
| 0 | nothing (Split only) | — |
| 1 | `Reimbursable · <claim name>` | files it in one tap |
| 2+ | `Reimbursable ▾` | opens a short list of the pinned claims |

**The amount assigned is the transaction's unsplit remainder**, not its full amount. Two consequences, both wanted: the control works on a partly-split transaction (tag $30 to a friend, then hit Reimbursable for the other $48), and it can never fail validation by exceeding the transaction total.

**Undo is the same control.** When a pinned claim already has a split on this row, its entry shows a ✓ and tapping removes that split.

**Outflows only.** A repayment is not reimbursable, so the control does not render when the amount is money in (Plaid: `amount < 0`). The split editor remains available on those rows for tagging repayments, which is what they actually need.

**Errors surface verbatim.** The splits API returns messages written to be read by a user — a written-off claim, a sum that would exceed the transaction. The control shows them rather than a generic failure, matching how `SplitEditor` already behaves.

## 6. Pinning

A pin toggle per claim on the Reimbursements page. It already lists every claim, so this adds no new screen and no settings section.

- A written-off claim cannot be pinned, and writing off a pinned claim unpins it — the splits API refuses to file against a written-off claim, so leaving it pinned would offer an action the server rejects.
- Pinning is household-wide by construction: both partners see the same pinned set, which is the point.
- No cap on how many can be pinned. Realistically a household has two or three; a long list is self-correcting, since the menu becomes annoying and they unpin.

## 7. Components

**Create:**
- `db/migrations/013_pin_claims.sql` — the column (§4).
- `lib/fast-path.ts` — one pure function: given a transaction, its splits, and the pinned claims, return what the control should show (which claims to offer, which are already applied, and the amount each would assign). Unit-tested.
- `components/ReimbursableButton.tsx` — the row control. Client component, following `CategoryPicker.tsx`'s pattern.

**Modify:**
- `components/TransactionRow.tsx` — render the control beside Split.
- `app/(app)/transactions/page.tsx` — pass the pinned claims (it already fetches claims and splits).
- `components/ClaimList.tsx` — the pin toggle.
- `app/api/reimbursements/claims/route.ts` — accept `pinned` on PATCH, and unpin on write-off.

`PATCH` currently requires `{ id, name }`. It becomes `{ id, name?, pinned? }` — each field applied only when present, so renaming and pinning stay independent operations against one route rather than two.

## 8. Edge cases

- **No claims pinned** → no control. The Reimbursements page is where you'd discover pinning; the transactions row stays uncluttered until the household opts in.
- **Transaction fully split to a pinned claim** → remainder is zero; the control renders that claim's ✓ entry so it can be undone, and offers nothing to add.
- **Transaction fully split to claims that are *not* pinned** (e.g. the whole rental went to three friends) → remainder is zero and there is nothing to undo through this control either, so **it does not render at all**. Showing a dead or erroring `Reimbursable` on a row with no room left would be an affordance the server would only reject. The split editor still opens on that row and shows every split, which is where an unpinned claim belongs.
- **Pinned claim written off while a row is open** → the tap fails with the API's message rather than silently doing nothing.
- **A pinned claim deleted** → it disappears from the control with the claim; nothing dangles.
- **Two rapid taps** → same known race as the existing split editor (documented, accepted in #27); the button disables while in flight, which covers the realistic double-click.

## 9. Testing

`lib/fast-path.ts` is pure and carries the logic, so it takes the unit tests: zero/one/many pinned claims; a partly-split transaction (the offered amount must be the remainder, not the total); an inflow (no control); a pinned claim already applied (shows as undo); a written-off claim among the pinned set (not offered); and the two fully-split cases from §8, which must come out differently — split to a pinned claim renders an undo entry, split entirely to unpinned claims renders nothing.

The existing suite must stay green — this feature adds a column and a control, and changes no money math, so every number in the app must be unchanged for a household with nothing pinned.

## 10. Out of scope

- Bulk-tagging several transactions at once. It is a different workflow rather than a faster version of this one, and worth building only if it turns out expenses get handled in weekly batches. Cheap to add later on top of this.
- Per-person defaults (§3).
- Any change to the split editor, which remains the path for partial and multi-person cases.
