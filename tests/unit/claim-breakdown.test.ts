import { describe, it, expect } from 'vitest'
import { showsPersonBreakdown } from '@/components/ClaimList'
import { claimTotals, type Claim, type Split } from '@/lib/reimbursements'

const open: Claim = { id: 'c1', name: "Dan's work", written_off_on: null }
const closed: Claim = { id: 'c1', name: "Dan's work", written_off_on: '2026-08-01' }

// The per-person list is display-only, so these build the totals through the real function: the
// point is what the list would render NEXT TO the header those same totals produce.
describe('showsPersonBreakdown', () => {
  // The reported case: pin a claim, tap $500 of dinners with the one-tap control (which never asks
  // who owes — the split carries owed_by null), then tag the employer's repayment "Acme AP". The
  // claim is square, and the old list printed "Unattributed $500.00 outstanding / Acme AP paid"
  // directly under a header reading "Settled".
  it('is hidden for a settled claim whose rows would still read as outstanding', () => {
    const splits: Split[] = [
      { transaction_id: 't-dinner', claim_id: 'c1', owed_by: null, amount: 500 },
      { transaction_id: 't-repaid', claim_id: 'c1', owed_by: 'Acme AP', amount: 500 },
    ]
    const totals = claimTotals(open, splits, { 't-dinner': 500, 't-repaid': -500 })
    expect(totals.settled).toBe(true)
    // The contradiction the rule removes is still present in the data — this is a display rule, and
    // claimTotals is deliberately unchanged.
    expect(totals.byPerson.find((p) => p.owedBy === 'Unattributed')?.outstanding).toBeCloseTo(500)
    expect(showsPersonBreakdown(totals)).toBe(false)
  })

  // Nothing per-person to say: one bucket, and it is the "no person given" bucket, so the row would
  // repeat the claim's own outstanding figure in different words.
  it('is hidden when every split is unattributed', () => {
    const splits: Split[] = [
      { transaction_id: 't1', claim_id: 'c1', owed_by: null, amount: 500 },
      { transaction_id: 't2', claim_id: 'c1', owed_by: '   ', amount: 120 },
    ]
    const totals = claimTotals(open, splits, { t1: 500, t2: 120 })
    expect(totals.settled).toBe(false)
    expect(totals.byPerson).toHaveLength(1)
    expect(showsPersonBreakdown(totals)).toBe(false)
  })

  it('is hidden for a written-off claim', () => {
    const splits: Split[] = [{ transaction_id: 't1', claim_id: 'c1', owed_by: 'Dave', amount: 250 }]
    const totals = claimTotals(closed, splits, { t1: 250 })
    expect(showsPersonBreakdown(totals)).toBe(false)
  })

  // The case the list exists for: money is out, and it can say who to chase.
  it('is shown for an open claim with at least one named person', () => {
    const splits: Split[] = [
      { transaction_id: 't1', claim_id: 'c1', owed_by: 'Dave', amount: 250 },
      { transaction_id: 't1', claim_id: 'c1', owed_by: 'Sam', amount: 250 },
      { transaction_id: 't1', claim_id: 'c1', owed_by: null, amount: 250 },
    ]
    const totals = claimTotals(open, splits, { t1: 1000 })
    expect(showsPersonBreakdown(totals)).toBe(true)
  })

  it('is hidden for a claim with no splits at all', () => {
    expect(showsPersonBreakdown(claimTotals(open, [], {}))).toBe(false)
  })
})
