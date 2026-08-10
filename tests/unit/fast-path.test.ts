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

  // A repayment is not reimbursable; it gets tagged through the split editor instead. This must be a
  // repayment that ALREADY carries a split against a pinned claim (a normal state reachable through
  // the split editor) — with no splits, remaining clamps to 0 and show comes out false through the
  // arithmetic alone, which would pass even if the inflow guard were deleted. With the split present,
  // removing the guard would render `Reimbursable ✓` on this row and let a tap delete the repayment's
  // split.
  it('hides on an inflow even when it already carries a split against a pinned claim', () => {
    const r = fastPathState({ amount: -250 }, [split('s9', 'c-acme', 250)], [acme])
    expect(r.show).toBe(false)
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

  // §8: "remainder is zero; the control renders that claim's ✓ entry so it can be undone, and offers
  // nothing to add." A second pinned claim with nothing left to assign must not appear as a dead,
  // always-400 entry alongside it.
  it('offers only the applied entry when a second pinned claim has no remainder left to assign', () => {
    const r = fastPathState({ amount: 78 }, [split('s1', 'c-acme', 78)], [acme, globex])
    expect(r.show).toBe(true)
    expect(r.remaining).toBe(0)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ claimId: 'c-acme', applied: true, splitId: 's1' })
  })
})
