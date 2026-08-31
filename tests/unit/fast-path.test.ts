import { describe, it, expect } from 'vitest'
import {
  fastPathState,
  DEFAULT_CLAIM_NAME,
  nextFreeClaimName,
  type PinnedClaim,
  type FastPathSplit,
} from '@/lib/fast-path'

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
// An ordinary transaction: the card-payment fields are what fastPathState reads to recognise the one
// kind of row the splits API refuses, and every case below is a normal row unless it says otherwise.
const txn = (amount: number) => ({ amount, pfc_detailed: null, user_category: null })

const acme = claim('c-acme', "Dan's work")
const globex = claim('c-globex', "Sarah's work")

describe('fastPathState', () => {
  it('offers the full amount on an untouched outflow', () => {
    const r = fastPathState(txn(78), [], [acme])
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
    const r = fastPathState(txn(78), [split('s1', 'c-friend', 30)], [acme])
    expect(r.remaining).toBeCloseTo(48)
    expect(r.entries[0].amount).toBeCloseTo(48)
    expect(r.entries[0].applied).toBe(false)
  })

  it('shows an applied claim as undoable and offers nothing more', () => {
    const r = fastPathState(txn(78), [split('s1', 'c-acme', 78)], [acme])
    expect(r.show).toBe(true)
    expect(r.remaining).toBe(0)
    expect(r.entries[0]).toMatchObject({ applied: true, splitId: 's1' })
    expect(r.entries[0].amount).toBe(0)
  })

  // Nothing to add and nothing to undo — rendering a control here would only ever error.
  it('hides entirely when fully split to claims that are not pinned', () => {
    const r = fastPathState(txn(78), [split('s1', 'c-friend', 78)], [acme])
    expect(r.show).toBe(false)
  })

  // Was 'hides when nothing is pinned'. It no longer does, and that reversal IS the feature: making
  // a transaction reimbursable must not require inventing a claim first. The default-entry case is
  // covered in full by the 'with nothing pinned' block at the bottom of this file.
  it('offers the default claim when nothing is pinned instead of hiding', () => {
    expect(fastPathState(txn(78), [], []).show).toBe(true)
  })

  // A repayment is not reimbursable; it gets tagged through the split editor instead. This must be a
  // repayment that ALREADY carries a split against a pinned claim (a normal state reachable through
  // the split editor) — with no splits, remaining clamps to 0 and show comes out false through the
  // arithmetic alone, which would pass even if the inflow guard were deleted. With the split present,
  // removing the guard would render `Reimbursable ✓` on this row and let a tap delete the repayment's
  // split.
  it('hides on an inflow even when it already carries a split against a pinned claim', () => {
    const r = fastPathState(txn(-250), [split('s9', 'c-acme', 250)], [acme])
    expect(r.show).toBe(false)
  })

  it('hides on a zero-amount transaction', () => {
    expect(fastPathState(txn(0), [], [acme]).show).toBe(false)
  })

  // The splits API refuses a written-off claim, so offering one would be an action the server rejects.
  it('drops written-off claims from the offered set', () => {
    const r = fastPathState(txn(78), [], [acme, claim('c-old', 'Old job', '2026-07-01')])
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].claimId).toBe('c-acme')
  })

  it('offers every pinned claim when several are pinned', () => {
    const r = fastPathState(txn(78), [], [acme, globex])
    expect(r.entries.map((e) => e.claimId)).toEqual(['c-acme', 'c-globex'])
    expect(r.entries.every((e) => e.amount === 78)).toBe(true)
  })

  it('mixes applied and offerable entries when several are pinned', () => {
    const r = fastPathState(txn(100), [split('s1', 'c-acme', 40)], [acme, globex])
    expect(r.entries[0]).toMatchObject({ claimId: 'c-acme', applied: true, splitId: 's1' })
    expect(r.entries[1]).toMatchObject({ claimId: 'c-globex', applied: false })
    expect(r.entries[1].amount).toBeCloseTo(60)
  })

  it('never offers a negative amount even if splits somehow exceed the transaction', () => {
    const r = fastPathState(txn(50), [split('s1', 'c-friend', 999)], [acme])
    expect(r.remaining).toBe(0)
    expect(r.show).toBe(false)
  })

  // §8: "remainder is zero; the control renders that claim's ✓ entry so it can be undone, and offers
  // nothing to add." A second pinned claim with nothing left to assign must not appear as a dead,
  // always-400 entry alongside it.
  it('offers only the applied entry when a second pinned claim has no remainder left to assign', () => {
    const r = fastPathState(txn(78), [split('s1', 'c-acme', 78)], [acme, globex])
    expect(r.show).toBe(true)
    expect(r.remaining).toBe(0)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ claimId: 'c-acme', applied: true, splitId: 's1' })
  })

  // THE MULTI-SPLIT CASE. One claim, several splits on one transaction, is the shape the person axis
  // exists for: Dave/Sam/Priya each $250 of a $1,000 rental under "Bourbon trail trip". The fast path
  // cannot ask which of them a tap meant, so it must never offer to remove one — the old
  // `splits.find(...)` picked Dave by array order and deleted his share, then still rendered "✓",
  // inviting a second tap that took Sam.
  describe('a claim with several splits on one transaction', () => {
    const dave = split('s-dave', 'c-acme', 250)
    const sam = split('s-sam', 'c-acme', 250)
    const priya = split('s-priya', 'c-acme', 250)

    it('offers no one-tap undo, and steps aside when there is nothing left to assign', () => {
      // Fully covered: 4 x 250 = 1000. No safe action exists, so the control disappears and the row's
      // "Splits" affordance (the editor) is the only way in.
      const fourth = split('s-me', 'c-acme', 250)
      const r = fastPathState(txn(1000), [dave, sam, priya, fourth], [acme])
      expect(r.show).toBe(false)
      expect(r.entries).toHaveLength(0)
    })

    it('offers the unassigned remainder as an ADD, never as a done ✓, while money is left', () => {
      const r = fastPathState(txn(1000), [dave, sam, priya], [acme])
      expect(r.show).toBe(true)
      expect(r.remaining).toBeCloseTo(250)
      expect(r.entries).toHaveLength(1)
      const e = r.entries[0]
      // Applied (the claim IS on this transaction) but the action is to assign, not to undo — this
      // pairing is exactly what stops the row rendering as a finished "✓" with $250 unassigned.
      expect(e).toMatchObject({ claimId: 'c-acme', applied: true, splitCount: 3, action: 'assign' })
      // No split id means no delete can be issued from here, whatever the UI does with the entry.
      expect(e.splitId).toBeNull()
      expect(e.amount).toBeCloseTo(250)
    })

    it('never names one of the splits, whatever order they arrive in', () => {
      const orders = [
        [dave, sam, priya],
        [priya, dave, sam],
        [sam, priya, dave],
      ]
      for (const splits of orders) {
        const r = fastPathState(txn(1000), splits, [acme])
        expect(r.entries[0].splitId).toBeNull()
        expect(r.entries[0].action).toBe('assign')
      }
    })

    // The multi-split claim must not poison the other pinned claims on the same row: one of them can
    // still legitimately take the remainder in one tap.
    it('still offers a different pinned claim the remainder', () => {
      const r = fastPathState(txn(1000), [dave, sam, priya], [acme, globex])
      expect(r.entries.map((e) => e.claimId)).toEqual(['c-acme', 'c-globex'])
      expect(r.entries[1]).toMatchObject({ claimId: 'c-globex', applied: false, action: 'assign' })
      expect(r.entries[1].amount).toBeCloseTo(250)
    })
  })

  // Wave 1 made the splits API refuse a split on a credit-card payment: the payment is already
  // excluded from spending and income, so splitting it reduces nothing while a later write-off would
  // freeze its full amount as invented spending. The control must not offer what the server answers
  // with a 400.
  it('hides on a credit-card payment', () => {
    const cardPayment = {
      amount: 900,
      pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      user_category: null,
    }
    expect(fastPathState(cardPayment, [], [acme]).show).toBe(false)
  })

  // isCreditCardPayment's existing contract: a user override wins. Once they have deliberately
  // recategorized the row, the API accepts a split on it, so the control offers it again.
  it('offers again on a card payment the user has recategorized', () => {
    const r = fastPathState(
      { amount: 900, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: 'Travel' },
      [],
      [acme]
    )
    expect(r.show).toBe(true)
    expect(r.entries[0].amount).toBeCloseTo(900)
  })
})

// The on-ramp. Marking something reimbursable must not require first inventing and pinning a claim:
// with nothing pinned the control still offers itself, and the claim is created on the first tap.
// `claimId: null` is what tells the caller "create the default claim, then assign to it".
describe('fastPathState with nothing pinned', () => {
  it('offers a default entry on an untouched outflow', () => {
    const r = fastPathState(txn(78), [], [])
    expect(r.show).toBe(true)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      claimId: null,
      claimName: DEFAULT_CLAIM_NAME,
      applied: false,
      action: 'assign',
      splitId: null,
    })
    expect(r.entries[0].amount).toBeCloseTo(78)
  })

  it('offers only the unsplit remainder', () => {
    const r = fastPathState(txn(78), [split('s1', 'c-friend', 30)], [])
    expect(r.entries[0].amount).toBeCloseTo(48)
  })

  // The existing guards are not weakened by the default entry: each of these is a row the splits API
  // would refuse, so offering a one-tap control would only ever produce an error.
  it('stays hidden on a credit-card payment', () => {
    const cardPayment = { amount: 300, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: null }
    expect(fastPathState(cardPayment, [], []).show).toBe(false)
  })

  it('stays hidden on an inflow', () => {
    expect(fastPathState(txn(-260), [], []).show).toBe(false)
  })

  it('stays hidden when the transaction is already fully split', () => {
    expect(fastPathState(txn(78), [split('s1', 'c-friend', 78)], []).show).toBe(false)
  })

  // A pinned claim is a deliberate choice; it wins over the generic default rather than being
  // shown alongside it.
  it('defers to pinned claims when there are any', () => {
    const r = fastPathState(txn(78), [], [acme])
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].claimId).toBe('c-acme')
  })
})

// Writing a claim off FREEZES it — the row survives as a record of spending that already counted, and
// `unique (household_id, name)` means its name is consumed forever. Without this, writing off "Work"
// would permanently brick the one-tap control: every later tap would try to create a name that can
// never be created again, and there would be no way back except the split editor.
describe('nextFreeClaimName', () => {
  it('takes the plain name when nothing has claimed it', () => {
    expect(nextFreeClaimName('Work', [])).toBe('Work')
    expect(nextFreeClaimName('Work', ['Bourbon trail'])).toBe('Work')
  })

  it('steps past a name that is already taken', () => {
    expect(nextFreeClaimName('Work', ['Work'])).toBe('Work (2)')
    expect(nextFreeClaimName('Work', ['Work', 'Work (2)'])).toBe('Work (3)')
  })

  it('fills a gap rather than always counting to the end', () => {
    expect(nextFreeClaimName('Work', ['Work', 'Work (3)'])).toBe('Work (2)')
  })

  // Names are compared the way the unique constraint sees them, not the way they were typed.
  it('ignores case and surrounding whitespace when deciding what is taken', () => {
    expect(nextFreeClaimName('Work', ['  work  '])).toBe('Work (2)')
  })
})
